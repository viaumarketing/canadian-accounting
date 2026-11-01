import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Prisma } from '@ca/database';
import { reconSummary } from '@ca/banking';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { isoOf, toDate } from '../accounting/setup';
import { BankingService } from './banking.service';

const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
type Account = Prisma.BankAccountGetPayload<object>;

/** Statements print a credit card as the amount OWED (positive); our books carry it as a negative balance. */
const toSigned = (a: Account, printed: string) => (a.kind === 'CREDIT_CARD' ? D(printed).neg() : D(printed));
const toPrinted = (a: Account, signed: Decimal) => (a.kind === 'CREDIT_CARD' ? signed.neg() : signed).toFixed(2);

@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService, private readonly banking: BankingService, private readonly audit: AuditService) {}

  private async opening(a: Account, provided: string | undefined, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    const last = await db.reconciliation.findFirst({ where: { bankAccountId: a.id, status: 'COMPLETED' }, orderBy: { statementDate: 'desc' } });
    if (last) return { opening: D(last.statementBalance), last };
    if (provided === undefined) throw new UnprocessableEntityException({ code: 'OPENING_REQUIRED', message: 'This is the first reconciliation of this account: enter the statement\'s opening (beginning) balance' });
    return { opening: toSigned(a, provided), last: null };
  }

  /** Ledger lines on the account dated ≤ date that no bank transaction accounts for ("outstanding" items), excluding reversed pairs. */
  private async outstandingLines(a: Account, upTo: Date, notMatchedBefore?: Date) {
    // Ledger lines dated before the account's first bank transaction are the opening balance (already inside the statement's
    // opening figure), not "outstanding" items.
    const first = await this.prisma.bankTransaction.aggregate({ where: { bankAccountId: a.id }, _min: { date: true } });
    const lines = await this.prisma.journalLine.findMany({
      where: { companyId: a.companyId, accountId: a.ledgerAccountId, entry: { status: 'POSTED', reversedBy: null, reversalOfId: null, date: { lte: upTo, ...(first._min.date ? { gte: first._min.date } : {}) } } },
      include: { entry: { select: { id: true, number: true, date: true, memo: true, sourceType: true } } }, orderBy: { entry: { date: 'asc' } },
    });
    const matched = await this.prisma.bankTransaction.findMany({
      where: { bankAccountId: a.id, matchedLineId: { in: lines.map((l) => l.id) }, ...(notMatchedBefore ? { OR: [{ reconciliation: { completedAt: { lte: notMatchedBefore }, status: 'COMPLETED' } }] } : {}) },
      select: { matchedLineId: true },
    });
    const taken = new Set(matched.map((m) => m.matchedLineId));
    return lines.filter((l) => !taken.has(l.id)).map((l) => ({ lineId: l.id, entryId: l.entry.id, number: l.entry.number, date: l.entry.date, memo: l.memo ?? l.entry.memo, sourceType: l.entry.sourceType, amount: D(l.debit).minus(l.credit).toFixed(2) }));
  }

  async preview(companyId: string, accountId: string, i: { statementDate: string; statementBalance: string; openingBalance?: string }) {
    const a = await this.banking.getAccount(companyId, accountId);
    const { opening, last } = await this.opening(a, i.openingBalance);
    const date = toDate(i.statementDate);
    if (last && date <= last.statementDate) throw new UnprocessableEntityException({ code: 'DATE_NOT_AFTER_LAST', message: `The statement date must be after the last reconciliation (${isoOf(last.statementDate)})` });
    const cleared = await this.prisma.bankTransaction.findMany({ where: { bankAccountId: accountId, status: 'MATCHED', date: { lte: date } }, orderBy: [{ date: 'asc' }, { id: 'asc' }] });
    const unmatched = await this.prisma.bankTransaction.findMany({ where: { bankAccountId: accountId, status: { in: ['UNMATCHED'] }, date: { lte: date } }, orderBy: { date: 'asc' }, take: 100 });
    const summary = reconSummary({ opening, cleared: cleared.map((t) => t.amount.toString()), statementEnding: toSigned(a, i.statementBalance) });
    const outstanding = await this.outstandingLines(a, date);
    const ledger = await this.prisma.journalLine.aggregate({ where: { companyId, accountId: a.ledgerAccountId, entry: { status: 'POSTED', date: { lte: date } } }, _sum: { debit: true, credit: true } });
    const ledgerBalance = D(ledger._sum.debit ?? 0).minus(ledger._sum.credit ?? 0);
    const outstandingNet = outstanding.reduce((s, l) => s.plus(l.amount), D(0));
    const unexplained = ledgerBalance.minus(D(summary.statementEnding).plus(outstandingNet));
    const warnings: string[] = [];
    if (unmatched.length) warnings.push(`${unmatched.length} bank transaction(s) dated on or before the statement date are still unmatched.`);
    if (!unexplained.isZero()) warnings.push(`Your ledger balance for this account (${ledgerBalance.toFixed(2)}) differs from the statement balance plus outstanding items by ${unexplained.toFixed(2)}. This usually means an opening balance was never recorded in the books, or bank transactions are unmatched.`);
    return {
      account: { id: a.id, name: a.name, kind: a.kind }, statementDate: i.statementDate,
      printedStatementBalance: toPrinted(a, D(summary.statementEnding)), summary: { ...summary, openingPrinted: toPrinted(a, opening) },
      cleared: cleared.map((t) => ({ id: t.id, date: t.date, description: t.description, amount: t.amount.toString() })),
      unmatchedBankTransactions: unmatched.map((t) => ({ id: t.id, date: t.date, description: t.description, amount: t.amount.toString() })),
      outstandingLedgerItems: outstanding, bookVsBank: { ledgerBalance: ledgerBalance.toFixed(2), outstandingNet: outstandingNet.toFixed(2), unexplained: unexplained.toFixed(2) }, warnings,
    };
  }

  async complete(companyId: string, accountId: string, i: { statementDate: string; statementBalance: string; openingBalance?: string; note?: string }, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "BankAccount" WHERE id = ${accountId}::uuid FOR UPDATE`; // serialise reconciliations per account
      const a = await this.banking.getAccount(companyId, accountId, tx);
      const { opening, last } = await this.opening(a, i.openingBalance, tx);
      const date = toDate(i.statementDate);
      if (last && date <= last.statementDate) throw new UnprocessableEntityException({ code: 'DATE_NOT_AFTER_LAST', message: `The statement date must be after the last reconciliation (${isoOf(last.statementDate)})` });
      const cleared = await tx.bankTransaction.findMany({ where: { bankAccountId: accountId, status: 'MATCHED', date: { lte: date } } });
      const ending = toSigned(a, i.statementBalance);
      const s = reconSummary({ opening, cleared: cleared.map((t) => t.amount.toString()), statementEnding: ending });
      if (!s.balanced) throw new UnprocessableEntityException({ code: 'RECON_DIFFERENCE', message: `Not balanced: the difference is ${s.difference}. Opening ${s.opening} + cleared ${s.cleared} = ${s.computedEnding}, but the statement says ${s.statementEnding}.`, difference: s.difference });
      const rec = await tx.reconciliation.create({ data: { companyId, bankAccountId: accountId, statementDate: date, statementBalance: ending.toFixed(2), openingBalance: opening.toFixed(2), clearedTotal: s.cleared, txnCount: cleared.length, completedById: actorId, note: i.note } });
      await tx.bankTransaction.updateMany({ where: { id: { in: cleared.map((t) => t.id) } }, data: { status: 'RECONCILED', reconciliationId: rec.id } });
      await this.audit.record({ action: 'reconciliation.completed', companyId, actorId, entityType: 'Reconciliation', entityId: rec.id, metadata: { account: a.name, statementDate: i.statementDate, transactions: cleared.length }, ip }, tx);
      return rec;
    });
  }

  async reopen(companyId: string, id: string, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const rec = await tx.reconciliation.findFirst({ where: { id, companyId } });
      if (!rec) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Reconciliation not found' });
      await tx.$queryRaw`SELECT id FROM "BankAccount" WHERE id = ${rec.bankAccountId}::uuid FOR UPDATE`;
      if (rec.status !== 'COMPLETED') throw new ConflictException({ code: 'NOT_COMPLETED', message: 'Already reopened' });
      const newer = await tx.reconciliation.findFirst({ where: { bankAccountId: rec.bankAccountId, status: 'COMPLETED', statementDate: { gt: rec.statementDate } } });
      if (newer) throw new ConflictException({ code: 'NOT_LATEST', message: `Reopen the later reconciliation (${isoOf(newer.statementDate)}) first; only the latest can be reopened` });
      await tx.bankTransaction.updateMany({ where: { reconciliationId: id }, data: { status: 'MATCHED', reconciliationId: null } });
      const u = await tx.reconciliation.update({ where: { id }, data: { status: 'REOPENED', reopenedAt: new Date(), reopenedById: actorId } });
      await this.audit.record({ action: 'reconciliation.reopened', companyId, actorId, entityType: 'Reconciliation', entityId: id, ip }, tx);
      return u;
    });
  }

  list(companyId: string, bankAccountId?: string) {
    return this.prisma.reconciliation.findMany({ where: { companyId, ...(bankAccountId ? { bankAccountId } : {}) }, orderBy: [{ statementDate: 'desc' }], take: 200, include: { bankAccount: { select: { name: true, kind: true } } } });
  }

  /** Historical review: what was cleared, what was still outstanding at the time. */
  async report(companyId: string, id: string) {
    const rec = await this.prisma.reconciliation.findFirst({ where: { id, companyId }, include: { bankAccount: true } });
    if (!rec) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Reconciliation not found' });
    const cleared = await this.prisma.bankTransaction.findMany({ where: { reconciliationId: id }, orderBy: [{ date: 'asc' }, { id: 'asc' }] });
    const outstanding = await this.outstandingLines(rec.bankAccount, rec.statementDate, rec.completedAt);
    const a = rec.bankAccount;
    const summary = reconSummary({ opening: rec.openingBalance.toString(), cleared: cleared.map((t) => t.amount.toString()), statementEnding: rec.statementBalance.toString() });
    return {
      reconciliation: { ...rec, bankAccount: undefined }, account: { id: a.id, name: a.name, kind: a.kind }, summary,
      printed: { opening: toPrinted(a, D(rec.openingBalance.toString())), statement: toPrinted(a, D(rec.statementBalance.toString())) },
      cleared: cleared.map((t) => ({ id: t.id, date: t.date, description: t.description, amount: t.amount.toString(), status: t.status })),
      outstandingLedgerItems: outstanding, outstandingNet: outstanding.reduce((s, l) => s.plus(l.amount), D(0)).toFixed(2),
      note: rec.status === 'REOPENED' ? 'This reconciliation was reopened; its transactions are no longer locked.' : null,
    };
  }
}
export { BadRequestException };
