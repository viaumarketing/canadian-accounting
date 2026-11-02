import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Prisma } from '@ca/database';
import { salesJournal } from '@ca/accounting-engine';
import { roleHasPermission, type CompanyRole } from '@ca/shared';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../accounting/ledger.service';
import { isoOf, toDate } from '../accounting/setup';
import { documentPdf, type SalesDocument } from '@ca/reporting';
import { BillingService, type RawLine } from './billing.service';

type Tx = Prisma.TransactionClient;
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const DAY = 86_400_000;

export interface SalesReceiptInput {
  contactId: string; date: string; paymentMethod: 'CASH' | 'CHEQUE' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'E_TRANSFER' | 'OTHER';
  referenceNo?: string; depositAccountId: string; taxInclusive: boolean; lines: RawLine[];
  billingAddress?: string; message?: string; memo?: string; post: boolean;
}
export interface ItemInput { name: string; sku?: string | null; type?: 'SERVICE' | 'NON_INVENTORY'; description?: string | null; rate?: string | null; incomeAccountId: string; taxCodeId?: string | null }

/** Sales receipts, products & services, and the combined "All sales" view with its money bar. */
@Injectable()
export class SalesService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly billing: BillingService, private readonly audit: AuditService) {}

  // ================================================================ sales receipts

  /** Money from a sales receipt goes straight into a bank or cash account (an active asset account that is not a control account). */
  private async checkDeposit(db: Tx | PrismaService, companyId: string, id: string) {
    const a = await db.account.findFirst({ where: { id, companyId } });
    if (!a || !a.isActive || a.type !== 'ASSET' || a.role) throw new BadRequestException({ code: 'INVALID_DEPOSIT_ACCOUNT', message: 'Deposit to must be an active bank or cash account' });
  }

  private async receiptData(tx: Tx, companyId: string, i: SalesReceiptInput) {
    await this.billing.checkContact(tx, companyId, i.contactId, 'CUSTOMER');
    await this.billing.checkAccounts(tx, companyId, i.lines.map((l) => l.accountId), ['REVENUE']);
    await this.checkDeposit(tx, companyId, i.depositAccountId);
    const p = await this.billing.priceLines(tx, companyId, i.date, i.taxInclusive, i.lines);
    const extras = await this.billing.salesLineExtras(tx, companyId, i.lines);
    return {
      contactId: i.contactId, date: toDate(i.date), paymentMethod: i.paymentMethod, referenceNo: i.referenceNo ?? null, depositAccountId: i.depositAccountId,
      taxInclusive: i.taxInclusive, billingAddress: i.billingAddress ?? null, message: i.message ?? null, memo: i.memo ?? null,
      subtotal: p.subtotal, taxTotal: p.taxTotal, total: p.total,
      lines: { create: p.priced.map((l, n) => ({ ...l, ...extras[n], companyId })) },
    };
  }

  async createReceipt(companyId: string, i: SalesReceiptInput, actorId: string, role: CompanyRole, ip: string | null) {
    if (i.post && !roleHasPermission(role, 'sales:post')) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Missing permission sales:post; save as a draft instead' });
    const r = await this.prisma.$transaction(async (tx) => {
      const data = await this.receiptData(tx, companyId, i);
      const rec = await tx.salesReceipt.create({ data: { ...data, companyId, createdById: actorId } });
      await this.audit.record({ action: 'sales_receipt.created', companyId, actorId, entityType: 'SalesReceipt', entityId: rec.id, ip }, tx);
      return rec;
    });
    return i.post ? this.postReceipt(companyId, r.id, actorId, ip) : r;
  }

  async updateReceipt(companyId: string, id: string, i: SalesReceiptInput, actorId: string, role: CompanyRole, ip: string | null) {
    if (i.post && !roleHasPermission(role, 'sales:post')) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Missing permission sales:post; save as a draft instead' });
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "SalesReceipt" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const cur = await tx.salesReceipt.findFirst({ where: { id, companyId } });
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sales receipt not found' });
      if (cur.status !== 'DRAFT') throw new ConflictException({ code: 'NOT_DRAFT', message: 'Only draft sales receipts can be edited; void a posted one instead' });
      const data = await this.receiptData(tx, companyId, i);
      await tx.salesReceiptLine.deleteMany({ where: { receiptId: id } });
      await tx.salesReceipt.update({ where: { id }, data });
      await this.audit.record({ action: 'sales_receipt.updated', companyId, actorId, entityType: 'SalesReceipt', entityId: id, ip }, tx);
    });
    return i.post ? this.postReceipt(companyId, id, actorId, ip) : this.getReceipt(companyId, id);
  }

  /** Posts Dr deposit account / Cr revenue / Cr sales taxes through the ledger, and numbers the receipt SR-0001, SR-0002, … */
  async postReceipt(companyId: string, id: string, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "SalesReceipt" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const r = await tx.salesReceipt.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
      if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sales receipt not found' });
      if (r.status !== 'DRAFT') throw new ConflictException({ code: 'NOT_DRAFT', message: 'Sales receipt is already posted' });
      await this.checkDeposit(tx, companyId, r.depositAccountId);
      const roles = await this.ledger.roleAccounts(tx, companyId);
      const number = `SR-${String(await this.ledger.nextNumber(tx, companyId, 'sales_receipt')).padStart(4, '0')}`;
      const lines = salesJournal({ lines: this.billing.docLines(r.lines), receivableId: r.depositAccountId, contactId: r.contactId, taxAccounts: roles.taxAccounts, memo: number });
      const entry = await this.ledger.post(tx, { companyId, date: isoOf(r.date), memo: number, sourceType: 'sales_receipt', sourceId: r.id, lines, actorId, ip });
      const u = await tx.salesReceipt.update({ where: { id }, data: { number, status: 'PAID', journalEntryId: entry.id } });
      await this.audit.record({ action: 'sales_receipt.posted', companyId, actorId, entityType: 'SalesReceipt', entityId: id, metadata: { number, journal: entry.number }, ip }, tx);
      return u;
    });
  }

  async voidReceipt(companyId: string, id: string, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "SalesReceipt" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const r = await tx.salesReceipt.findFirst({ where: { id, companyId } });
      if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sales receipt not found' });
      if (r.status === 'DRAFT') { await tx.salesReceipt.delete({ where: { id } }); return { id, status: 'DELETED' }; }
      if (r.status === 'VOID') throw new ConflictException({ code: 'ALREADY_VOID', message: 'Sales receipt is already void' });
      const lineIds = (await tx.journalLine.findMany({ where: { entryId: r.journalEntryId! }, select: { id: true } })).map((l) => l.id);
      const matched = await tx.bankTransaction.findFirst({ where: { companyId, matchedLineId: { in: lineIds } } });
      if (matched) throw new ConflictException({ code: 'MATCHED', message: 'This receipt is matched to a bank transaction; unmatch it in Banking first' });
      await this.ledger.reverse(companyId, r.journalEntryId!, actorId, { allowSourced: true, tx, memo: `Void ${r.number}` }, ip);
      const u = await tx.salesReceipt.update({ where: { id }, data: { status: 'VOID' } });
      await this.audit.record({ action: 'sales_receipt.voided', companyId, actorId, entityType: 'SalesReceipt', entityId: id, metadata: { number: r.number }, ip }, tx);
      return u;
    });
  }

  listReceipts(companyId: string) {
    return this.prisma.salesReceipt.findMany({ where: { companyId }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], include: { contact: { select: { name: true } } }, take: 200 });
  }

  async getReceipt(companyId: string, id: string) {
    const r = await this.prisma.salesReceipt.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } }, contact: true, depositAccount: { select: { id: true, code: true, name: true } } } });
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sales receipt not found' });
    return r;
  }

  // ================================================================ products & services

  listItems(companyId: string, includeInactive = false) {
    return this.prisma.item.findMany({ where: { companyId, ...(includeInactive ? {} : { isActive: true }) }, orderBy: { name: 'asc' }, include: { incomeAccount: { select: { code: true, name: true } }, taxCode: { select: { code: true, name: true } } } });
  }

  private async checkItemRefs(companyId: string, i: { incomeAccountId?: string; taxCodeId?: string | null }) {
    if (i.incomeAccountId) await this.billing.checkAccounts(this.prisma, companyId, [i.incomeAccountId], ['REVENUE']);
    if (i.taxCodeId && !(await this.prisma.taxCode.findFirst({ where: { id: i.taxCodeId, companyId } }))) throw new BadRequestException({ code: 'INVALID_TAX_CODE', message: 'Unknown tax code' });
  }

  async createItem(companyId: string, i: ItemInput, actorId: string, ip: string | null) {
    await this.checkItemRefs(companyId, i);
    try {
      const it = await this.prisma.item.create({ data: { companyId, name: i.name, sku: i.sku ?? null, type: i.type ?? 'SERVICE', description: i.description ?? null, rate: i.rate ?? null, incomeAccountId: i.incomeAccountId, taxCodeId: i.taxCodeId ?? null } });
      await this.audit.record({ action: 'item.created', companyId, actorId, entityType: 'Item', entityId: it.id, metadata: { name: it.name }, ip });
      return it;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'DUPLICATE', message: 'A product or service with that name already exists' });
      throw e;
    }
  }

  async updateItem(companyId: string, id: string, i: Partial<ItemInput> & { isActive?: boolean }, actorId: string, ip: string | null) {
    const cur = await this.prisma.item.findFirst({ where: { id, companyId } });
    if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Product or service not found' });
    await this.checkItemRefs(companyId, i);
    try {
      const it = await this.prisma.item.update({ where: { id }, data: i });
      await this.audit.record({ action: 'item.updated', companyId, actorId, entityType: 'Item', entityId: id, metadata: i as Prisma.InputJsonObject, ip });
      return it;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'DUPLICATE', message: 'A product or service with that name already exists' });
      throw e;
    }
  }

  // ================================================================ all sales + money bar

  /**
   * Invoices, credit notes, sales receipts and customer payments in one list (newest first), each with its open balance and a
   * status in plain words (Draft, Due in 5 days, Overdue 12 days, Partially paid, Paid, Closed, Voided).
   */
  async allSales(companyId: string, q: { type?: string; status?: 'open' | 'overdue' | 'paid'; contactId?: string; from?: string; to?: string }) {
    const today = toDate(isoOf(new Date()));
    const range = q.from || q.to ? { ...(q.from ? { gte: toDate(q.from) } : {}), ...(q.to ? { lte: toDate(q.to) } : {}) } : undefined;
    const want = (t: string) => !q.type || q.type === t;
    const contact = q.contactId ? { contactId: q.contactId } : {};
    const [invoices, receipts, payments] = await Promise.all([
      want('invoice') || want('credit_note') ? this.prisma.invoice.findMany({ where: { companyId, ...contact, ...(range ? { issueDate: range } : {}), ...(q.type === 'invoice' ? { kind: 'STANDARD' } : q.type === 'credit_note' ? { kind: 'CREDIT' } : {}) }, include: { contact: { select: { name: true } } }, orderBy: { issueDate: 'desc' }, take: 500 }) : [],
      want('sales_receipt') ? this.prisma.salesReceipt.findMany({ where: { companyId, ...contact, ...(range ? { date: range } : {}) }, include: { contact: { select: { name: true } } }, orderBy: { date: 'desc' }, take: 500 }) : [],
      want('payment') ? this.prisma.payment.findMany({ where: { companyId, direction: 'RECEIPT', ...contact, ...(range ? { date: range } : {}) }, include: { contact: { select: { name: true } } }, orderBy: { date: 'desc' }, take: 500 }) : [],
    ]);
    type Row = { id: string; type: 'invoice' | 'credit_note' | 'sales_receipt' | 'payment'; date: string; number: string | null; customer: string; contactId: string; dueDate: string | null; total: string; balance: string; status: string; state: 'draft' | 'open' | 'overdue' | 'paid' | 'void' };
    const rows: Row[] = [];
    for (const i of invoices) {
      const balance = D(i.total).minus(i.amountPaid);
      const days = Math.round((today.getTime() - i.dueDate.getTime()) / DAY);
      let status: string; let state: Row['state'];
      if (i.status === 'DRAFT') { status = 'Draft'; state = 'draft'; }
      else if (i.status === 'VOID') { status = 'Voided'; state = 'void'; }
      else if (i.kind === 'CREDIT') { status = i.status === 'PAID' ? 'Applied' : 'Unapplied'; state = i.status === 'PAID' ? 'paid' : 'open'; }
      else if (i.status === 'PAID' || balance.lte(0)) { status = 'Paid'; state = 'paid'; }
      else if (days > 0) { status = `Overdue ${days} day${days === 1 ? '' : 's'}`; state = 'overdue'; }
      else { status = i.status === 'PARTIAL' ? 'Partially paid' : days === 0 ? 'Due today' : `Due in ${-days} day${days === -1 ? '' : 's'}`; state = 'open'; }
      rows.push({ id: i.id, type: i.kind === 'CREDIT' ? 'credit_note' : 'invoice', date: isoOf(i.issueDate), number: i.number, customer: i.contact.name, contactId: i.contactId, dueDate: i.kind === 'CREDIT' ? null : isoOf(i.dueDate), total: D(i.total).toFixed(2), balance: ['DRAFT', 'VOID'].includes(i.status) ? '0.00' : balance.toFixed(2), status, state });
    }
    for (const r of receipts) rows.push({ id: r.id, type: 'sales_receipt', date: isoOf(r.date), number: r.number, customer: r.contact.name, contactId: r.contactId, dueDate: null, total: D(r.total).toFixed(2), balance: '0.00', status: r.status === 'DRAFT' ? 'Draft' : r.status === 'VOID' ? 'Voided' : 'Paid', state: r.status === 'DRAFT' ? 'draft' : r.status === 'VOID' ? 'void' : 'paid' });
    for (const p of payments) rows.push({ id: p.id, type: 'payment', date: isoOf(p.date), number: p.reference, customer: p.contact.name, contactId: p.contactId, dueDate: null, total: D(p.amount).toFixed(2), balance: '0.00', status: p.voidedAt ? 'Voided' : 'Closed', state: p.voidedAt ? 'void' : 'paid' });
    const filtered = q.status ? rows.filter((r) => (q.status === 'open' ? r.state === 'open' || r.state === 'overdue' : r.state === q.status)) : rows;
    return filtered.sort((a, b) => (a.date === b.date ? (b.number ?? '').localeCompare(a.number ?? '') : b.date.localeCompare(a.date)));
  }

  /** The money bar: what customers owe (overdue / not due yet) and what came in over the last 30 days. */
  async moneyBar(companyId: string) {
    const today = toDate(isoOf(new Date()));
    const since = new Date(today.getTime() - 30 * DAY);
    const open = await this.prisma.invoice.findMany({ where: { companyId, kind: 'STANDARD', status: { in: ['POSTED', 'PARTIAL'] } }, select: { total: true, amountPaid: true, dueDate: true } });
    let overdue = D(0), notDue = D(0), overdueCount = 0, notDueCount = 0;
    for (const i of open) {
      const bal = D(i.total).minus(i.amountPaid);
      if (bal.lte(0)) continue;
      if (i.dueDate < today) { overdue = overdue.plus(bal); overdueCount++; } else { notDue = notDue.plus(bal); notDueCount++; }
    }
    const [paid, receipts] = await Promise.all([
      this.prisma.payment.aggregate({ where: { companyId, direction: 'RECEIPT', voidedAt: null, date: { gte: since } }, _sum: { amount: true }, _count: true }),
      this.prisma.salesReceipt.aggregate({ where: { companyId, status: 'PAID', date: { gte: since } }, _sum: { total: true }, _count: true }),
    ]);
    return {
      unpaid: { overdue: overdue.toFixed(2), overdueCount, notDueYet: notDue.toFixed(2), notDueYetCount: notDueCount },
      paidLast30Days: { amount: D(paid._sum.amount ?? 0).plus(D(receipts._sum.total ?? 0)).toFixed(2), count: paid._count + receipts._count },
    };
  }

  /** Open balance per customer (posted invoices less payments and credit notes), for the Customers list. */
  async customerBalances(companyId: string) {
    const rows = await this.prisma.invoice.groupBy({ by: ['contactId', 'kind'], where: { companyId, status: { in: ['POSTED', 'PARTIAL'] } }, _sum: { total: true, amountPaid: true } });
    const out = new Map<string, Decimal>();
    for (const r of rows) {
      const bal = D(r._sum.total ?? 0).minus(D(r._sum.amountPaid ?? 0));
      out.set(r.contactId, (out.get(r.contactId) ?? D(0)).plus(r.kind === 'CREDIT' ? bal.neg() : bal));
    }
    return Object.fromEntries([...out].map(([k, v]) => [k, v.toFixed(2)]));
  }

  // ================================================================ printable documents

  /** Customer-facing PDF of an invoice / credit note or a sales receipt. */
  async documentPdf(companyId: string, type: 'invoice' | 'sales_receipt', id: string): Promise<{ filename: string; pdf: Buffer }> {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const doc = type === 'invoice'
      ? await this.prisma.invoice.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' }, include: { taxCode: { select: { code: true } } } }, contact: true } })
      : await this.prisma.salesReceipt.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' }, include: { taxCode: { select: { code: true } } } }, contact: true } });
    if (!doc) throw new NotFoundException({ code: 'NOT_FOUND', message: type === 'invoice' ? 'Invoice not found' : 'Sales receipt not found' });
    const date = 'issueDate' in doc ? doc.issueDate : doc.date;
    const regs = await this.prisma.taxRegistration.findMany({ where: { companyId, effectiveFrom: { lte: date }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }] } });
    const itemIds = [...new Set(doc.lines.map((l) => l.itemId).filter((x): x is string => !!x))];
    const items = new Map((itemIds.length ? await this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true } }) : []).map((i) => [i.id, i.name]));
    // Tax shown by component and rate (e.g. "HST ON 13%"), as Canadian invoices are expected to show it.
    const taxes = new Map<string, Decimal>();
    for (const l of doc.lines) for (const t of l.taxDetail as { component: string; rate: string; amount: string }[]) {
      const label = `${t.component} ${D(t.rate).times(100).toDecimalPlaces(3).toString()}%`;
      taxes.set(label, (taxes.get(label) ?? D(0)).plus(t.amount));
    }
    const TERMS: Record<string, string> = { DUE_ON_RECEIPT: 'Due on receipt', NET_15: 'Net 15', NET_30: 'Net 30', NET_60: 'Net 60' };
    const METHODS: Record<string, string> = { CASH: 'Cash', CHEQUE: 'Cheque', CREDIT_CARD: 'Credit card', DEBIT_CARD: 'Debit card', E_TRANSFER: 'Interac e-Transfer', OTHER: 'Other' };
    const number = doc.number ?? 'DRAFT';
    const base: Omit<SalesDocument, 'title' | 'details' | 'paid' | 'balanceDue'> = {
      currency: doc.currency,
      watermark: doc.status === 'DRAFT' ? 'DRAFT' : doc.status === 'VOID' ? 'VOID' : undefined,
      company: {
        name: company.operatingName || company.legalName, legalName: company.legalName, address: company.address, phone: company.phone, email: company.email,
        registrations: regs.map((r) => `${r.kind === 'GST_HST' ? 'GST/HST' : r.kind === 'QST' ? 'QST' : 'PST'} registration no. ${r.registrationNumber}`),
      },
      number,
      billTo: { name: doc.contact.name, address: doc.billingAddress ?? doc.contact.billingAddress, email: doc.contact.email },
      lines: doc.lines.map((l) => ({ serviceDate: l.serviceDate ? isoOf(l.serviceDate) : null, product: l.itemId ? items.get(l.itemId) ?? null : null, description: l.description, quantity: D(l.quantity).toString(), rate: D(l.unitPrice).toFixed(2), amount: D(l.quantity).times(l.unitPrice).toFixed(2), taxCode: l.taxCode.code })),
      subtotal: D(doc.subtotal).toFixed(2),
      taxes: [...taxes].map(([label, amount]) => ({ label, amount: amount.toFixed(2) })),
      total: D(doc.total).toFixed(2),
      message: doc.message,
    };
    let full: SalesDocument;
    if ('issueDate' in doc) {
      const credit = doc.kind === 'CREDIT';
      full = { ...base, title: credit ? 'CREDIT NOTE' : 'INVOICE', details: credit ? [['Date', isoOf(doc.issueDate)]] : [['Date', isoOf(doc.issueDate)], ['Due date', isoOf(doc.dueDate)], ...(doc.terms ? [['Terms', TERMS[doc.terms] ?? doc.terms] as [string, string]] : [])], ...(credit ? {} : { paid: D(doc.amountPaid).toFixed(2), balanceDue: doc.status === 'VOID' ? '0.00' : D(doc.total).minus(doc.amountPaid).toFixed(2) }) };
    } else {
      full = { ...base, title: 'SALES RECEIPT', details: [['Date', isoOf(doc.date)], ['Payment method', METHODS[doc.paymentMethod]], ...(doc.referenceNo ? [['Reference no.', doc.referenceNo] as [string, string]] : [])], paid: D(doc.total).toFixed(2) };
    }
    // Prices entered tax-included: lines show the pre-tax amount so subtotal + tax = total on the page.
    if (doc.taxInclusive) full.lines = doc.lines.map((l, i) => ({ ...full.lines[i], rate: D(l.net).div(D(l.quantity).isZero() ? 1 : l.quantity).toFixed(2), amount: D(l.net).toFixed(2) }));
    return { filename: `${full.title === 'SALES RECEIPT' ? 'sales-receipt' : full.title === 'CREDIT NOTE' ? 'credit-note' : 'invoice'}-${number}.pdf`, pdf: await documentPdf(full) };
  }
}
