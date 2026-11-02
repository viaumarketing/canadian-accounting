import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Prisma } from '@ca/database';
import { DocLine, paymentJournal, purchaseJournal, salesJournal } from '@ca/accounting-engine';
import { TaxLine, money } from '@ca/canadian-tax';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../accounting/ledger.service';
import { TaxService } from '../tax/tax.service';
import { isoOf, toDate } from '../accounting/setup';

type Tx = Prisma.TransactionClient;
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());

export interface RawLine { description: string; quantity: string; unitPrice: string; accountId: string; taxCodeId: string; itemId?: string; serviceDate?: string }
type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
export interface InvoiceInput {
  contactId: string; issueDate: string; dueDate: string; taxInclusive: boolean; kind: 'STANDARD' | 'CREDIT'; lines: RawLine[];
  terms?: string; billingAddress?: string; message?: string; memo?: string;
}

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly tax: TaxService, private readonly audit: AuditService) {}

  // ---------- shared helpers ----------

  /** Line accounts must belong to the company, be active, be the right type, and not be a control (role) account. */
  async checkAccounts(db: Tx | PrismaService, companyId: string, ids: string[], allowed: AccountType[]) {
    const uniq = [...new Set(ids)];
    const rows = await db.account.findMany({ where: { companyId, id: { in: uniq } } });
    if (rows.length !== uniq.length) throw new BadRequestException({ code: 'INVALID_ACCOUNT', message: 'Unknown account on a line' });
    for (const a of rows) {
      if (!a.isActive || a.role || !allowed.includes(a.type)) {
        throw new BadRequestException({ code: 'INVALID_ACCOUNT', message: `Account ${a.code} cannot be used on this document (needs an active ${allowed.join('/')} account that is not a control account)` });
      }
    }
  }

  async checkContact(db: Tx | PrismaService, companyId: string, contactId: string, role: 'CUSTOMER' | 'VENDOR') {
    const c = await db.contact.findFirst({ where: { id: contactId, companyId, isActive: true } });
    if (!c || (c.kind !== 'BOTH' && c.kind !== role)) throw new BadRequestException({ code: 'INVALID_CONTACT', message: `Contact must be an active ${role.toLowerCase()}` });
    return c;
  }

  async priceLines(db: Tx | PrismaService, companyId: string, date: string, inclusive: boolean, lines: RawLine[]) {
    const amounts = lines.map((l) => money(D(l.quantity).times(l.unitPrice)));
    const taxes = await this.tax.compute(db, companyId, date, inclusive, lines.map((l, i) => ({ amount: amounts[i], taxCodeId: l.taxCodeId })));
    const priced = lines.map((l, i) => ({
      lineNo: i + 1, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, accountId: l.accountId, taxCodeId: l.taxCodeId,
      net: taxes[i].net, taxDetail: taxes[i].taxes as unknown as Prisma.InputJsonValue, taxAmount: taxes[i].taxTotal,
    }));
    const subtotal = taxes.reduce((s, t) => s.plus(t.net), D(0));
    const taxTotal = taxes.reduce((s, t) => s.plus(t.taxTotal), D(0));
    return { priced, subtotal: subtotal.toFixed(2), taxTotal: taxTotal.toFixed(2), total: subtotal.plus(taxTotal).toFixed(2) };
  }

  docLines(lines: { accountId: string; net: Prisma.Decimal; taxDetail: Prisma.JsonValue; description: string }[]): DocLine[] {
    return lines.map((l) => ({ accountId: l.accountId, net: D(l.net).toFixed(2), taxes: l.taxDetail as unknown as TaxLine[], memo: l.description }));
  }

  private prefix = { invoice: ['INV', 'CN'], bill: ['BILL', 'VC'] } as const;
  private async docNumber(tx: Tx, companyId: string, type: 'invoice' | 'bill', kind: 'STANDARD' | 'CREDIT') {
    const seq = `${type}${kind === 'CREDIT' ? '_credit' : ''}`;
    const n = await this.ledger.nextNumber(tx, companyId, seq);
    return `${this.prefix[type][kind === 'CREDIT' ? 1 : 0]}-${String(n).padStart(4, '0')}`;
  }

  /** Product/service and service date on sales lines; the item must belong to the company and be active. */
  async salesLineExtras(db: Tx | PrismaService, companyId: string, lines: RawLine[]) {
    const ids = [...new Set(lines.map((l) => l.itemId).filter((x): x is string => !!x))];
    if (ids.length) {
      const n = await db.item.count({ where: { companyId, id: { in: ids }, isActive: true } });
      if (n !== ids.length) throw new BadRequestException({ code: 'INVALID_ITEM', message: 'Unknown or inactive product/service on a line' });
    }
    return lines.map((l) => ({ itemId: l.itemId ?? null, serviceDate: l.serviceDate ? toDate(l.serviceDate) : null }));
  }

  // ---------- invoices ----------

  async createInvoice(companyId: string, i: InvoiceInput, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const data = await this.invoiceData(tx, companyId, i);
      const inv = await tx.invoice.create({ data: { ...data, companyId, createdById: actorId }, include: { lines: true } });
      await this.audit.record({ action: 'invoice.created', companyId, actorId, entityType: 'Invoice', entityId: inv.id, ip }, tx);
      return inv;
    });
  }

  /** Drafts can be edited freely (lines are replaced); posted invoices are changed only by voiding. */
  async updateInvoice(companyId: string, id: string, i: InvoiceInput, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const cur = await tx.invoice.findFirst({ where: { id, companyId } });
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found' });
      if (cur.status !== 'DRAFT') throw new ConflictException({ code: 'NOT_DRAFT', message: 'Only draft invoices can be edited; void a posted invoice instead' });
      const data = await this.invoiceData(tx, companyId, i);
      await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
      const inv = await tx.invoice.update({ where: { id }, data, include: { lines: true } });
      await this.audit.record({ action: 'invoice.updated', companyId, actorId, entityType: 'Invoice', entityId: id, ip }, tx);
      return inv;
    });
  }

  private async invoiceData(tx: Tx, companyId: string, i: InvoiceInput) {
    await this.checkContact(tx, companyId, i.contactId, 'CUSTOMER');
    await this.checkAccounts(tx, companyId, i.lines.map((l) => l.accountId), ['REVENUE']);
    if (i.dueDate < i.issueDate) throw new BadRequestException({ code: 'INVALID_DUE_DATE', message: 'The due date cannot be before the invoice date' });
    const p = await this.priceLines(tx, companyId, i.issueDate, i.taxInclusive, i.lines);
    const extras = await this.salesLineExtras(tx, companyId, i.lines);
    return {
      contactId: i.contactId, kind: i.kind, issueDate: toDate(i.issueDate), dueDate: toDate(i.dueDate), taxInclusive: i.taxInclusive,
      terms: i.terms ?? null, billingAddress: i.billingAddress ?? null, message: i.message ?? null, memo: i.memo ?? null,
      subtotal: p.subtotal, taxTotal: p.taxTotal, total: p.total,
      lines: { create: p.priced.map((l, n) => ({ ...l, ...extras[n], companyId })) },
    };
  }

  async postInvoice(companyId: string, id: string, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const inv = await tx.invoice.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
      if (!inv) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found' });
      if (inv.status !== 'DRAFT') throw new ConflictException({ code: 'NOT_DRAFT', message: 'Invoice is already posted' });
      const roles = await this.ledger.roleAccounts(tx, companyId);
      if (!roles.receivableId) throw new UnprocessableEntityException({ code: 'NO_AR', message: 'No Accounts Receivable account is configured' });
      const number = await this.docNumber(tx, companyId, 'invoice', inv.kind);
      const lines = salesJournal({ lines: this.docLines(inv.lines), receivableId: roles.receivableId, contactId: inv.contactId, taxAccounts: roles.taxAccounts, credit: inv.kind === 'CREDIT', memo: number });
      const entry = await this.ledger.post(tx, { companyId, date: isoOf(inv.issueDate), memo: number, sourceType: inv.kind === 'CREDIT' ? 'credit_note' : 'invoice', sourceId: inv.id, lines, actorId, ip });
      const u = await tx.invoice.update({ where: { id }, data: { number, status: 'POSTED', journalEntryId: entry.id } });
      await this.audit.record({ action: 'invoice.posted', companyId, actorId, entityType: 'Invoice', entityId: id, metadata: { number, journal: entry.number }, ip }, tx);
      return u;
    });
  }

  async voidInvoice(companyId: string, id: string, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const inv = await tx.invoice.findFirst({ where: { id, companyId } });
      if (!inv) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found' });
      if (inv.status === 'DRAFT') { await tx.invoice.delete({ where: { id } }); return { id, status: 'DELETED' }; }
      if (inv.status !== 'POSTED' || !D(inv.amountPaid).isZero()) throw new ConflictException({ code: 'HAS_PAYMENTS', message: 'Only unpaid posted invoices can be voided; void the payments first' });
      await this.ledger.reverse(companyId, inv.journalEntryId!, actorId, { allowSourced: true, tx, memo: `Void ${inv.number}` }, ip);
      const u = await tx.invoice.update({ where: { id }, data: { status: 'VOID' } });
      await this.audit.record({ action: 'invoice.voided', companyId, actorId, entityType: 'Invoice', entityId: id, metadata: { number: inv.number }, ip }, tx);
      return u;
    });
  }

  listInvoices(companyId: string, status?: string) {
    return this.prisma.invoice.findMany({ where: { companyId, ...(status ? { status: status as 'DRAFT' } : {}) }, orderBy: { issueDate: 'desc' }, include: { contact: { select: { name: true } } }, take: 200 });
  }
  async getInvoice(companyId: string, id: string) {
    const i = await this.prisma.invoice.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } }, contact: true } });
    if (!i) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found' });
    return i;
  }

  // ---------- bills ----------

  async createBill(companyId: string, i: { contactId: string; issueDate: string; dueDate: string; taxInclusive: boolean; kind: 'STANDARD' | 'CREDIT'; supplierRef?: string; lines: RawLine[] }, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      await this.checkContact(tx, companyId, i.contactId, 'VENDOR');
      await this.checkAccounts(tx, companyId, i.lines.map((l) => l.accountId), ['EXPENSE', 'ASSET']);
      const p = await this.priceLines(tx, companyId, i.issueDate, i.taxInclusive, i.lines);
      const bill = await tx.bill.create({
        data: { companyId, contactId: i.contactId, kind: i.kind, supplierRef: i.supplierRef, issueDate: toDate(i.issueDate), dueDate: toDate(i.dueDate), taxInclusive: i.taxInclusive, subtotal: p.subtotal, taxTotal: p.taxTotal, total: p.total, createdById: actorId, lines: { create: p.priced.map((l) => ({ ...l, companyId })) } },
        include: { lines: true },
      });
      await this.audit.record({ action: 'bill.created', companyId, actorId, entityType: 'Bill', entityId: bill.id, ip }, tx);
      return bill;
    });
  }

  async postBill(companyId: string, id: string, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Bill" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const bill = await tx.bill.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
      if (!bill) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Bill not found' });
      if (bill.status !== 'DRAFT') throw new ConflictException({ code: 'NOT_DRAFT', message: 'Bill is already posted' });
      const roles = await this.ledger.roleAccounts(tx, companyId);
      if (!roles.payableId) throw new UnprocessableEntityException({ code: 'NO_AP', message: 'No Accounts Payable account is configured' });
      const number = await this.docNumber(tx, companyId, 'bill', bill.kind);
      const lines = purchaseJournal({ lines: this.docLines(bill.lines), counterAccountId: roles.payableId, contactId: bill.contactId, taxAccounts: roles.taxAccounts, credit: bill.kind === 'CREDIT', memo: number });
      const entry = await this.ledger.post(tx, { companyId, date: isoOf(bill.issueDate), memo: number, sourceType: bill.kind === 'CREDIT' ? 'vendor_credit' : 'bill', sourceId: bill.id, lines, actorId, ip });
      const u = await tx.bill.update({ where: { id }, data: { number, status: 'POSTED', journalEntryId: entry.id } });
      await this.audit.record({ action: 'bill.posted', companyId, actorId, entityType: 'Bill', entityId: id, metadata: { number, journal: entry.number }, ip }, tx);
      return u;
    });
  }

  async voidBill(companyId: string, id: string, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Bill" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const b = await tx.bill.findFirst({ where: { id, companyId } });
      if (!b) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Bill not found' });
      if (b.status === 'DRAFT') { await tx.bill.delete({ where: { id } }); return { id, status: 'DELETED' }; }
      if (b.status !== 'POSTED' || !D(b.amountPaid).isZero()) throw new ConflictException({ code: 'HAS_PAYMENTS', message: 'Only unpaid posted bills can be voided; void the payments first' });
      await this.ledger.reverse(companyId, b.journalEntryId!, actorId, { allowSourced: true, tx, memo: `Void ${b.number}` }, ip);
      const u = await tx.bill.update({ where: { id }, data: { status: 'VOID' } });
      await this.audit.record({ action: 'bill.voided', companyId, actorId, entityType: 'Bill', entityId: id, metadata: { number: b.number }, ip }, tx);
      return u;
    });
  }

  listBills(companyId: string, status?: string) {
    return this.prisma.bill.findMany({ where: { companyId, ...(status ? { status: status as 'DRAFT' } : {}) }, orderBy: { issueDate: 'desc' }, include: { contact: { select: { name: true } } }, take: 200 });
  }
  async getBill(companyId: string, id: string) {
    const b = await this.prisma.bill.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } }, contact: true } });
    if (!b) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Bill not found' });
    return b;
  }

  // ---------- payments ----------

  async createPayment(companyId: string, i: { direction: 'RECEIPT' | 'DISBURSEMENT'; contactId: string; bankAccountId: string; date: string; amount: string; reference?: string; allocations: { documentId: string; amount: string }[] }, actorId: string, ip: string | null, outerTx?: Tx) {
    const receipt = i.direction === 'RECEIPT';
    const run = async (tx: Tx) => {
      await this.checkContact(tx, companyId, i.contactId, receipt ? 'CUSTOMER' : 'VENDOR');
      const bank = await tx.account.findFirst({ where: { id: i.bankAccountId, companyId, isActive: true, role: null, type: { in: ['ASSET', 'LIABILITY'] } } });
      if (!bank) throw new BadRequestException({ code: 'INVALID_ACCOUNT', message: 'Pick an active bank or credit-card account (not a control account)' });

      const total = i.allocations.reduce((s, a) => s.plus(a.amount), D(0));
      if (!total.eq(i.amount)) throw new UnprocessableEntityException({ code: 'ALLOCATION_MISMATCH', message: `Allocations (${total.toFixed(2)}) must equal the payment amount (${D(i.amount).toFixed(2)}); unallocated payments are not supported yet` });
      const docIds = i.allocations.map((a) => a.documentId);
      if (new Set(docIds).size !== docIds.length) throw new BadRequestException({ code: 'DUPLICATE_ALLOCATION', message: 'A document appears twice in the allocations' });

      // Lock the documents so two concurrent payments cannot both consume the same balance.
      const table = receipt ? 'Invoice' : 'Bill';
      await tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE "companyId" = $1::uuid AND id = ANY($2::uuid[]) FOR UPDATE`, companyId, docIds);
      const docs = receipt
        ? await tx.invoice.findMany({ where: { companyId, id: { in: docIds } } })
        : await tx.bill.findMany({ where: { companyId, id: { in: docIds } } });
      if (docs.length !== docIds.length) throw new BadRequestException({ code: 'INVALID_DOCUMENT', message: 'Unknown document in allocations' });
      const byId = new Map(docs.map((d) => [d.id, d]));
      for (const a of i.allocations) {
        const d = byId.get(a.documentId)!;
        if (d.contactId !== i.contactId) throw new BadRequestException({ code: 'CONTACT_MISMATCH', message: `${d.number} belongs to a different contact` });
        if (d.kind !== 'STANDARD') throw new BadRequestException({ code: 'CREDIT_DOC', message: `${d.number} is a credit; applying credits is not supported yet` });
        if (d.status !== 'POSTED' && d.status !== 'PARTIAL') throw new ConflictException({ code: 'NOT_PAYABLE', message: `${d.number ?? 'Document'} is ${d.status.toLowerCase()} and cannot be paid` });
        const outstanding = D(d.total).minus(d.amountPaid);
        if (D(a.amount).gt(outstanding)) throw new UnprocessableEntityException({ code: 'OVER_ALLOCATION', message: `${d.number}: allocating ${D(a.amount).toFixed(2)} exceeds outstanding ${outstanding.toFixed(2)}` });
      }

      const roles = await this.ledger.roleAccounts(tx, companyId);
      const control = receipt ? roles.receivableId : roles.payableId;
      if (!control) throw new UnprocessableEntityException({ code: 'NO_CONTROL', message: 'Receivable/payable control account is missing' });
      const lines = paymentJournal({ direction: i.direction, amount: D(i.amount).toFixed(2), bankAccountId: bank.id, controlAccountId: control, contactId: i.contactId, memo: i.reference });
      const entry = await this.ledger.post(tx, { companyId, date: i.date, memo: i.reference ?? (receipt ? 'Customer receipt' : 'Supplier payment'), sourceType: 'payment', lines, actorId, ip });
      const pay = await tx.payment.create({
        data: { companyId, direction: i.direction, contactId: i.contactId, bankAccountId: bank.id, date: toDate(i.date), amount: D(i.amount).toFixed(2), reference: i.reference, journalEntryId: entry.id, createdById: actorId,
          allocations: { create: i.allocations.map((a) => ({ companyId, amount: a.amount, ...(receipt ? { invoiceId: a.documentId } : { billId: a.documentId }) })) } },
        include: { allocations: true },
      });
      for (const a of i.allocations) {
        const d = byId.get(a.documentId)!;
        const paid = D(d.amountPaid).plus(a.amount);
        const data = { amountPaid: paid.toFixed(2), status: paid.gte(d.total.toString()) ? ('PAID' as const) : ('PARTIAL' as const) };
        if (receipt) await tx.invoice.update({ where: { id: d.id }, data }); else await tx.bill.update({ where: { id: d.id }, data });
      }
      await this.audit.record({ action: 'payment.created', companyId, actorId, entityType: 'Payment', entityId: pay.id, metadata: { amount: i.amount, direction: i.direction }, ip }, tx);
      return pay;
    };
    return outerTx ? run(outerTx) : this.prisma.$transaction(run);
  }

  async voidPayment(companyId: string, id: string, actorId: string, ip: string | null, date?: string) {
    return this.prisma.$transaction(async (tx) => {
      const pay = await tx.payment.findFirst({ where: { id, companyId }, include: { allocations: true } });
      if (!pay) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment not found' });
      if (pay.voidedAt) throw new ConflictException({ code: 'ALREADY_VOIDED', message: 'Payment already voided' });
      const rev = await this.ledger.reverse(companyId, pay.journalEntryId, actorId, { allowSourced: true, tx, date, memo: `Void payment ${pay.reference ?? pay.id.slice(0, 8)}` }, ip);
      for (const a of pay.allocations) {
        const isInv = !!a.invoiceId;
        const docId = (a.invoiceId ?? a.billId)!;
        await tx.$queryRawUnsafe(`SELECT id FROM "${isInv ? 'Invoice' : 'Bill'}" WHERE id = $1::uuid FOR UPDATE`, docId);
        const doc = isInv ? await tx.invoice.findUniqueOrThrow({ where: { id: docId } }) : await tx.bill.findUniqueOrThrow({ where: { id: docId } });
        const paid = D(doc.amountPaid).minus(a.amount);
        const data = { amountPaid: paid.toFixed(2), status: paid.isZero() ? ('POSTED' as const) : ('PARTIAL' as const) };
        if (isInv) await tx.invoice.update({ where: { id: docId }, data }); else await tx.bill.update({ where: { id: docId }, data });
      }
      const u = await tx.payment.update({ where: { id }, data: { voidedAt: new Date(), voidEntryId: rev.id } });
      await this.audit.record({ action: 'payment.voided', companyId, actorId, entityType: 'Payment', entityId: id, ip }, tx);
      return u;
    });
  }

  listPayments(companyId: string) {
    return this.prisma.payment.findMany({ where: { companyId }, orderBy: { date: 'desc' }, include: { allocations: true, contact: { select: { name: true } } }, take: 200 });
  }

  // ---------- expenses (submit → approve → post; approver must differ from submitter) ----------

  async createExpense(companyId: string, i: { date: string; description: string; contactId?: string; paidFromAccountId: string; taxInclusive: boolean; lines: { description: string; amount: string; accountId: string; taxCodeId: string }[] }, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      if (i.contactId) await this.checkContact(tx, companyId, i.contactId, 'VENDOR');
      await this.checkAccounts(tx, companyId, i.lines.map((l) => l.accountId), ['EXPENSE', 'ASSET']);
      const paid = await tx.account.findFirst({ where: { id: i.paidFromAccountId, companyId, isActive: true, role: null, type: { in: ['ASSET', 'LIABILITY'] } } });
      if (!paid) throw new BadRequestException({ code: 'INVALID_ACCOUNT', message: 'Pick an active bank, card or reimbursement account to pay from' });
      const taxes = await this.tax.compute(tx, companyId, i.date, i.taxInclusive, i.lines.map((l) => ({ amount: l.amount, taxCodeId: l.taxCodeId })));
      const subtotal = taxes.reduce((s, t) => s.plus(t.net), D(0));
      const taxTotal = taxes.reduce((s, t) => s.plus(t.taxTotal), D(0));
      const e = await tx.expense.create({
        data: { companyId, contactId: i.contactId, date: toDate(i.date), description: i.description, paidFromAccountId: i.paidFromAccountId, taxInclusive: i.taxInclusive, subtotal: subtotal.toFixed(2), taxTotal: taxTotal.toFixed(2), total: subtotal.plus(taxTotal).toFixed(2), submittedById: actorId,
          lines: { create: i.lines.map((l, n) => ({ companyId, lineNo: n + 1, description: l.description, amount: l.amount, accountId: l.accountId, taxCodeId: l.taxCodeId, net: taxes[n].net, taxDetail: taxes[n].taxes as unknown as Prisma.InputJsonValue, taxAmount: taxes[n].taxTotal })) } },
        include: { lines: true },
      });
      await this.audit.record({ action: 'expense.submitted', companyId, actorId, entityType: 'Expense', entityId: e.id, ip }, tx);
      return e;
    });
  }

  listExpenses(companyId: string, onlyOwnBy?: string) {
    return this.prisma.expense.findMany({ where: { companyId, ...(onlyOwnBy ? { submittedById: onlyOwnBy } : {}) }, orderBy: { date: 'desc' }, include: { lines: true }, take: 200 });
  }

  async decideExpense(companyId: string, id: string, decision: 'approve' | 'reject', actorId: string, ip: string | null) {
    const e = await this.prisma.expense.findFirst({ where: { id, companyId } });
    if (!e) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Expense not found' });
    if (e.status !== 'SUBMITTED') throw new ConflictException({ code: 'NOT_SUBMITTED', message: `Expense is ${e.status.toLowerCase()}` });
    if (e.submittedById === actorId) throw new ForbiddenException({ code: 'SEPARATION_OF_DUTIES', message: 'You cannot approve your own expense' });
    const u = await this.prisma.expense.update({ where: { id }, data: { status: decision === 'approve' ? 'APPROVED' : 'REJECTED', decidedById: actorId } });
    await this.audit.record({ action: `expense.${decision}d`, companyId, actorId, entityType: 'Expense', entityId: id, ip });
    return u;
  }

  async postExpense(companyId: string, id: string, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Expense" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const e = await tx.expense.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
      if (!e) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Expense not found' });
      if (e.status !== 'APPROVED') throw new ConflictException({ code: 'NOT_APPROVED', message: 'Expense must be approved before posting' });
      const roles = await this.ledger.roleAccounts(tx, companyId);
      const lines = purchaseJournal({ lines: this.docLines(e.lines), counterAccountId: e.paidFromAccountId, contactId: e.contactId, taxAccounts: roles.taxAccounts, memo: e.description });
      const entry = await this.ledger.post(tx, { companyId, date: isoOf(e.date), memo: e.description, sourceType: 'expense', sourceId: e.id, lines, actorId, ip });
      const u = await tx.expense.update({ where: { id }, data: { status: 'POSTED', journalEntryId: entry.id } });
      await this.audit.record({ action: 'expense.posted', companyId, actorId, entityType: 'Expense', entityId: id, metadata: { journal: entry.number }, ip }, tx);
      return u;
    });
  }
}
