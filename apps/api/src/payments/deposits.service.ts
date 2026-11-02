import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { LineInput } from '@ca/accounting-engine';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../accounting/ledger.service';
import { isoOf, toDate } from '../accounting/setup';
import { ensureSpecialAccount } from '../accounting/special-accounts';

const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());

export interface DepositInput { date: string; bankAccountId: string; memo?: string; items: { type: 'payment' | 'sales_receipt'; id: string }[]; otherLines: { accountId: string; amount: string; description?: string; contactId?: string }[] }

/**
 * Bank deposits: customer payments and sales receipts waiting in Undeposited Funds (or Stripe clearing) are grouped into one
 * deposit, the way the money actually reaches the bank, so the bank feed matches one line instead of many. Other lines add
 * money (positive) or take out fees and charges (negative). One journal: Dr bank (total), Cr each holding account, Dr/Cr
 * the other lines' accounts.
 */
@Injectable()
export class DepositsService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly audit: AuditService) {}

  /** Money received but not yet deposited, grouped by the holding account it sits in. */
  async undeposited(companyId: string) {
    await ensureSpecialAccount(this.prisma, companyId, 'UNDEPOSITED_FUNDS');
    const holding = await this.prisma.account.findMany({ where: { companyId, special: { not: null } }, select: { id: true, code: true, name: true, special: true } });
    const ids = holding.map((h) => h.id);
    const [payments, receipts] = await Promise.all([
      this.prisma.payment.findMany({ where: { companyId, direction: 'RECEIPT', voidedAt: null, depositId: null, bankAccountId: { in: ids } }, include: { contact: { select: { name: true } } }, orderBy: { date: 'asc' } }),
      this.prisma.salesReceipt.findMany({ where: { companyId, status: 'PAID', depositId: null, depositAccountId: { in: ids } }, include: { contact: { select: { name: true } } }, orderBy: { date: 'asc' } }),
    ]);
    return {
      holdingAccounts: holding,
      items: [
        ...payments.map((p) => ({ type: 'payment' as const, id: p.id, date: isoOf(p.date), customer: p.contact.name, reference: p.reference, method: p.method, accountId: p.bankAccountId, amount: D(p.amount).toFixed(2) })),
        ...receipts.map((r) => ({ type: 'sales_receipt' as const, id: r.id, date: isoOf(r.date), customer: r.contact.name, reference: r.number, method: r.paymentMethod, accountId: r.depositAccountId, amount: D(r.total).toFixed(2) })),
      ].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  async create(companyId: string, i: DepositInput, actorId: string, ip: string | null) {
    if (!i.items.length && !i.otherLines.length) throw new BadRequestException({ code: 'EMPTY_DEPOSIT', message: 'Select at least one payment or add a line' });
    return this.prisma.$transaction(async (tx) => {
      const bank = await tx.account.findFirst({ where: { id: i.bankAccountId, companyId, isActive: true, type: 'ASSET', role: null, special: null } });
      if (!bank) throw new BadRequestException({ code: 'INVALID_ACCOUNT', message: 'Deposit to must be an active bank account' });
      const payIds = i.items.filter((x) => x.type === 'payment').map((x) => x.id);
      const recIds = i.items.filter((x) => x.type === 'sales_receipt').map((x) => x.id);
      if (new Set(payIds).size !== payIds.length || new Set(recIds).size !== recIds.length) throw new BadRequestException({ code: 'DUPLICATE_ITEM', message: 'An item is listed twice' });
      // Lock the items so two deposits can never take the same payment.
      if (payIds.length) await tx.$queryRawUnsafe(`SELECT id FROM "Payment" WHERE "companyId" = $1::uuid AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`, companyId, payIds);
      if (recIds.length) await tx.$queryRawUnsafe(`SELECT id FROM "SalesReceipt" WHERE "companyId" = $1::uuid AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`, companyId, recIds);
      const holding = new Set((await tx.account.findMany({ where: { companyId, special: { not: null } }, select: { id: true } })).map((a) => a.id));
      const payments = await tx.payment.findMany({ where: { companyId, id: { in: payIds } } });
      const receipts = await tx.salesReceipt.findMany({ where: { companyId, id: { in: recIds } } });
      if (payments.length !== payIds.length || receipts.length !== recIds.length) throw new BadRequestException({ code: 'INVALID_ITEM', message: 'Unknown payment or sales receipt' });
      for (const p of payments) if (p.direction !== 'RECEIPT' || p.voidedAt || p.depositId || !holding.has(p.bankAccountId)) throw new ConflictException({ code: 'NOT_UNDEPOSITED', message: `Payment ${p.reference ?? p.id.slice(0, 8)} is not waiting to be deposited` });
      for (const r of receipts) if (r.status !== 'PAID' || r.depositId || !holding.has(r.depositAccountId)) throw new ConflictException({ code: 'NOT_UNDEPOSITED', message: `Sales receipt ${r.number} is not waiting to be deposited` });
      const otherAccounts = await tx.account.findMany({ where: { companyId, id: { in: i.otherLines.map((l) => l.accountId) }, isActive: true } });
      if (new Set(i.otherLines.map((l) => l.accountId)).size !== otherAccounts.length) throw new BadRequestException({ code: 'INVALID_ACCOUNT', message: 'Unknown or inactive account on a line' });
      if (otherAccounts.some((a) => a.role || a.id === bank.id)) throw new BadRequestException({ code: 'INVALID_ACCOUNT', message: 'Other lines cannot use control accounts or the deposit account itself' });

      type L = { sourceType: string; sourceId: string | null; accountId: string; contactId: string | null; description: string | null; amount: Decimal };
      const lines: L[] = [
        ...payments.map((p) => ({ sourceType: 'payment', sourceId: p.id, accountId: p.bankAccountId, contactId: p.contactId, description: p.reference, amount: D(p.amount) })),
        ...receipts.map((r) => ({ sourceType: 'sales_receipt', sourceId: r.id, accountId: r.depositAccountId, contactId: r.contactId, description: r.number, amount: D(r.total) })),
        ...i.otherLines.map((l) => ({ sourceType: 'other', sourceId: null, accountId: l.accountId, contactId: l.contactId ?? null, description: l.description ?? null, amount: D(l.amount) })),
      ];
      if (lines.some((l) => l.amount.isZero())) throw new BadRequestException({ code: 'ZERO_LINE', message: 'A line has no amount' });
      const total = lines.reduce((a, l) => a.plus(l.amount), D(0));
      if (total.lte(0)) throw new UnprocessableEntityException({ code: 'NEGATIVE_DEPOSIT', message: `The deposit total must be positive (it is ${total.toFixed(2)})` });

      const memo = i.memo || `Deposit ${i.date}`;
      const journal: LineInput[] = [{ accountId: bank.id, debit: total.toFixed(2), credit: '0.00', memo }];
      for (const l of lines) journal.push({ accountId: l.accountId, debit: l.amount.isNegative() ? l.amount.abs().toFixed(2) : '0.00', credit: l.amount.isNegative() ? '0.00' : l.amount.toFixed(2), memo: l.description ?? memo, contactId: l.contactId });
      const depId = randomUUID();
      const entry = await this.ledger.post(tx, { companyId, date: i.date, memo, sourceType: 'deposit', sourceId: depId, lines: journal, actorId, ip });
      const dep = await tx.deposit.create({ data: { id: depId, companyId, date: toDate(i.date), bankAccountId: bank.id, memo: i.memo ?? null, total: total.toFixed(2), journalEntryId: entry.id, createdById: actorId, lines: { create: lines.map((l, n) => ({ companyId, lineNo: n + 1, sourceType: l.sourceType, sourceId: l.sourceId, accountId: l.accountId, contactId: l.contactId, description: l.description, amount: l.amount.toFixed(2) })) } } });
      if (payIds.length) await tx.payment.updateMany({ where: { id: { in: payIds } }, data: { depositId: dep.id } });
      if (recIds.length) await tx.salesReceipt.updateMany({ where: { id: { in: recIds } }, data: { depositId: dep.id } });
      await this.audit.record({ action: 'deposit.created', companyId, actorId, entityType: 'Deposit', entityId: dep.id, metadata: { total: total.toFixed(2), items: i.items.length, journal: entry.number }, ip }, tx);
      return this.get(companyId, dep.id, tx);
    });
  }

  async void(companyId: string, id: string, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Deposit" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const d = await tx.deposit.findFirst({ where: { id, companyId } });
      if (!d) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Deposit not found' });
      if (d.voidedAt) throw new ConflictException({ code: 'ALREADY_VOIDED', message: 'Deposit already voided' });
      const lineIds = (await tx.journalLine.findMany({ where: { entryId: d.journalEntryId }, select: { id: true } })).map((l) => l.id);
      if (await tx.bankTransaction.findFirst({ where: { companyId, matchedLineId: { in: lineIds } } })) throw new ConflictException({ code: 'MATCHED', message: 'This deposit is matched to a bank transaction; unmatch it in Banking first' });
      await this.ledger.reverse(companyId, d.journalEntryId, actorId, { allowSourced: true, tx, memo: `Void deposit ${isoOf(d.date)}` }, ip);
      await tx.payment.updateMany({ where: { companyId, depositId: id }, data: { depositId: null } });
      await tx.salesReceipt.updateMany({ where: { companyId, depositId: id }, data: { depositId: null } });
      const u = await tx.deposit.update({ where: { id }, data: { voidedAt: new Date() } });
      await this.audit.record({ action: 'deposit.voided', companyId, actorId, entityType: 'Deposit', entityId: id, ip }, tx);
      return u;
    });
  }

  list(companyId: string) {
    return this.prisma.deposit.findMany({ where: { companyId }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 200, include: { _count: { select: { lines: true } } } });
  }

  async get(companyId: string, id: string, db: Pick<PrismaService, 'deposit'> = this.prisma) {
    const d = await db.deposit.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    if (!d) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Deposit not found' });
    return d;
  }
}
