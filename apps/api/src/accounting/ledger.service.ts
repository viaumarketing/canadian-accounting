import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Prisma } from '@ca/database';
import { LineInput, UnbalancedEntryError, assertBalanced, reverseLines } from '@ca/accounting-engine';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { createNextFiscalYear, ensurePeriods, isoOf, toDate } from './setup';

type Tx = Prisma.TransactionClient;
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());

export interface PostParams {
  companyId: string;
  date: string;
  memo?: string;
  sourceType: string;
  sourceId?: string;
  reversalOfId?: string;
  lines: LineInput[];
  actorId: string;
  ip?: string | null;
}

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  // ---------- numbering ----------

  /** Atomic, gap-free per (company, name) while the surrounding transaction commits. */
  async nextNumber(tx: Tx, companyId: string, name: string): Promise<number> {
    const rows = await tx.$queryRaw<{ n: number }[]>`
      INSERT INTO "Sequence" ("companyId","name","next") VALUES (${companyId}::uuid, ${name}, 2)
      ON CONFLICT ("companyId","name") DO UPDATE SET "next" = "Sequence"."next" + 1
      RETURNING "next" - 1 AS n`;
    return rows[0].n;
  }

  // ---------- the one place journals are posted ----------

  /**
   * Validates and posts a journal inside the caller's transaction. Every business document posts through here.
   * Checks: balanced; accounts belong to the company and are active; an OPEN accounting period covers the date.
   * The database independently re-checks balance and immutability via triggers.
   */
  async post(tx: Tx, p: PostParams) {
    try {
      assertBalanced(p.lines);
    } catch (e) {
      if (e instanceof UnbalancedEntryError) throw new UnprocessableEntityException({ code: 'UNBALANCED', message: e.message });
      throw e;
    }
    const ids = [...new Set(p.lines.map((l) => l.accountId))];
    const accounts = await tx.account.findMany({ where: { companyId: p.companyId, id: { in: ids } } });
    if (accounts.length !== ids.length) throw new BadRequestException({ code: 'INVALID_ACCOUNT', message: 'Unknown account in journal lines' });
    if (accounts.some((a) => !a.isActive)) throw new BadRequestException({ code: 'INACTIVE_ACCOUNT', message: 'An account in the journal is inactive' });

    const date = toDate(p.date);
    let period = await tx.accountingPeriod.findFirst({ where: { companyId: p.companyId, startDate: { lte: date }, endDate: { gte: date } } });
    if (!period) {
      await ensurePeriods(tx, p.companyId);
      period = await tx.accountingPeriod.findFirst({ where: { companyId: p.companyId, startDate: { lte: date }, endDate: { gte: date } } });
    }
    if (!period) throw new UnprocessableEntityException({ code: 'NO_PERIOD', message: `No fiscal year covers ${p.date}. Create the fiscal year first.` });
    if (period.status === 'LOCKED') throw new UnprocessableEntityException({ code: 'PERIOD_LOCKED', message: `Accounting period ${period.label} is locked` });

    const entry = await tx.journalEntry.create({
      data: {
        companyId: p.companyId, date, memo: p.memo, sourceType: p.sourceType, sourceId: p.sourceId,
        reversalOfId: p.reversalOfId, createdById: p.actorId,
        lines: { create: p.lines.map((l, i) => ({ companyId: p.companyId, lineNo: i + 1, accountId: l.accountId, debit: l.debit, credit: l.credit, memo: l.memo, contactId: l.contactId ?? undefined })) },
      },
    });
    const number = await this.nextNumber(tx, p.companyId, 'journal');
    return tx.journalEntry.update({ where: { id: entry.id }, data: { status: 'POSTED', number, postedAt: new Date(), postedById: p.actorId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
  }

  // ---------- accounts ----------

  listAccounts(companyId: string, includeInactive = false) {
    return this.prisma.account.findMany({ where: { companyId, ...(includeInactive ? {} : { isActive: true }) }, orderBy: { code: 'asc' } });
  }

  async createAccount(companyId: string, input: { code: string; name: string; type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE'; parentId?: string; description?: string }, actorId: string, ip: string | null) {
    if (input.parentId) {
      const parent = await this.prisma.account.findFirst({ where: { id: input.parentId, companyId } });
      if (!parent) throw new BadRequestException({ code: 'INVALID_PARENT', message: 'Parent account not found' });
      if (parent.type !== input.type) throw new BadRequestException({ code: 'PARENT_TYPE', message: 'A sub-account must have the same type as its parent' });
    }
    try {
      const a = await this.prisma.account.create({ data: { ...input, companyId } });
      await this.audit.record({ action: 'account.created', companyId, actorId, entityType: 'Account', entityId: a.id, metadata: { code: a.code }, ip });
      return a;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'DUPLICATE', message: 'An account with that code already exists' });
      throw e;
    }
  }

  async updateAccount(companyId: string, id: string, input: { name?: string; description?: string | null; isActive?: boolean; parentId?: string | null }, actorId: string, ip: string | null) {
    const a = await this.prisma.account.findFirst({ where: { id, companyId } });
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Account not found' });
    if (input.isActive === false && a.role) throw new ConflictException({ code: 'SYSTEM_ACCOUNT', message: 'System accounts cannot be deactivated' });
    if (input.parentId) {
      if (input.parentId === id) throw new BadRequestException({ code: 'INVALID_PARENT', message: 'An account cannot be its own parent' });
      const parent = await this.prisma.account.findFirst({ where: { id: input.parentId, companyId } });
      if (!parent || parent.type !== a.type) throw new BadRequestException({ code: 'INVALID_PARENT', message: 'Parent must exist and have the same type' });
    }
    const u = await this.prisma.account.update({ where: { id }, data: input });
    await this.audit.record({ action: 'account.updated', companyId, actorId, entityType: 'Account', entityId: id, metadata: input as Prisma.InputJsonObject, ip });
    return u;
  }

  /** Role → account id for the posting engine. */
  async roleAccounts(tx: Tx | PrismaService, companyId: string) {
    const rows = await tx.account.findMany({ where: { companyId, role: { not: null }, isActive: true } });
    const by = Object.fromEntries(rows.map((r) => [r.role!, r.id])) as Record<string, string | undefined>;
    return {
      receivableId: by.ACCOUNTS_RECEIVABLE,
      payableId: by.ACCOUNTS_PAYABLE,
      taxAccounts: {
        gstHstPayable: by.GST_HST_PAYABLE, gstHstReceivable: by.GST_HST_RECEIVABLE,
        qstPayable: by.QST_PAYABLE, qstReceivable: by.QST_RECEIVABLE, pstPayable: by.PST_PAYABLE,
      },
    };
  }

  // ---------- periods ----------

  async listPeriods(companyId: string) {
    await this.prisma.$transaction((tx) => ensurePeriods(tx, companyId));
    return this.prisma.accountingPeriod.findMany({ where: { companyId }, orderBy: { startDate: 'asc' } });
  }

  async setPeriodLock(companyId: string, id: string, locked: boolean, actorId: string, ip: string | null) {
    const p = await this.prisma.accountingPeriod.findFirst({ where: { id, companyId } });
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Period not found' });
    const u = await this.prisma.accountingPeriod.update({ where: { id }, data: { status: locked ? 'LOCKED' : 'OPEN' } });
    await this.audit.record({ action: locked ? 'period.locked' : 'period.unlocked', companyId, actorId, entityType: 'AccountingPeriod', entityId: id, metadata: { label: p.label }, ip });
    return u;
  }

  async addFiscalYear(companyId: string, startDate: string | undefined, actorId: string, ip: string | null) {
    try {
      const fy = await this.prisma.$transaction((tx) => createNextFiscalYear(tx, companyId, startDate ? toDate(startDate) : undefined));
      await this.audit.record({ action: 'fiscal_year.created', companyId, actorId, entityType: 'FiscalYear', entityId: fy.id, metadata: { label: fy.label }, ip });
      return fy;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'DUPLICATE', message: 'That fiscal year already exists' });
      throw e;
    }
  }

  // ---------- manual journals ----------

  async createJournal(companyId: string, input: { date: string; memo?: string; lines: { accountId: string; debit: string; credit: string; memo?: string; contactId?: string }[]; post: boolean }, actorId: string, ip: string | null) {
    const lines: LineInput[] = input.lines.map((l) => ({ ...l, debit: D(l.debit).toFixed(2), credit: D(l.credit).toFixed(2) }));
    const contactIds = [...new Set(lines.map((l) => l.contactId).filter((x): x is string => !!x))];
    if (contactIds.length && (await this.prisma.contact.count({ where: { companyId, id: { in: contactIds } } })) !== contactIds.length) {
      throw new BadRequestException({ code: 'INVALID_CONTACT', message: 'Unknown contact in journal lines' });
    }
    if (input.post) {
      return this.prisma.$transaction(async (tx) => {
        const e = await this.post(tx, { companyId, date: input.date, memo: input.memo, sourceType: 'manual', lines, actorId, ip });
        await this.audit.record({ action: 'journal.posted', companyId, actorId, entityType: 'JournalEntry', entityId: e.id, metadata: { number: e.number }, ip }, tx);
        return e;
      });
    }
    // Draft: structural validation only; balance is enforced at posting.
    const ids = [...new Set(lines.map((l) => l.accountId))];
    if ((await this.prisma.account.count({ where: { companyId, id: { in: ids } } })) !== ids.length) throw new BadRequestException({ code: 'INVALID_ACCOUNT', message: 'Unknown account in journal lines' });
    for (const l of lines) if (D(l.debit).gt(0) === D(l.credit).gt(0)) throw new BadRequestException({ code: 'INVALID_LINE', message: 'Each line needs exactly one of debit or credit' });
    return this.prisma.journalEntry.create({
      data: { companyId, date: toDate(input.date), memo: input.memo, createdById: actorId, lines: { create: lines.map((l, i) => ({ companyId, lineNo: i + 1, accountId: l.accountId, debit: l.debit, credit: l.credit, memo: l.memo, contactId: l.contactId })) } },
      include: { lines: true },
    });
  }

  async postDraft(companyId: string, id: string, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const d = await tx.journalEntry.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
      if (!d) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Journal not found' });
      if (d.status !== 'DRAFT') throw new ConflictException({ code: 'NOT_DRAFT', message: 'Journal is already posted' });
      // Drafts are replaced by a fresh posted entry so numbering/period rules run through the single posting path.
      await tx.journalLine.deleteMany({ where: { entryId: d.id } });
      await tx.journalEntry.delete({ where: { id: d.id } });
      const lines: LineInput[] = d.lines.map((l) => ({ accountId: l.accountId, debit: D(l.debit).toFixed(2), credit: D(l.credit).toFixed(2), memo: l.memo ?? undefined, contactId: l.contactId }));
      const e = await this.post(tx, { companyId, date: isoOf(d.date), memo: d.memo ?? undefined, sourceType: 'manual', lines, actorId, ip });
      await this.audit.record({ action: 'journal.posted', companyId, actorId, entityType: 'JournalEntry', entityId: e.id, metadata: { number: e.number, fromDraft: true }, ip }, tx);
      return e;
    });
  }

  async deleteDraft(companyId: string, id: string, actorId: string, ip: string | null) {
    const d = await this.prisma.journalEntry.findFirst({ where: { id, companyId } });
    if (!d) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Journal not found' });
    if (d.status !== 'DRAFT') throw new ForbiddenException({ code: 'IMMUTABLE', message: 'Posted journals cannot be deleted; reverse them instead' });
    await this.prisma.$transaction([this.prisma.journalLine.deleteMany({ where: { entryId: id } }), this.prisma.journalEntry.delete({ where: { id } })]);
    await this.audit.record({ action: 'journal.draft_deleted', companyId, actorId, entityType: 'JournalEntry', entityId: id, ip });
  }

  /** Reverse any posted entry (internal; document voids call this). `allowSourced` is for those callers only. */
  async reverse(companyId: string, id: string, actorId: string, opts: { date?: string; memo?: string; allowSourced?: boolean; tx?: Tx } = {}, ip: string | null = null) {
    const run = async (tx: Tx) => {
      const orig = await tx.journalEntry.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } }, reversedBy: true } });
      if (!orig) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Journal not found' });
      if (orig.status !== 'POSTED') throw new ConflictException({ code: 'NOT_POSTED', message: 'Only posted journals can be reversed' });
      if (orig.reversedBy) throw new ConflictException({ code: 'ALREADY_REVERSED', message: 'Journal was already reversed' });
      if (orig.reversalOfId) throw new ConflictException({ code: 'IS_REVERSAL', message: 'A reversal cannot itself be reversed; post a new entry' });
      if (orig.sourceType !== 'manual' && !opts.allowSourced) {
        throw new ConflictException({ code: 'SOURCED', message: `This entry was created by a ${orig.sourceType}; void that document instead` });
      }
      const rev = await this.post(tx, {
        companyId, date: opts.date ?? isoOf(orig.date), memo: opts.memo ?? `Reversal of #${orig.number}`, sourceType: 'reversal',
        sourceId: orig.id, reversalOfId: orig.id, lines: reverseLines(orig.lines), actorId, ip,
      });
      await this.audit.record({ action: 'journal.reversed', companyId, actorId, entityType: 'JournalEntry', entityId: orig.id, metadata: { reversalId: rev.id, number: rev.number }, ip }, tx);
      return rev;
    };
    return opts.tx ? run(opts.tx) : this.prisma.$transaction(run);
  }

  async listJournals(companyId: string, q: { from?: string; to?: string; status?: 'DRAFT' | 'POSTED'; cursor?: string; take?: number }) {
    const take = Math.min(q.take ?? 50, 200);
    const rows = await this.prisma.journalEntry.findMany({
      where: { companyId, ...(q.status ? { status: q.status } : {}), ...(q.from || q.to ? { date: { ...(q.from ? { gte: toDate(q.from) } : {}), ...(q.to ? { lte: toDate(q.to) } : {}) } } : {}) },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { lines: { orderBy: { lineNo: 'asc' }, include: { account: { select: { code: true, name: true } } } } },
    });
    return { items: rows.slice(0, take), nextCursor: rows.length > take ? rows[take - 1].id : null };
  }

  async getJournal(companyId: string, id: string) {
    const e = await this.prisma.journalEntry.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' }, include: { account: { select: { code: true, name: true } } } }, reversedBy: { select: { id: true, number: true } } } });
    if (!e) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Journal not found' });
    return e;
  }

  // ---------- reports (derived only from POSTED journal lines) ----------

  async trialBalance(companyId: string, asOf: string) {
    const [accounts, sums] = await Promise.all([
      this.prisma.account.findMany({ where: { companyId }, orderBy: { code: 'asc' } }),
      this.prisma.journalLine.groupBy({ by: ['accountId'], where: { companyId, entry: { status: 'POSTED', date: { lte: toDate(asOf) } } }, _sum: { debit: true, credit: true } }),
    ]);
    const m = new Map(sums.map((s) => [s.accountId, s._sum]));
    let td = D(0), tc = D(0);
    const rows = accounts.flatMap((a) => {
      const s = m.get(a.id);
      const debit = D(s?.debit ?? 0), credit = D(s?.credit ?? 0);
      if (debit.isZero() && credit.isZero()) return [];
      const net = debit.minus(credit);
      const dr = net.gt(0) ? net : D(0), cr = net.lt(0) ? net.neg() : D(0);
      td = td.plus(dr); tc = tc.plus(cr);
      return [{ accountId: a.id, code: a.code, name: a.name, type: a.type, debitTotal: debit.toFixed(2), creditTotal: credit.toFixed(2), debit: dr.toFixed(2), credit: cr.toFixed(2) }];
    });
    return { asOf, rows, totals: { debit: td.toFixed(2), credit: tc.toFixed(2), balanced: td.eq(tc) } };
  }

  async generalLedger(companyId: string, accountId: string, from: string, to: string) {
    const account = await this.prisma.account.findFirst({ where: { id: accountId, companyId } });
    if (!account) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Account not found' });
    const opening = await this.prisma.journalLine.aggregate({ where: { companyId, accountId, entry: { status: 'POSTED', date: { lt: toDate(from) } } }, _sum: { debit: true, credit: true } });
    const lines = await this.prisma.journalLine.findMany({
      where: { companyId, accountId, entry: { status: 'POSTED', date: { gte: toDate(from), lte: toDate(to) } } },
      include: { entry: { select: { id: true, number: true, date: true, memo: true, sourceType: true, sourceId: true } } },
      orderBy: [{ entry: { date: 'asc' } }, { entry: { number: 'asc' } }, { lineNo: 'asc' }],
    });
    // Running balance is signed debit-positive; `normal` tells the UI how to present it.
    let run = D(opening._sum.debit ?? 0).minus(opening._sum.credit ?? 0);
    const openingBalance = run.toFixed(2);
    const rows = lines.map((l) => {
      run = run.plus(l.debit.toString()).minus(l.credit.toString());
      return { date: isoOf(l.entry.date), entryId: l.entry.id, number: l.entry.number, sourceType: l.entry.sourceType, memo: l.memo ?? l.entry.memo, debit: D(l.debit).toFixed(2), credit: D(l.credit).toFixed(2), balance: run.toFixed(2) };
    });
    return { account: { id: account.id, code: account.code, name: account.name, type: account.type, normal: ['ASSET', 'EXPENSE'].includes(account.type) ? 'DEBIT' : 'CREDIT' }, from, to, openingBalance, rows, closingBalance: run.toFixed(2) };
  }
}
