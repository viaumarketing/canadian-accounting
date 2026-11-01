import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException, UnsupportedMediaTypeException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Prisma } from '@ca/database';
import {
  applyMapping, findTransferPairs, firstMatchingRule, fingerprints, looksLikeOfx, parseCsv, parseOfx, scoreDocument, sha256Hex, suggestMapping, suggestMatches,
  type CsvMapping, type LedgerCandidate, type NormBankTxn, type ParseResult, type RuleConditions, type StatementMeta,
} from '@ca/banking';
import { purchaseJournal, salesJournal, type DocLine } from '@ca/accounting-engine';
import type { TaxLine } from '@ca/canadian-tax';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../accounting/ledger.service';
import { BillingService } from '../billing/billing.service';
import { TaxService } from '../tax/tax.service';
import { isoOf, toDate } from '../accounting/setup';
import { DocumentStore } from '../common/document-store';

type Tx = Prisma.TransactionClient;
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
export const MAX_UPLOAD = 10 * 1024 * 1024;

export interface ParsedUpload { format: 'csv' | 'ofx'; sha256: string; result?: ParseResult; meta: StatementMeta; csv?: { headers: string[]; sample: string[][]; delimiter: string; suggested: ReturnType<typeof suggestMapping> } }

@Injectable()
export class BankingService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly tax: TaxService, private readonly billing: BillingService, private readonly audit: AuditService, private readonly docs: DocumentStore) {}

  // ========================================================================= accounts

  async getAccount(companyId: string, id: string, db: Tx | PrismaService = this.prisma) {
    const a = await db.bankAccount.findFirst({ where: { id, companyId } });
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Bank account not found' });
    return a;
  }

  async listAccounts(companyId: string) {
    const accounts = await this.prisma.bankAccount.findMany({ where: { companyId }, orderBy: { name: 'asc' }, include: { connection: { select: { id: true, provider: true, status: true, lastError: true, lastSyncAt: true, institutionName: true } } } });
    return Promise.all(accounts.map(async (a) => {
      const [unmatched, latest, ledger, lastRec] = await Promise.all([
        this.prisma.bankTransaction.count({ where: { bankAccountId: a.id, status: 'UNMATCHED' } }),
        this.prisma.bankTransaction.findFirst({ where: { bankAccountId: a.id }, orderBy: { date: 'desc' }, select: { date: true } }),
        this.prisma.journalLine.aggregate({ where: { companyId, accountId: a.ledgerAccountId, entry: { status: 'POSTED' } }, _sum: { debit: true, credit: true } }),
        this.prisma.reconciliation.findFirst({ where: { bankAccountId: a.id, status: 'COMPLETED' }, orderBy: { statementDate: 'desc' } }),
      ]);
      return { ...a, health: { unmatched, latestTransaction: latest?.date ?? null, ledgerBalance: D(ledger._sum.debit ?? 0).minus(ledger._sum.credit ?? 0).toFixed(2), lastReconciledThrough: lastRec?.statementDate ?? null } };
    }));
  }

  async createAccount(companyId: string, i: { name: string; kind: 'CHEQUING' | 'SAVINGS' | 'CREDIT_CARD'; institution?: string; mask?: string; ledgerAccountId?: string; newLedgerAccount?: { code: string; name: string } }, actorId: string, ip: string | null) {
    const type = i.kind === 'CREDIT_CARD' ? 'LIABILITY' : 'ASSET';
    let ledgerId = i.ledgerAccountId;
    if (!ledgerId) {
      if (!i.newLedgerAccount) throw new BadRequestException({ code: 'LEDGER_ACCOUNT_REQUIRED', message: 'Pick an existing ledger account or provide a code and name for a new one' });
      ledgerId = (await this.ledger.createAccount(companyId, { ...i.newLedgerAccount, type }, actorId, ip)).id;
    }
    const la = await this.prisma.account.findFirst({ where: { id: ledgerId, companyId, isActive: true } });
    if (!la || la.role || la.type !== type) throw new BadRequestException({ code: 'INVALID_ACCOUNT', message: `A ${i.kind.replace('_', ' ').toLowerCase()} must be backed by an active ${type.toLowerCase()} account that is not a control account` });
    try {
      const a = await this.prisma.bankAccount.create({ data: { companyId, ledgerAccountId: ledgerId, name: i.name, kind: i.kind, institution: i.institution, mask: i.mask } });
      await this.audit.record({ action: 'bank_account.created', companyId, actorId, entityType: 'BankAccount', entityId: a.id, ip });
      return a;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'DUPLICATE', message: 'That ledger account is already linked to a bank account' });
      throw e;
    }
  }

  async updateAccount(companyId: string, id: string, i: { name?: string; isActive?: boolean; institution?: string | null }, actorId: string, ip: string | null) {
    await this.getAccount(companyId, id);
    const a = await this.prisma.bankAccount.update({ where: { id }, data: i });
    await this.audit.record({ action: 'bank_account.updated', companyId, actorId, entityType: 'BankAccount', entityId: id, ip });
    return a;
  }

  // ========================================================================= import

  /** Never trust the preview: both preview and commit parse the bytes themselves. */
  parseUpload(buf: Buffer, filename: string, mapping?: CsvMapping): ParsedUpload {
    if (!buf?.length) throw new BadRequestException({ code: 'EMPTY_FILE', message: 'The file is empty' });
    if (buf.length > MAX_UPLOAD) throw new BadRequestException({ code: 'TOO_LARGE', message: 'Files are limited to 10 MB' });
    if (buf.subarray(0, 5).toString('latin1') === '%PDF-') throw new UnsupportedMediaTypeException({ code: 'PDF_NOT_SUPPORTED', message: 'PDF statements cannot be read reliably. Download the CSV or OFX/QFX version from your bank instead.' });
    if (buf.includes(0)) throw new UnsupportedMediaTypeException({ code: 'BINARY_FILE', message: 'This looks like a binary file. Upload a CSV, OFX or QFX statement.' });
    let text = buf.toString('utf8');
    if (text.includes('�')) text = buf.toString('latin1'); // many Canadian bank exports are Windows-1252
    const sha256 = sha256Hex(buf);
    try {
      if (looksLikeOfx(text)) {
        const r = parseOfx(text);
        return { format: 'ofx', sha256, result: { rows: r.rows, errors: r.errors }, meta: r.meta };
      }
      const { rows, delimiter } = parseCsv(text, mapping?.delimiter);
      if (rows.length < 1) throw new Error('No rows found');
      const header = rows[0];
      const csv = { headers: header, sample: rows.slice(1, 6), delimiter, suggested: suggestMapping(header) };
      return { format: 'csv', sha256, csv, meta: { format: 'csv' }, ...(mapping ? { result: applyMapping(rows, mapping) } : {}) };
    } catch (e) {
      throw new UnprocessableEntityException({ code: 'UNREADABLE_FILE', message: `Could not read this file: ${(e as Error).message}` });
    }
  }

  private async existingFingerprints(bankAccountId: string, fps: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (let i = 0; i < fps.length; i += 5000) {
      const rows = await this.prisma.bankTransaction.findMany({ where: { bankAccountId, fingerprint: { in: fps.slice(i, i + 5000) } }, select: { fingerprint: true } });
      for (const r of rows) out.add(r.fingerprint);
    }
    return out;
  }

  async previewImport(companyId: string, accountId: string, buf: Buffer, filename: string, mapping?: CsvMapping) {
    const account = await this.getAccount(companyId, accountId);
    const p = this.parseUpload(buf, filename, mapping);
    const prior = await this.prisma.bankStatement.findUnique({ where: { bankAccountId_sha256: { bankAccountId: accountId, sha256: p.sha256 } }, select: { id: true, createdAt: true, filename: true } });
    const warnings: string[] = [];
    if (p.meta.accountMask && account.mask && p.meta.accountMask !== account.mask.slice(-4)) warnings.push(`The file is for an account ending ${p.meta.accountMask}, but this bank account ends ${account.mask}.`);
    if (p.meta.accountKind === 'CREDIT_CARD' && account.kind !== 'CREDIT_CARD') warnings.push('The file looks like a credit-card statement but this is not a credit-card account.');
    if (p.meta.currency && p.meta.currency !== account.currency) warnings.push(`The file is in ${p.meta.currency}; this account is ${account.currency}.`);
    let summary;
    if (p.result) {
      const fps = fingerprints(p.result.rows);
      const have = await this.existingFingerprints(accountId, fps);
      const fresh = p.result.rows.filter((_, i) => !have.has(fps[i]));
      summary = { total: p.result.rows.length, newCount: fresh.length, duplicateCount: p.result.rows.length - fresh.length, errors: p.result.errors.slice(0, 50), errorCount: p.result.errors.length, preview: fresh.slice(0, 25) };
    }
    return { filename, sha256: p.sha256, format: p.format, alreadyImported: prior, csv: p.csv, meta: p.meta, warnings, summary };
  }

  async commitImport(companyId: string, accountId: string, buf: Buffer, filename: string, o: { mapping?: CsvMapping; acceptErrors: boolean }, actorId: string, ip: string | null) {
    const account = await this.getAccount(companyId, accountId);
    if (!account.isActive) throw new ConflictException({ code: 'INACTIVE', message: 'This bank account is inactive' });
    const p = this.parseUpload(buf, filename, o.mapping);
    if (!p.result) throw new BadRequestException({ code: 'MAPPING_REQUIRED', message: 'A column mapping is required for CSV files' });
    const prior = await this.prisma.bankStatement.findUnique({ where: { bankAccountId_sha256: { bankAccountId: accountId, sha256: p.sha256 } } });
    if (prior) throw new ConflictException({ code: 'FILE_ALREADY_IMPORTED', message: `This exact file was already imported on ${prior.createdAt.toISOString().slice(0, 10)} (${prior.filename}).` });
    if (!p.result.rows.length) throw new UnprocessableEntityException({ code: 'NOTHING_TO_IMPORT', message: 'No valid transactions were found', errors: p.result.errors.slice(0, 20) });
    if (p.result.errors.length && !o.acceptErrors) throw new UnprocessableEntityException({ code: 'ROW_ERRORS', message: `${p.result.errors.length} row(s) could not be read; fix the mapping or confirm to import the rest`, errors: p.result.errors.slice(0, 20) });

    const rows = p.result.rows;
    const fps = fingerprints(rows);
    const dates = rows.map((r) => r.date).sort();
    // File first, then the row: a crash in between leaves only an unreferenced file, never a row without its file.
    const storageKey = await this.docs.put(companyId, p.sha256, buf);
    const batch = await this.prisma.$transaction(async (tx) => {
      const st = await tx.bankStatement.create({
        data: { companyId, bankAccountId: accountId, filename: filename.slice(0, 200), format: p.format, sha256: p.sha256, sizeBytes: buf.length, content: storageKey ? null : Uint8Array.from(buf), storageKey, periodStart: toDate(p.meta.periodStart ?? dates[0]), periodEnd: toDate(p.meta.periodEnd ?? dates[dates.length - 1]), endingBalance: p.meta.endingBalance, uploadedById: actorId },
      });
      const created = await tx.bankTransaction.createMany({
        data: rows.map((r, i) => ({ companyId, bankAccountId: accountId, statementId: st.id, externalId: r.externalId, fingerprint: fps[i], date: toDate(r.date), description: r.description.slice(0, 500), amount: r.amount, balanceAfter: r.balance })),
        skipDuplicates: true,
      });
      const b = await tx.importBatch.create({ data: { companyId, bankAccountId: accountId, source: p.format, statementId: st.id, total: rows.length + p.result!.errors.length, imported: created.count, skippedDuplicates: rows.length - created.count, failed: p.result!.errors.length, summary: { errors: p.result!.errors.slice(0, 50), period: [p.meta.periodStart ?? null, p.meta.periodEnd ?? null] }, createdById: actorId } });
      await tx.bankTransaction.updateMany({ where: { bankAccountId: accountId, statementId: st.id }, data: { batchId: b.id } });
      await this.audit.record({ action: 'bank_import.committed', companyId, actorId, entityType: 'ImportBatch', entityId: b.id, metadata: { filename, imported: created.count, skipped: rows.length - created.count, sha256: p.sha256 }, ip }, tx);
      return b;
    });
    const fresh = { ids: (await this.prisma.bankTransaction.findMany({ where: { statementId: batch.statementId!, status: 'UNMATCHED' }, select: { id: true } })).map((t) => t.id) };
    const rules = await this.applyRules(companyId, accountId, fresh);
    const sugg = await this.suggest(companyId, accountId, fresh);
    return { ...batch, ruleSuggestions: rules, matchSuggestions: sugg };
  }

  /** The preserved original file. */
  async downloadStatement(companyId: string, statementId: string) {
    const s = await this.prisma.bankStatement.findFirst({ where: { id: statementId, companyId } });
    if (!s) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Statement not found' });
    return { filename: s.filename, sha256: s.sha256, bytes: await this.docs.get(s) };
  }
  listStatements(companyId: string, bankAccountId?: string) {
    return this.prisma.bankStatement.findMany({ where: { companyId, ...(bankAccountId ? { bankAccountId } : {}) }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, bankAccountId: true, filename: true, format: true, sha256: true, sizeBytes: true, periodStart: true, periodEnd: true, endingBalance: true, createdAt: true, batch: { select: { imported: true, skippedDuplicates: true, failed: true } } } });
  }

  // ========================================================================= rules

  listRules(companyId: string) { return this.prisma.bankRule.findMany({ where: { companyId }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] }); }

  async saveRule(companyId: string, i: { id?: string; name: string; priority: number; conditions: RuleConditions; accountId: string; taxCodeId?: string; contactId?: string; isActive: boolean }, actorId: string, ip: string | null) {
    const acct = await this.prisma.account.findFirst({ where: { id: i.accountId, companyId, isActive: true, role: null } });
    if (!acct) throw new BadRequestException({ code: 'INVALID_ACCOUNT', message: 'Pick an active, non-control account' });
    if (i.taxCodeId && !(await this.prisma.taxCode.findFirst({ where: { id: i.taxCodeId, companyId } }))) throw new BadRequestException({ code: 'INVALID_TAX_CODE', message: 'Unknown tax code' });
    if (i.contactId && !(await this.prisma.contact.findFirst({ where: { id: i.contactId, companyId } }))) throw new BadRequestException({ code: 'INVALID_CONTACT', message: 'Unknown contact' });
    if (i.conditions.bankAccountId) await this.getAccount(companyId, i.conditions.bankAccountId);
    const data = { name: i.name, priority: i.priority, conditions: i.conditions as unknown as Prisma.InputJsonValue, accountId: i.accountId, taxCodeId: i.taxCodeId, contactId: i.contactId, isActive: i.isActive };
    if (i.id) {
      if (!(await this.prisma.bankRule.findFirst({ where: { id: i.id, companyId } }))) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Rule not found' });
      return this.prisma.bankRule.update({ where: { id: i.id }, data });
    }
    const r = await this.prisma.bankRule.create({ data: { ...data, companyId } });
    await this.audit.record({ action: 'bank_rule.created', companyId, actorId, entityType: 'BankRule', entityId: r.id, ip });
    return r;
  }

  async deleteRule(companyId: string, id: string) {
    const r = await this.prisma.bankRule.deleteMany({ where: { id, companyId } });
    if (!r.count) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Rule not found' });
  }

  /** Rules only ever *suggest* an account on UNMATCHED transactions; nothing is posted. */
  /** `only` limits the work to just-imported transactions (imports and feed syncs); without it every unmatched one is re-checked. */
  async applyRules(companyId: string, bankAccountId?: string, only?: { ids: string[] }) {
    const rules = (await this.listRules(companyId)).map((r) => ({ id: r.id, priority: r.priority, isActive: r.isActive, accountId: r.accountId, conditions: r.conditions as unknown as RuleConditions }));
    if (!rules.length) return 0;
    if (only && !only.ids.length) return 0;
    const txns = await this.prisma.bankTransaction.findMany({ where: { companyId, status: 'UNMATCHED', ...(bankAccountId ? { bankAccountId } : {}), ...(only ? { id: { in: only.ids } } : {}) }, take: 5000 });
    let n = 0;
    for (const t of txns) {
      const rule = firstMatchingRule(rules, { description: t.description, amount: t.amount.toString(), bankAccountId: t.bankAccountId });
      const want = rule ? { suggestedAccountId: rule.accountId, suggestedRuleId: rule.id } : { suggestedAccountId: null, suggestedRuleId: null };
      if (!rule && !t.suggestedRuleId) continue; // keep manual suggestions
      if (t.suggestedRuleId === want.suggestedRuleId && t.suggestedAccountId === want.suggestedAccountId) continue;
      await this.prisma.bankTransaction.update({ where: { id: t.id }, data: want });
      if (rule) n += 1;
    }
    return n;
  }

  // ========================================================================= transactions

  async listTransactions(companyId: string, q: { bankAccountId?: string; status?: string; from?: string; to?: string; search?: string; cursor?: string; take?: number }) {
    const take = Math.min(q.take ?? 50, 200);
    const rows = await this.prisma.bankTransaction.findMany({
      where: { companyId, ...(q.bankAccountId ? { bankAccountId: q.bankAccountId } : {}), ...(q.status ? { status: q.status as 'UNMATCHED' } : {}), ...(q.search ? { description: { contains: q.search, mode: 'insensitive' as const } } : {}), ...(q.from || q.to ? { date: { ...(q.from ? { gte: toDate(q.from) } : {}), ...(q.to ? { lte: toDate(q.to) } : {}) } } : {}) },
      orderBy: [{ date: 'desc' }, { id: 'desc' }], take: take + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { matches: { where: { status: 'SUGGESTED' }, orderBy: { confidence: 'desc' }, take: 3 } },
    });
    const page = rows.slice(0, take);
    const lineIds = [...new Set(page.flatMap((t) => [t.matchedLineId, ...t.matches.map((m) => m.journalLineId)]).filter((x): x is string => !!x))];
    const lines = lineIds.length ? await this.prisma.journalLine.findMany({ where: { id: { in: lineIds }, companyId }, include: { entry: { select: { id: true, number: true, date: true, memo: true, sourceType: true } } } }) : [];
    const byId = new Map(lines.map((l) => [l.id, l]));
    const acctIds = [...new Set(page.map((t) => t.suggestedAccountId).filter((x): x is string => !!x))];
    const accts = acctIds.length ? await this.prisma.account.findMany({ where: { id: { in: acctIds } }, select: { id: true, code: true, name: true } }) : [];
    const ent = (id: string | null) => { const l = id ? byId.get(id) : null; return l ? { journalId: l.entry.id, number: l.entry.number, date: l.entry.date, memo: l.memo ?? l.entry.memo, sourceType: l.entry.sourceType } : null; };
    return {
      items: page.map(({ matches, ...t }) => ({ ...t, matchedEntry: ent(t.matchedLineId), suggestedAccount: accts.find((a) => a.id === t.suggestedAccountId) ?? null, suggestions: matches.map((m) => ({ id: m.id, confidence: Number(m.confidence), reasons: m.reasons, journalLineId: m.journalLineId, entry: ent(m.journalLineId) })) })),
      nextCursor: rows.length > take ? page[take - 1].id : null,
    };
  }

  // ========================================================================= matching

  /** Unreconciled ledger lines of this bank account that could pair with a bank transaction. Reversed entries and reversals never qualify. */
  private async candidateLines(companyId: string, ledgerAccountId: string, bankAccountId: string, from: Date, to: Date): Promise<LedgerCandidate[]> {
    const taken = new Set((await this.prisma.bankTransaction.findMany({ where: { bankAccountId, matchedLineId: { not: null } }, select: { matchedLineId: true } })).map((t) => t.matchedLineId!));
    const lines = await this.prisma.journalLine.findMany({
      where: { companyId, accountId: ledgerAccountId, entry: { status: 'POSTED', reversedBy: null, reversalOfId: null, date: { gte: new Date(from.getTime() - 31 * 86_400_000), lte: new Date(to.getTime() + 31 * 86_400_000) } } },
      include: { entry: { select: { date: true, memo: true, sourceType: true } } },
    });
    const free = lines.filter((l) => !taken.has(l.id));
    const contactIds = [...new Set(free.map((l) => l.contactId).filter((x): x is string => !!x))];
    const contacts = contactIds.length ? await this.prisma.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true } }) : [];
    const nm = new Map(contacts.map((c) => [c.id, c.name]));
    return free.map((l) => ({ lineId: l.id, date: isoOf(l.entry.date), signed: D(l.debit).minus(l.credit).toFixed(2), memo: l.memo ?? l.entry.memo, contactName: l.contactId ? nm.get(l.contactId) : null, sourceType: l.entry.sourceType }));
  }

  /** (Re)compute suggestions for UNMATCHED transactions. Writes only SUGGESTED rows; never changes books or transaction status. */
  /**
   * Score possible ledger matches. After an import or feed sync only the new transactions are scored (`only`); re-scoring the
   * whole unmatched backlog every time made each import slower than the last and blocked the API for other users.
   * The explicit "Suggest matches" action still re-scores everything.
   */
  async suggest(companyId: string, bankAccountId: string, only?: { ids: string[] }) {
    const account = await this.getAccount(companyId, bankAccountId);
    if (only && !only.ids.length) return 0;
    const txns = await this.prisma.bankTransaction.findMany({ where: { bankAccountId, status: 'UNMATCHED', ...(only ? { id: { in: only.ids } } : {}) }, orderBy: { date: 'asc' }, take: 5000 });
    if (!txns.length) return 0;
    const cands = await this.candidateLines(companyId, account.ledgerAccountId, bankAccountId, txns[0].date, txns[txns.length - 1].date);
    const rejected = new Set((await this.prisma.reconciliationMatch.findMany({ where: { companyId, status: 'REJECTED', bankTxnId: { in: txns.map((t) => t.id) } }, select: { bankTxnId: true, journalLineId: true } })).map((m) => `${m.bankTxnId}|${m.journalLineId}`));
    const data: Prisma.ReconciliationMatchCreateManyInput[] = [];
    for (const [i, t] of txns.entries()) {
      const s = suggestMatches({ date: isoOf(t.date), amount: t.amount.toString(), description: t.description }, cands.filter((c) => !rejected.has(`${t.id}|${c.lineId}`)));
      for (const x of s) data.push({ companyId, bankTxnId: t.id, journalLineId: x.lineId, confidence: x.confidence, reasons: x.reasons });
      if (i % 50 === 49) await new Promise((r) => setImmediate(r)); // let other requests run between chunks (one CPU-bound loop must not stall the API)
    }
    await this.prisma.$transaction([
      this.prisma.reconciliationMatch.deleteMany({ where: { bankTxnId: { in: txns.map((t) => t.id) }, status: 'SUGGESTED' } }),
      this.prisma.reconciliationMatch.createMany({ data, skipDuplicates: true }),
    ]);
    return data.length;
  }

  private async lockTxn(tx: Tx, companyId: string, id: string) {
    await tx.$queryRaw`SELECT id FROM "BankTransaction" WHERE id = ${id}::uuid FOR UPDATE`;
    const t = await tx.bankTransaction.findFirst({ where: { id, companyId }, include: { bankAccount: true } });
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Bank transaction not found' });
    return t;
  }

  /** Link a transaction to a posted ledger line. The ONLY way a match becomes real; always a deliberate action. */
  private async link(tx: Tx, companyId: string, t: { id: string; amount: Prisma.Decimal; bankAccountId: string; bankAccount: { ledgerAccountId: string } }, lineId: string, by: { actorId: string; confidence: number; reasons: string[] }) {
    const line = await tx.journalLine.findFirst({ where: { id: lineId, companyId }, include: { entry: { include: { reversedBy: { select: { id: true } } } } } });
    if (!line || line.accountId !== t.bankAccount.ledgerAccountId) throw new BadRequestException({ code: 'INVALID_LINE', message: "That journal line is not on this bank account's ledger account" });
    if (line.entry.status !== 'POSTED' || line.entry.reversedBy || line.entry.reversalOfId) throw new ConflictException({ code: 'LINE_UNAVAILABLE', message: 'That entry is not available (draft, reversed, or a reversal)' });
    if (!D(line.debit).minus(line.credit).eq(t.amount.toString())) throw new UnprocessableEntityException({ code: 'AMOUNT_MISMATCH', message: 'The ledger amount does not equal the bank amount' });
    const taken = await tx.bankTransaction.findFirst({ where: { matchedLineId: lineId } });
    if (taken) throw new ConflictException({ code: 'LINE_TAKEN', message: 'That ledger line is already matched to another bank transaction' });
    await tx.reconciliationMatch.deleteMany({ where: { bankTxnId: t.id, status: 'SUGGESTED', journalLineId: { not: lineId } } });
    await tx.reconciliationMatch.upsert({
      where: { bankTxnId_journalLineId: { bankTxnId: t.id, journalLineId: lineId } },
      update: { status: 'APPROVED', confidence: by.confidence, reasons: by.reasons, decidedById: by.actorId, decidedAt: new Date() },
      create: { companyId, bankTxnId: t.id, journalLineId: lineId, confidence: by.confidence, reasons: by.reasons, status: 'APPROVED', decidedById: by.actorId, decidedAt: new Date() },
    });
    await tx.bankTransaction.update({ where: { id: t.id }, data: { status: 'MATCHED', matchedLineId: lineId, matchedAt: new Date(), matchedById: by.actorId } });
    return line;
  }

  async approveMatch(companyId: string, matchId: string, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const m = await tx.reconciliationMatch.findFirst({ where: { id: matchId, companyId } });
      if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Suggestion not found' });
      const t = await this.lockTxn(tx, companyId, m.bankTxnId);
      if (m.status !== 'SUGGESTED' || t.status !== 'UNMATCHED') throw new ConflictException({ code: 'NOT_PENDING', message: 'This suggestion is no longer pending' });
      await this.link(tx, companyId, t, m.journalLineId, { actorId, confidence: Number(m.confidence), reasons: m.reasons as string[] });
      await this.audit.record({ action: 'bank_match.approved', companyId, actorId, entityType: 'BankTransaction', entityId: t.id, metadata: { confidence: Number(m.confidence), lineId: m.journalLineId }, ip }, tx);
      return { ok: true };
    });
  }

  async rejectMatch(companyId: string, matchId: string, actorId: string, ip: string | null) {
    const m = await this.prisma.reconciliationMatch.findFirst({ where: { id: matchId, companyId, status: 'SUGGESTED' } });
    if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Suggestion not found' });
    await this.prisma.reconciliationMatch.update({ where: { id: matchId }, data: { status: 'REJECTED', decidedById: actorId, decidedAt: new Date() } });
    await this.audit.record({ action: 'bank_match.rejected', companyId, actorId, entityType: 'BankTransaction', entityId: m.bankTxnId, ip });
  }

  /** Explicit bulk action chosen by a person ("approve everything ≥ 90 %"). Ambiguous matches score lower and are never swept up. */
  async approveBulk(companyId: string, i: { bankAccountId: string; minConfidence: number }, actorId: string, ip: string | null) {
    await this.getAccount(companyId, i.bankAccountId);
    const matches = await this.prisma.reconciliationMatch.findMany({ where: { companyId, status: 'SUGGESTED', confidence: { gte: i.minConfidence }, bankTxn: { bankAccountId: i.bankAccountId, status: 'UNMATCHED' } }, orderBy: { confidence: 'desc' }, take: 500 });
    let approved = 0;
    const skipped: string[] = [];
    for (const m of matches) {
      try { await this.approveMatch(companyId, m.id, actorId, ip); approved += 1; } catch (e) { skipped.push((e as Error).message); }
    }
    await this.audit.record({ action: 'bank_match.bulk_approved', companyId, actorId, entityType: 'BankAccount', entityId: i.bankAccountId, metadata: { approved, minConfidence: i.minConfidence, skipped: skipped.length }, ip });
    return { approved, skipped: skipped.length };
  }

  async manualMatch(companyId: string, txnId: string, lineId: string, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.lockTxn(tx, companyId, txnId);
      if (t.status !== 'UNMATCHED') throw new ConflictException({ code: 'NOT_UNMATCHED', message: `Transaction is ${t.status.toLowerCase()}` });
      await this.link(tx, companyId, t, lineId, { actorId, confidence: 1, reasons: ['matched manually'] });
      await this.audit.record({ action: 'bank_match.manual', companyId, actorId, entityType: 'BankTransaction', entityId: txnId, metadata: { lineId }, ip }, tx);
      return { ok: true };
    });
  }

  async unmatch(companyId: string, txnId: string, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.lockTxn(tx, companyId, txnId);
      if (t.status === 'RECONCILED') throw new ForbiddenException({ code: 'RECONCILED', message: 'Reconciled transactions are locked. Reopen the reconciliation first.' });
      if (t.status !== 'MATCHED') throw new ConflictException({ code: 'NOT_MATCHED', message: 'Transaction is not matched' });
      await tx.reconciliationMatch.updateMany({ where: { bankTxnId: txnId, status: 'APPROVED' }, data: { status: 'REJECTED', decidedById: actorId, decidedAt: new Date() } });
      await tx.bankTransaction.update({ where: { id: txnId }, data: { status: 'UNMATCHED', matchedLineId: null, matchedAt: null, matchedById: null } });
      await this.audit.record({ action: 'bank_match.removed', companyId, actorId, entityType: 'BankTransaction', entityId: txnId, ip }, tx);
    });
  }

  async setIgnored(companyId: string, txnId: string, ignored: boolean, reason: string | undefined, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.lockTxn(tx, companyId, txnId);
      if (ignored && t.status !== 'UNMATCHED') throw new ConflictException({ code: 'NOT_UNMATCHED', message: 'Only unmatched transactions can be ignored' });
      if (!ignored && t.status !== 'IGNORED') throw new ConflictException({ code: 'NOT_IGNORED', message: 'Transaction is not ignored' });
      await tx.bankTransaction.update({ where: { id: txnId }, data: { status: ignored ? 'IGNORED' : 'UNMATCHED', ignoredReason: ignored ? reason ?? null : null } });
      await this.audit.record({ action: ignored ? 'bank_txn.ignored' : 'bank_txn.unignored', companyId, actorId, entityType: 'BankTransaction', entityId: txnId, ip }, tx);
    });
  }

  // ========================================================================= creating entries from transactions

  /** Match the bank-side line of a freshly posted entry to the transaction that caused it. */
  private async linkCreated(tx: Tx, companyId: string, t: Awaited<ReturnType<BankingService['lockTxn']>>, entryId: string, actorId: string, why: string) {
    const lines = await tx.journalLine.findMany({ where: { entryId, accountId: t.bankAccount.ledgerAccountId } });
    const line = lines.find((l) => D(l.debit).minus(l.credit).eq(t.amount.toString()));
    if (!line) throw new UnprocessableEntityException({ code: 'NO_BANK_LINE', message: 'The created entry has no bank-side line of the right amount' });
    await this.link(tx, companyId, t, line.id, { actorId, confidence: 1, reasons: [why] });
    return line.id;
  }

  async categorize(companyId: string, txnId: string, i: { lines: { accountId: string; amount: string; taxCodeId?: string; description?: string }[]; taxInclusive: boolean; contactId?: string; memo?: string }, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.lockTxn(tx, companyId, txnId);
      if (t.status !== 'UNMATCHED') throw new ConflictException({ code: 'NOT_UNMATCHED', message: `Transaction is ${t.status.toLowerCase()}` });
      const money = D(t.amount.toString());
      const out = money.isNegative();
      const ids = [...new Set(i.lines.map((l) => l.accountId))];
      const accts = await tx.account.findMany({ where: { companyId, id: { in: ids } } });
      if (accts.length !== ids.length) throw new BadRequestException({ code: 'INVALID_ACCOUNT', message: 'Unknown account on a line' });
      for (const a of accts) if (!a.isActive || a.role || a.id === t.bankAccount.ledgerAccountId) throw new BadRequestException({ code: 'INVALID_ACCOUNT', message: `Account ${a.code} cannot be used here (inactive, a control account, or the bank account itself)` });
      if (i.contactId && !(await tx.contact.findFirst({ where: { id: i.contactId, companyId } }))) throw new BadRequestException({ code: 'INVALID_CONTACT', message: 'Unknown contact' });
      const typeOf = new Map(accts.map((a) => [a.id, a.type]));
      for (const l of i.lines) {
        if (!l.taxCodeId) continue;
        const ty = typeOf.get(l.accountId);
        if (out && ty !== 'EXPENSE' && ty !== 'ASSET') throw new UnprocessableEntityException({ code: 'TAX_ACCOUNT_TYPE', message: 'Tax on money paid out can only be claimed on expense or asset accounts' });
        if (!out && ty !== 'REVENUE') throw new UnprocessableEntityException({ code: 'TAX_ACCOUNT_TYPE', message: 'Tax on money received is sales tax collected, so it needs a revenue account. For a supplier refund, leave tax blank and adjust separately.' });
      }
      const date = isoOf(t.date);
      const priced = await Promise.all(i.lines.map(async (l) => {
        if (!l.taxCodeId) return { accountId: l.accountId, net: D(l.amount).toFixed(2), taxes: [] as TaxLine[], memo: l.description };
        const [r] = await this.tax.compute(tx, companyId, date, i.taxInclusive, [{ amount: l.amount, taxCodeId: l.taxCodeId }]);
        return { accountId: l.accountId, net: r.net, taxes: r.taxes, memo: l.description };
      }));
      const gross = priced.reduce((s, l) => s.plus(l.net).plus(l.taxes.reduce((x, tl) => x.plus(tl.amount), D(0))), D(0));
      if (!gross.eq(money.abs())) throw new UnprocessableEntityException({ code: 'SPLIT_MISMATCH', message: `The lines add up to ${gross.toFixed(2)} but the bank transaction is ${money.abs().toFixed(2)}` });
      const roles = await this.ledger.roleAccounts(tx, companyId);
      const docLines: DocLine[] = priced;
      const memo = i.memo ?? t.description;
      const lines = out
        ? purchaseJournal({ lines: docLines, counterAccountId: t.bankAccount.ledgerAccountId, contactId: i.contactId, taxAccounts: roles.taxAccounts, memo })
        : salesJournal({ lines: docLines, receivableId: t.bankAccount.ledgerAccountId, contactId: i.contactId, taxAccounts: roles.taxAccounts, memo });
      const entry = await this.ledger.post(tx, { companyId, date, memo, sourceType: 'bank_txn', sourceId: t.id, lines, actorId, ip });
      await this.linkCreated(tx, companyId, t, entry.id, actorId, 'entry created from this transaction');
      await this.audit.record({ action: 'bank_txn.categorized', companyId, actorId, entityType: 'BankTransaction', entityId: t.id, metadata: { journal: entry.number, lines: i.lines.length }, ip }, tx);
      return { journalId: entry.id, number: entry.number };
    });
  }

  /** Invoices/bills the transaction could be settling, with confidence. Partial payments included. */
  async documentSuggestions(companyId: string, txnId: string) {
    const t = await this.prisma.bankTransaction.findFirst({ where: { id: txnId, companyId } });
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Bank transaction not found' });
    const money = D(t.amount.toString());
    const receipt = money.isPositive();
    const docs = receipt
      ? await this.prisma.invoice.findMany({ where: { companyId, kind: 'STANDARD', status: { in: ['POSTED', 'PARTIAL'] } }, include: { contact: { select: { id: true, name: true } } }, take: 500 })
      : await this.prisma.bill.findMany({ where: { companyId, kind: 'STANDARD', status: { in: ['POSTED', 'PARTIAL'] } }, include: { contact: { select: { id: true, name: true } } }, take: 500 });
    return docs.flatMap((d) => {
      const outstanding = D(d.total).minus(d.amountPaid);
      const s = scoreDocument({ amount: money.toFixed(2), description: t.description }, { number: d.number, outstanding: outstanding.toFixed(2), contactName: d.contact.name });
      return s ? [{ kind: receipt ? 'invoice' : 'bill', documentId: d.id, number: d.number, contactId: d.contact.id, contactName: d.contact.name, outstanding: outstanding.toFixed(2), ...s }] : [];
    }).sort((a, b) => b.confidence - a.confidence).slice(0, 5);
  }

  async settle(companyId: string, txnId: string, i: { contactId: string; allocations: { documentId: string; amount: string }[] }, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.lockTxn(tx, companyId, txnId);
      if (t.status !== 'UNMATCHED') throw new ConflictException({ code: 'NOT_UNMATCHED', message: `Transaction is ${t.status.toLowerCase()}` });
      const money = D(t.amount.toString());
      const pay = await this.billing.createPayment(companyId, { direction: money.isPositive() ? 'RECEIPT' : 'DISBURSEMENT', contactId: i.contactId, bankAccountId: t.bankAccount.ledgerAccountId, date: isoOf(t.date), amount: money.abs().toFixed(2), reference: t.description.slice(0, 100), allocations: i.allocations }, actorId, ip, tx);
      await this.linkCreated(tx, companyId, t, pay.journalEntryId, actorId, 'payment recorded from this transaction');
      await this.audit.record({ action: 'bank_txn.settled', companyId, actorId, entityType: 'BankTransaction', entityId: t.id, metadata: { paymentId: pay.id, allocations: i.allocations.length }, ip }, tx);
      return { paymentId: pay.id };
    });
  }

  // ---- transfers

  async transferCandidates(companyId: string) {
    const txns = await this.prisma.bankTransaction.findMany({ where: { companyId, status: 'UNMATCHED' }, select: { id: true, bankAccountId: true, date: true, amount: true, description: true }, take: 3000 });
    const pairs = findTransferPairs(txns.map((t) => ({ id: t.id, bankAccountId: t.bankAccountId, date: isoOf(t.date), amount: t.amount.toString() })));
    const by = new Map(txns.map((t) => [t.id, t]));
    return pairs.map((p) => ({ ...p, from: by.get(p.fromId), to: by.get(p.toId) }));
  }

  /** Move money between two of the company's own bank accounts: one balanced entry, no income or expense. */
  async transfer(companyId: string, txnId: string, i: { counterpartTxnId?: string; toBankAccountId?: string }, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.lockTxn(tx, companyId, txnId);
      if (t.status !== 'UNMATCHED') throw new ConflictException({ code: 'NOT_UNMATCHED', message: `Transaction is ${t.status.toLowerCase()}` });
      let other: Awaited<ReturnType<BankingService['lockTxn']>> | null = null;
      let otherAccount;
      if (i.counterpartTxnId) {
        other = await this.lockTxn(tx, companyId, i.counterpartTxnId);
        if (other.status !== 'UNMATCHED') throw new ConflictException({ code: 'NOT_UNMATCHED', message: 'The other transaction is not unmatched' });
        otherAccount = other.bankAccount;
        if (other.bankAccountId === t.bankAccountId) throw new BadRequestException({ code: 'SAME_ACCOUNT', message: 'A transfer needs two different bank accounts' });
        if (!D(other.amount.toString()).neg().eq(t.amount.toString())) throw new UnprocessableEntityException({ code: 'AMOUNT_MISMATCH', message: 'The two transactions must be equal and opposite' });
      } else if (i.toBankAccountId) {
        otherAccount = await this.getAccount(companyId, i.toBankAccountId, tx);
        if (otherAccount.id === t.bankAccountId) throw new BadRequestException({ code: 'SAME_ACCOUNT', message: 'A transfer needs two different bank accounts' });
      } else throw new BadRequestException({ code: 'COUNTERPART_REQUIRED', message: 'Provide the other transaction or the other bank account' });

      const money = D(t.amount.toString());
      const abs = money.abs().toFixed(2);
      const outAcct = money.isNegative() ? t.bankAccount : otherAccount;
      const inAcct = money.isNegative() ? otherAccount : t.bankAccount;
      const outTxn = money.isNegative() ? t : other;
      const date = isoOf((outTxn ?? t).date);
      const entry = await this.ledger.post(tx, {
        companyId, date, memo: `Transfer ${outAcct.name} → ${inAcct.name}`, sourceType: 'bank_transfer', sourceId: (outTxn ?? t).id,
        lines: [{ accountId: inAcct.ledgerAccountId, debit: abs, credit: '0.00', memo: 'Transfer in' }, { accountId: outAcct.ledgerAccountId, debit: '0.00', credit: abs, memo: 'Transfer out' }], actorId, ip,
      });
      await this.linkCreated(tx, companyId, t, entry.id, actorId, 'transfer between own accounts');
      if (other) await this.linkCreated(tx, companyId, other, entry.id, actorId, 'transfer between own accounts');
      await this.audit.record({ action: 'bank_txn.transferred', companyId, actorId, entityType: 'BankTransaction', entityId: t.id, metadata: { journal: entry.number, counterpart: other?.id ?? null }, ip }, tx);
      return { journalId: entry.id, number: entry.number, matchedBoth: Boolean(other) };
    });
  }

  /** Undo something created from a transaction: reverse its entry and release the transaction. Locked once reconciled. */
  async undoCreated(companyId: string, txnId: string, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.lockTxn(tx, companyId, txnId);
      if (t.status === 'RECONCILED') throw new ForbiddenException({ code: 'RECONCILED', message: 'Reconciled transactions are locked. Reopen the reconciliation first.' });
      if (t.status !== 'MATCHED' || !t.matchedLineId) throw new ConflictException({ code: 'NOT_MATCHED', message: 'Transaction is not matched' });
      const line = await tx.journalLine.findUniqueOrThrow({ where: { id: t.matchedLineId }, include: { entry: true } });
      if (line.entry.sourceType !== 'bank_txn' && line.entry.sourceType !== 'bank_transfer') throw new ConflictException({ code: 'NOT_CREATED_HERE', message: 'That entry was not created from this transaction; use "unmatch" instead' });
      const others = await tx.journalLine.findMany({ where: { entryId: line.entryId, id: { not: line.id } }, select: { id: true } });
      const partner = others.length ? await tx.bankTransaction.findFirst({ where: { matchedLineId: { in: others.map((o) => o.id) } } }) : null;
      if (partner?.status === 'RECONCILED') throw new ForbiddenException({ code: 'RECONCILED', message: 'The other side of this transfer is reconciled' });
      await this.ledger.reverse(companyId, line.entryId, actorId, { allowSourced: true, tx, memo: `Undo bank transaction entry` }, ip);
      for (const x of [t, partner].filter((v): v is NonNullable<typeof v> => !!v)) {
        await tx.reconciliationMatch.updateMany({ where: { bankTxnId: x.id, status: 'APPROVED' }, data: { status: 'REJECTED', decidedById: actorId, decidedAt: new Date() } });
        await tx.bankTransaction.update({ where: { id: x.id }, data: { status: 'UNMATCHED', matchedLineId: null, matchedAt: null, matchedById: null } });
      }
      await this.audit.record({ action: 'bank_txn.undone', companyId, actorId, entityType: 'BankTransaction', entityId: t.id, ip }, tx);
    });
  }
}
export type { NormBankTxn };
