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
import { InventoryService, type StockChange } from '../inventory/inventory.service';

type Tx = Prisma.TransactionClient;
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());

export interface RawLine {
  description: string; quantity: string; unitPrice: string; accountId: string; taxCodeId: string; itemId?: string; serviceDate?: string;
  classId?: string; projectId?: string;
  /** Invoices: the billable time or cost this line bills */
  sourceRef?: { type: 'time' | 'bill_line' | 'expense_line'; id: string };
  /** Bills: cost to re-invoice to a customer */
  billable?: boolean; billableToId?: string;
}
type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
export interface InvoiceInput {
  contactId: string; issueDate: string; dueDate: string; taxInclusive: boolean; kind: 'STANDARD' | 'CREDIT'; lines: RawLine[];
  terms?: string; billingAddress?: string; message?: string; memo?: string; locationId?: string;
}
export interface BillInput { contactId: string; issueDate: string; dueDate: string; taxInclusive: boolean; kind: 'STANDARD' | 'CREDIT'; supplierRef?: string; memo?: string; locationId?: string; lines: RawLine[] }
export interface ExpenseInput { date: string; description: string; contactId?: string; paidFromAccountId: string; taxInclusive: boolean; locationId?: string; lines: { description: string; amount: string; accountId: string; taxCodeId: string; classId?: string; projectId?: string; billable?: boolean; billableToId?: string }[] }

/** Lines as stored, with what the posting engine and inventory need. */
type StoredLine = { id: string; accountId: string; net: Prisma.Decimal; taxDetail: Prisma.JsonValue; description: string; quantity?: Prisma.Decimal; itemId?: string | null; classId?: string | null; projectId?: string | null };

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly tax: TaxService, private readonly audit: AuditService, private readonly inventory: InventoryService) {}

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

  docLines(lines: { accountId: string; net: Prisma.Decimal; taxDetail: Prisma.JsonValue; description: string; classId?: string | null; projectId?: string | null }[]): DocLine[] {
    return lines.map((l) => ({ accountId: l.accountId, net: D(l.net).toFixed(2), taxes: l.taxDetail as unknown as TaxLine[], memo: l.description, classId: l.classId ?? null, projectId: l.projectId ?? null }));
  }

  /** Classes, projects and the location must belong to the company (and be active, for classes and locations). */
  async checkDims(db: Tx | PrismaService, companyId: string, lines: { classId?: string; projectId?: string }[], locationId?: string) {
    const classIds = [...new Set(lines.map((l) => l.classId).filter((x): x is string => !!x))];
    const projectIds = [...new Set(lines.map((l) => l.projectId).filter((x): x is string => !!x))];
    if (classIds.length && (await db.trackingClass.count({ where: { companyId, id: { in: classIds }, isActive: true } })) !== classIds.length) throw new BadRequestException({ code: 'INVALID_CLASS', message: 'Unknown or inactive class on a line' });
    if (projectIds.length && (await db.project.count({ where: { companyId, id: { in: projectIds } } })) !== projectIds.length) throw new BadRequestException({ code: 'INVALID_PROJECT', message: 'Unknown project on a line' });
    if (locationId && !(await db.location.findFirst({ where: { id: locationId, companyId, isActive: true } }))) throw new BadRequestException({ code: 'INVALID_LOCATION', message: 'Unknown or inactive location' });
  }

  /** Stock moved by a sale (out at average cost) or a credit note (back in at average cost), and the COGS journal lines. */
  async saleInventory(tx: Tx, companyId: string, lines: StoredLine[], credit: boolean, contactId: string, memo: string) {
    const changes: StockChange[] = lines.filter((l) => l.itemId && l.quantity).map((l) => ({ itemId: l.itemId!, qty: credit ? D(l.quantity!) : D(l.quantity!).neg(), lineId: l.id, memo }));
    const planned = changes.length ? await this.inventory.plan(tx, companyId, changes) : [];
    return { planned, journal: this.inventory.cogsLines(planned, contactId, memo) };
  }

  /** Stock moved by a bill (in at cost: net plus any non-recoverable tax) or a supplier credit (out at the credited cost). */
  async purchaseInventory(tx: Tx, companyId: string, lines: StoredLine[], credit: boolean, memo: string) {
    const changes: StockChange[] = lines.filter((l) => l.itemId && l.quantity).map((l) => {
      const cost = (l.taxDetail as unknown as TaxLine[]).filter((t) => !t.recoverable).reduce((a, t) => a.plus(t.amount), D(l.net));
      return { itemId: l.itemId!, qty: credit ? D(l.quantity!).neg() : D(l.quantity!), value: credit ? cost.neg() : cost, lineId: l.id, memo };
    });
    return changes.length ? this.inventory.plan(tx, companyId, changes) : [];
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
    await this.checkDims(db, companyId, lines);
    return lines.map((l) => ({ itemId: l.itemId ?? null, serviceDate: l.serviceDate ? toDate(l.serviceDate) : null, classId: l.classId ?? null, projectId: l.projectId ?? null }));
  }

  // ---------- billable time and costs on invoices ----------

  /** Detach billable time and costs from these invoice lines (lines replaced, invoice voided or deleted). */
  async unlinkSources(tx: Tx, companyId: string, lineIds: string[]) {
    if (!lineIds.length) return;
    await tx.timeEntry.updateMany({ where: { companyId, invoiceLineId: { in: lineIds } }, data: { invoiceLineId: null } });
    await tx.billLine.updateMany({ where: { companyId, invoiceLineId: { in: lineIds } }, data: { invoiceLineId: null } });
    await tx.expenseLine.updateMany({ where: { companyId, invoiceLineId: { in: lineIds } }, data: { invoiceLineId: null } });
  }

  /** Mark the billable time and costs an invoice's lines bill, so they are never billed twice. */
  private async linkSources(tx: Tx, companyId: string, contactId: string, created: { id: string; lineNo: number }[], input: RawLine[]) {
    for (const l of created) {
      const ref = input[l.lineNo - 1]?.sourceRef;
      if (!ref) continue;
      const bad = (m: string) => new BadRequestException({ code: 'INVALID_BILLABLE', message: m });
      if (ref.type === 'time') {
        const t = await tx.timeEntry.findFirst({ where: { id: ref.id, companyId }, include: { project: { select: { customerId: true } } } });
        if (!t || !t.billable) throw bad('That time entry is not billable');
        if ((t.customerId ?? t.project?.customerId) !== contactId) throw bad('That time entry is for another customer');
        const n = await tx.timeEntry.updateMany({ where: { id: t.id, invoiceLineId: null }, data: { invoiceLineId: l.id } });
        if (n.count !== 1) throw new ConflictException({ code: 'ALREADY_BILLED', message: 'That time entry is already on an invoice' });
      } else {
        const where = { id: ref.id, companyId, billable: true, billableToId: contactId };
        const found = ref.type === 'bill_line' ? await tx.billLine.findFirst({ where, include: { bill: { select: { status: true } } } }) : await tx.expenseLine.findFirst({ where, include: { expense: { select: { status: true } } } });
        if (!found) throw bad('That cost is not billable to this customer');
        const posted = 'bill' in found ? ['POSTED', 'PARTIAL', 'PAID'].includes(found.bill.status) : found.expense.status === 'POSTED';
        if (!posted) throw bad('Only posted costs can be billed');
        const n = ref.type === 'bill_line'
          ? await tx.billLine.updateMany({ where: { id: ref.id, invoiceLineId: null }, data: { invoiceLineId: l.id } })
          : await tx.expenseLine.updateMany({ where: { id: ref.id, invoiceLineId: null }, data: { invoiceLineId: l.id } });
        if (n.count !== 1) throw new ConflictException({ code: 'ALREADY_BILLED', message: 'That cost is already on an invoice' });
      }
    }
  }

  /** Unbilled billable time and costs for a customer ("Add to invoice" in the editor). */
  async billables(companyId: string, contactId: string) {
    const [time, bills, expenses] = await Promise.all([
      this.prisma.timeEntry.findMany({ where: { companyId, billable: true, invoiceLineId: null, OR: [{ customerId: contactId }, { project: { customerId: contactId } }] }, include: { user: { select: { name: true } }, project: { select: { name: true } } }, orderBy: { date: 'asc' } }),
      this.prisma.billLine.findMany({ where: { companyId, billable: true, billableToId: contactId, invoiceLineId: null, bill: { status: { in: ['POSTED', 'PARTIAL', 'PAID'] } } }, include: { bill: { select: { number: true, issueDate: true, contact: { select: { name: true } } } } } }),
      this.prisma.expenseLine.findMany({ where: { companyId, billable: true, billableToId: contactId, invoiceLineId: null, expense: { status: 'POSTED' } }, include: { expense: { select: { date: true, description: true } } } }),
    ]);
    return [
      ...time.map((t) => ({ type: 'time' as const, id: t.id, date: isoOf(t.date), description: [t.project?.name, t.description, `${t.user.name}, ${D(t.hours).toString()} h`].filter(Boolean).join(' – '), quantity: D(t.hours).toString(), rate: t.rate ? D(t.rate).toFixed(2) : null, itemId: t.itemId, projectId: t.projectId })),
      ...bills.map((b) => ({ type: 'bill_line' as const, id: b.id, date: isoOf(b.bill.issueDate), description: `${b.description} (${b.bill.contact.name} ${b.bill.number ?? ''})`.trim(), quantity: D(b.quantity).toString(), rate: D(b.net).div(D(b.quantity).isZero() ? 1 : b.quantity).toFixed(2), itemId: b.itemId, projectId: b.projectId })),
      ...expenses.map((e) => ({ type: 'expense_line' as const, id: e.id, date: isoOf(e.expense.date), description: `${e.description} (${e.expense.description})`, quantity: '1', rate: D(e.net).toFixed(2), itemId: null, projectId: e.projectId })),
    ].sort((a, b) => a.date.localeCompare(b.date));
  }

  // ---------- invoices ----------

  async createInvoice(companyId: string, i: InvoiceInput, actorId: string, ip: string | null, extra?: { estimateId?: string; recurringId?: string; lateFeeForId?: string }, outerTx?: Tx) {
    const run = async (tx: Tx) => {
      const data = await this.invoiceData(tx, companyId, i);
      const inv = await tx.invoice.create({ data: { ...data, companyId, createdById: actorId, ...(extra ?? {}) }, include: { lines: true } });
      await this.linkSources(tx, companyId, i.contactId, inv.lines, i.lines);
      await this.audit.record({ action: 'invoice.created', companyId, actorId, entityType: 'Invoice', entityId: inv.id, ip, ...(extra?.recurringId ? { metadata: { recurringId: extra.recurringId } } : {}) }, tx);
      return inv;
    };
    return outerTx ? run(outerTx) : this.prisma.$transaction(run);
  }

  /** Drafts can be edited freely (lines are replaced); posted invoices are changed only by voiding. */
  async updateInvoice(companyId: string, id: string, i: InvoiceInput, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const cur = await tx.invoice.findFirst({ where: { id, companyId } });
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found' });
      if (cur.status !== 'DRAFT') throw new ConflictException({ code: 'NOT_DRAFT', message: 'Only draft invoices can be edited; void a posted invoice instead' });
      const data = await this.invoiceData(tx, companyId, i);
      const old = await tx.invoiceLine.findMany({ where: { invoiceId: id }, select: { id: true } });
      await this.unlinkSources(tx, companyId, old.map((l) => l.id));
      await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
      const inv = await tx.invoice.update({ where: { id }, data, include: { lines: true } });
      await this.linkSources(tx, companyId, i.contactId, inv.lines, i.lines);
      await this.audit.record({ action: 'invoice.updated', companyId, actorId, entityType: 'Invoice', entityId: id, ip }, tx);
      return inv;
    });
  }

  private async invoiceData(tx: Tx, companyId: string, i: InvoiceInput) {
    await this.checkContact(tx, companyId, i.contactId, 'CUSTOMER');
    await this.checkAccounts(tx, companyId, i.lines.map((l) => l.accountId), ['REVENUE']);
    if (i.dueDate < i.issueDate) throw new BadRequestException({ code: 'INVALID_DUE_DATE', message: 'The due date cannot be before the invoice date' });
    if (i.kind === 'CREDIT' && i.lines.some((l) => l.sourceRef)) throw new BadRequestException({ code: 'INVALID_BILLABLE', message: 'Billable time and costs go on invoices, not credit notes' });
    const p = await this.priceLines(tx, companyId, i.issueDate, i.taxInclusive, i.lines);
    const extras = await this.salesLineExtras(tx, companyId, i.lines);
    await this.checkDims(tx, companyId, [], i.locationId);
    return {
      contactId: i.contactId, kind: i.kind, issueDate: toDate(i.issueDate), dueDate: toDate(i.dueDate), taxInclusive: i.taxInclusive, locationId: i.locationId ?? null,
      terms: i.terms ?? null, billingAddress: i.billingAddress ?? null, message: i.message ?? null, memo: i.memo ?? null,
      subtotal: p.subtotal, taxTotal: p.taxTotal, total: p.total,
      lines: { create: p.priced.map((l, n) => ({ ...l, ...extras[n], companyId })) },
    };
  }

  async postInvoice(companyId: string, id: string, actorId: string, ip: string | null, outerTx?: Tx) {
    const run = async (tx: Tx) => {
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const inv = await tx.invoice.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
      if (!inv) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found' });
      if (inv.status !== 'DRAFT') throw new ConflictException({ code: 'NOT_DRAFT', message: 'Invoice is already posted' });
      const roles = await this.ledger.roleAccounts(tx, companyId);
      if (!roles.receivableId) throw new UnprocessableEntityException({ code: 'NO_AR', message: 'No Accounts Receivable account is configured' });
      const number = await this.docNumber(tx, companyId, 'invoice', inv.kind);
      const credit = inv.kind === 'CREDIT';
      const sourceType = credit ? 'credit_note' : 'invoice';
      const stock = await this.saleInventory(tx, companyId, inv.lines, credit, inv.contactId, number);
      const lines = [...salesJournal({ lines: this.docLines(inv.lines), receivableId: roles.receivableId, contactId: inv.contactId, taxAccounts: roles.taxAccounts, credit, memo: number, locationId: inv.locationId }), ...stock.journal];
      const entry = await this.ledger.post(tx, { companyId, date: isoOf(inv.issueDate), memo: number, sourceType, sourceId: inv.id, lines, actorId, ip });
      await this.inventory.commit(tx, companyId, stock.planned, { date: inv.issueDate, sourceType, sourceId: inv.id, journalEntryId: entry.id, actorId });
      for (const p of stock.planned) await tx.invoiceLine.update({ where: { id: p.lineId! }, data: { cogs: p.value.abs().toFixed(2) } });
      const u = await tx.invoice.update({ where: { id }, data: { number, status: 'POSTED', journalEntryId: entry.id } });
      await this.audit.record({ action: 'invoice.posted', companyId, actorId, entityType: 'Invoice', entityId: id, metadata: { number, journal: entry.number }, ip }, tx);
      return u;
    };
    return outerTx ? run(outerTx) : this.prisma.$transaction(run);
  }

  async voidInvoice(companyId: string, id: string, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const inv = await tx.invoice.findFirst({ where: { id, companyId }, include: { lines: { select: { id: true } } } });
      if (!inv) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found' });
      await this.unlinkSources(tx, companyId, inv.lines.map((l) => l.id));
      if (inv.status === 'DRAFT') {
        await tx.estimate.updateMany({ where: { companyId, invoiceId: id }, data: { invoiceId: null, status: 'ACCEPTED' } });
        await tx.invoice.delete({ where: { id } });
        return { id, status: 'DELETED' };
      }
      if (inv.status !== 'POSTED' || !D(inv.amountPaid).isZero()) throw new ConflictException({ code: 'HAS_PAYMENTS', message: 'Only unpaid posted invoices can be voided; void the payments and unapply credits first' });
      const rev = await this.ledger.reverse(companyId, inv.journalEntryId!, actorId, { allowSourced: true, tx, memo: `Void ${inv.number}` }, ip);
      await this.inventory.reverseSource(tx, companyId, inv.kind === 'CREDIT' ? 'credit_note' : 'invoice', id, { date: isoOf(rev.date), journalEntryId: rev.id, actorId });
      const u = await tx.invoice.update({ where: { id }, data: { status: 'VOID' } });
      await this.audit.record({ action: 'invoice.voided', companyId, actorId, entityType: 'Invoice', entityId: id, metadata: { number: inv.number }, ip }, tx);
      return u;
    });
  }

  listInvoices(companyId: string, status?: string) {
    return this.prisma.invoice.findMany({ where: { companyId, ...(status ? { status: status as 'DRAFT' } : {}) }, orderBy: { issueDate: 'desc' }, include: { contact: { select: { name: true } } }, take: 200 });
  }
  async getInvoice(companyId: string, id: string) {
    const i = await this.prisma.invoice.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } }, contact: true, creditsApplied: { where: { voidedAt: null } }, creditsGiven: { where: { voidedAt: null } } } });
    if (!i) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found' });
    return i;
  }

  // ---------- bills ----------

  /** Purchase lines: products (inventory items must use their inventory asset account), tracking, and billable customers. */
  async purchaseLineExtras(db: Tx | PrismaService, companyId: string, lines: RawLine[]) {
    const ids = [...new Set(lines.map((l) => l.itemId).filter((x): x is string => !!x))];
    const items = new Map((ids.length ? await db.item.findMany({ where: { companyId, id: { in: ids }, isActive: true } }) : []).map((i) => [i.id, i]));
    if (items.size !== ids.length) throw new BadRequestException({ code: 'INVALID_ITEM', message: 'Unknown or inactive product/service on a line' });
    for (const l of lines) {
      const it = l.itemId ? items.get(l.itemId) : undefined;
      if (it?.trackInventory && l.accountId !== it.inventoryAccountId) throw new BadRequestException({ code: 'INVENTORY_ACCOUNT', message: `${it.name} tracks quantity: its line must use its inventory asset account` });
      if (l.billable && !l.billableToId) throw new BadRequestException({ code: 'INVALID_BILLABLE', message: 'Pick the customer a billable cost is for' });
    }
    for (const c of new Set(lines.map((l) => l.billableToId).filter((x): x is string => !!x))) await this.checkContact(db, companyId, c, 'CUSTOMER');
    await this.checkDims(db, companyId, lines);
    return lines.map((l) => ({ itemId: l.itemId ?? null, classId: l.classId ?? null, projectId: l.projectId ?? null, billable: Boolean(l.billable && l.billableToId), billableToId: l.billable ? l.billableToId ?? null : null }));
  }

  async createBill(companyId: string, i: BillInput, actorId: string, ip: string | null, extra?: { purchaseOrderId?: string; recurringId?: string }, outerTx?: Tx) {
    const run = async (tx: Tx) => {
      await this.checkContact(tx, companyId, i.contactId, 'VENDOR');
      await this.checkAccounts(tx, companyId, i.lines.map((l) => l.accountId), ['EXPENSE', 'ASSET']);
      await this.checkDims(tx, companyId, [], i.locationId);
      const p = await this.priceLines(tx, companyId, i.issueDate, i.taxInclusive, i.lines);
      const extras = await this.purchaseLineExtras(tx, companyId, i.lines);
      const bill = await tx.bill.create({
        data: { companyId, contactId: i.contactId, kind: i.kind, supplierRef: i.supplierRef, memo: i.memo ?? null, locationId: i.locationId ?? null, issueDate: toDate(i.issueDate), dueDate: toDate(i.dueDate), taxInclusive: i.taxInclusive, subtotal: p.subtotal, taxTotal: p.taxTotal, total: p.total, createdById: actorId, ...(extra ?? {}), lines: { create: p.priced.map((l, n) => ({ ...l, ...extras[n], companyId })) } },
        include: { lines: true },
      });
      await this.audit.record({ action: 'bill.created', companyId, actorId, entityType: 'Bill', entityId: bill.id, ip }, tx);
      return bill;
    };
    return outerTx ? run(outerTx) : this.prisma.$transaction(run);
  }

  async postBill(companyId: string, id: string, actorId: string, ip: string | null, outerTx?: Tx) {
    const run = async (tx: Tx) => {
      await tx.$queryRaw`SELECT id FROM "Bill" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const bill = await tx.bill.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
      if (!bill) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Bill not found' });
      if (bill.status !== 'DRAFT') throw new ConflictException({ code: 'NOT_DRAFT', message: 'Bill is already posted' });
      const roles = await this.ledger.roleAccounts(tx, companyId);
      if (!roles.payableId) throw new UnprocessableEntityException({ code: 'NO_AP', message: 'No Accounts Payable account is configured' });
      const number = await this.docNumber(tx, companyId, 'bill', bill.kind);
      const credit = bill.kind === 'CREDIT';
      const sourceType = credit ? 'vendor_credit' : 'bill';
      const planned = await this.purchaseInventory(tx, companyId, bill.lines, credit, number);
      const lines = purchaseJournal({ lines: this.docLines(bill.lines), counterAccountId: roles.payableId, contactId: bill.contactId, taxAccounts: roles.taxAccounts, credit, memo: number, locationId: bill.locationId });
      const entry = await this.ledger.post(tx, { companyId, date: isoOf(bill.issueDate), memo: number, sourceType, sourceId: bill.id, lines, actorId, ip });
      await this.inventory.commit(tx, companyId, planned, { date: bill.issueDate, sourceType, sourceId: bill.id, journalEntryId: entry.id, actorId });
      const u = await tx.bill.update({ where: { id }, data: { number, status: 'POSTED', journalEntryId: entry.id } });
      await this.audit.record({ action: 'bill.posted', companyId, actorId, entityType: 'Bill', entityId: id, metadata: { number, journal: entry.number }, ip }, tx);
      return u;
    };
    return outerTx ? run(outerTx) : this.prisma.$transaction(run);
  }

  async voidBill(companyId: string, id: string, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Bill" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const b = await tx.bill.findFirst({ where: { id, companyId } });
      if (!b) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Bill not found' });
      if (b.status === 'DRAFT') {
        await tx.purchaseOrder.updateMany({ where: { companyId, billId: id }, data: { billId: null, status: 'OPEN' } });
        await tx.bill.delete({ where: { id } });
        return { id, status: 'DELETED' };
      }
      if (b.status !== 'POSTED' || !D(b.amountPaid).isZero()) throw new ConflictException({ code: 'HAS_PAYMENTS', message: 'Only unpaid posted bills can be voided; void the payments and unapply credits first' });
      const billed = await tx.billLine.count({ where: { billId: id, invoiceLineId: { not: null } } });
      if (billed) throw new ConflictException({ code: 'BILLED_TO_CUSTOMER', message: 'A cost on this bill is on a customer invoice; remove it from that invoice first' });
      const rev = await this.ledger.reverse(companyId, b.journalEntryId!, actorId, { allowSourced: true, tx, memo: `Void ${b.number}` }, ip);
      await this.inventory.reverseSource(tx, companyId, b.kind === 'CREDIT' ? 'vendor_credit' : 'bill', id, { date: isoOf(rev.date), journalEntryId: rev.id, actorId });
      const u = await tx.bill.update({ where: { id }, data: { status: 'VOID' } });
      await this.audit.record({ action: 'bill.voided', companyId, actorId, entityType: 'Bill', entityId: id, metadata: { number: b.number }, ip }, tx);
      return u;
    });
  }

  listBills(companyId: string, status?: string) {
    return this.prisma.bill.findMany({ where: { companyId, ...(status ? { status: status as 'DRAFT' } : {}) }, orderBy: { issueDate: 'desc' }, include: { contact: { select: { name: true } } }, take: 200 });
  }
  async getBill(companyId: string, id: string) {
    const b = await this.prisma.bill.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } }, contact: true, creditsApplied: { where: { voidedAt: null } }, creditsGiven: { where: { voidedAt: null } } } });
    if (!b) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Bill not found' });
    return b;
  }

  // ---------- payments ----------

  async createPayment(companyId: string, i: { direction: 'RECEIPT' | 'DISBURSEMENT'; contactId: string; bankAccountId: string; date: string; amount: string; reference?: string; method?: 'CASH' | 'CHEQUE' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'E_TRANSFER' | 'OTHER'; allocations: { documentId: string; amount: string }[] }, actorId: string, ip: string | null, outerTx?: Tx) {
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
        if (d.kind !== 'STANDARD') throw new BadRequestException({ code: 'CREDIT_DOC', message: `${d.number} is a credit; apply it to an invoice or bill instead of paying it` });
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
        data: { companyId, direction: i.direction, contactId: i.contactId, bankAccountId: bank.id, date: toDate(i.date), amount: D(i.amount).toFixed(2), reference: i.reference, method: i.method ?? null, journalEntryId: entry.id, createdById: actorId,
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
      if (pay.depositId) throw new ConflictException({ code: 'DEPOSITED', message: 'This payment is part of a bank deposit; void the deposit first' });
      if (await tx.stripeCheckout.findFirst({ where: { paymentId: id } })) throw new ConflictException({ code: 'CARD_PAYMENT', message: 'This is a card payment received through Stripe; refund it in Stripe and record the refund as a credit note' });
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

  /** Pay bills: one supplier payment per supplier, all in one transaction (all or nothing). */
  async payBills(companyId: string, i: { bankAccountId: string; date: string; reference?: string; bills: { billId: string; amount: string }[] }, actorId: string, ip: string | null) {
    const bills = await this.prisma.bill.findMany({ where: { companyId, id: { in: i.bills.map((b) => b.billId) } }, select: { id: true, contactId: true } });
    if (bills.length !== new Set(i.bills.map((b) => b.billId)).size) throw new BadRequestException({ code: 'INVALID_DOCUMENT', message: 'Unknown bill' });
    const contactOf = new Map(bills.map((b) => [b.id, b.contactId]));
    const groups = new Map<string, { documentId: string; amount: string }[]>();
    for (const b of i.bills) groups.set(contactOf.get(b.billId)!, [...(groups.get(contactOf.get(b.billId)!) ?? []), { documentId: b.billId, amount: b.amount }]);
    return this.prisma.$transaction(async (tx) => {
      const out = [];
      for (const [contactId, allocations] of groups) {
        const amount = allocations.reduce((a, x) => a.plus(x.amount), D(0)).toFixed(2);
        out.push(await this.createPayment(companyId, { direction: 'DISBURSEMENT', contactId, bankAccountId: i.bankAccountId, date: i.date, amount, reference: i.reference, allocations }, actorId, ip, tx));
      }
      return out;
    }, { timeout: 30_000 });
  }

  // ---------- credits applied to invoices and bills (no journal: both are already in A/R or A/P) ----------

  async applyCredit(companyId: string, side: 'invoice' | 'bill', targetId: string, i: { creditId: string; amount: string; date?: string }, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const table = side === 'invoice' ? 'Invoice' : 'Bill';
      const ids = [targetId, i.creditId].sort();
      await tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE "companyId" = $1::uuid AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`, companyId, ids);
      const docs = side === 'invoice' ? await tx.invoice.findMany({ where: { companyId, id: { in: ids } } }) : await tx.bill.findMany({ where: { companyId, id: { in: ids } } });
      const target = docs.find((d) => d.id === targetId), credit = docs.find((d) => d.id === i.creditId);
      if (!target || !credit) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Document not found' });
      if (target.kind !== 'STANDARD' || credit.kind !== 'CREDIT') throw new BadRequestException({ code: 'INVALID_CREDIT', message: side === 'invoice' ? 'Apply a credit note to an invoice' : 'Apply a supplier credit to a bill' });
      if (target.contactId !== credit.contactId) throw new BadRequestException({ code: 'CONTACT_MISMATCH', message: 'The credit belongs to a different contact' });
      for (const d of [target, credit]) if (d.status !== 'POSTED' && d.status !== 'PARTIAL') throw new ConflictException({ code: 'NOT_OPEN', message: `${d.number ?? 'Document'} is ${d.status.toLowerCase()}` });
      const amt = D(i.amount);
      const openT = D(target.total).minus(target.amountPaid), openC = D(credit.total).minus(credit.amountPaid);
      if (amt.lte(0) || amt.gt(openT) || amt.gt(openC)) throw new UnprocessableEntityException({ code: 'OVER_ALLOCATION', message: `At most ${Decimal.min(openT, openC).toFixed(2)} can be applied` });
      const bump = (d: typeof target) => { const paid = D(d.amountPaid).plus(amt); return { amountPaid: paid.toFixed(2), status: paid.gte(d.total.toString()) ? ('PAID' as const) : ('PARTIAL' as const) }; };
      if (side === 'invoice') { await tx.invoice.update({ where: { id: target.id }, data: bump(target) }); await tx.invoice.update({ where: { id: credit.id }, data: bump(credit) }); }
      else { await tx.bill.update({ where: { id: target.id }, data: bump(target) }); await tx.bill.update({ where: { id: credit.id }, data: bump(credit) }); }
      const row = await tx.creditApplication.create({ data: { companyId, amount: amt.toFixed(2), date: toDate(i.date ?? isoOf(new Date())), createdById: actorId, ...(side === 'invoice' ? { invoiceId: target.id, creditInvoiceId: credit.id } : { billId: target.id, creditBillId: credit.id }) } });
      await this.audit.record({ action: `${side}.credit_applied`, companyId, actorId, entityType: table, entityId: target.id, metadata: { creditId: credit.id, amount: amt.toFixed(2) }, ip }, tx);
      return row;
    });
  }

  async unapplyCredit(companyId: string, applicationId: string, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.creditApplication.findFirst({ where: { id: applicationId, companyId } });
      if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Credit application not found' });
      if (a.voidedAt) throw new ConflictException({ code: 'ALREADY_VOIDED', message: 'Already unapplied' });
      const isInv = !!a.invoiceId;
      const ids = (isInv ? [a.invoiceId!, a.creditInvoiceId!] : [a.billId!, a.creditBillId!]).sort();
      await tx.$queryRawUnsafe(`SELECT id FROM "${isInv ? 'Invoice' : 'Bill'}" WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, ids);
      for (const id of ids) {
        const d = isInv ? await tx.invoice.findUniqueOrThrow({ where: { id } }) : await tx.bill.findUniqueOrThrow({ where: { id } });
        const paid = D(d.amountPaid).minus(a.amount);
        const data = { amountPaid: paid.toFixed(2), status: paid.isZero() ? ('POSTED' as const) : ('PARTIAL' as const) };
        if (isInv) await tx.invoice.update({ where: { id }, data }); else await tx.bill.update({ where: { id }, data });
      }
      const u = await tx.creditApplication.update({ where: { id: applicationId }, data: { voidedAt: new Date() } });
      await this.audit.record({ action: 'credit.unapplied', companyId, actorId, entityType: 'CreditApplication', entityId: applicationId, ip }, tx);
      return u;
    });
  }

  listPayments(companyId: string) {
    return this.prisma.payment.findMany({ where: { companyId }, orderBy: { date: 'desc' }, include: { allocations: true, contact: { select: { name: true } } }, take: 200 });
  }

  // ---------- expenses (submit → approve → post; approver must differ from submitter) ----------

  async createExpense(companyId: string, i: ExpenseInput, actorId: string, ip: string | null, extra?: { recurringId?: string }, outerTx?: Tx) {
    const run = async (tx: Tx) => {
      if (i.contactId) await this.checkContact(tx, companyId, i.contactId, 'VENDOR');
      await this.checkDims(tx, companyId, i.lines, i.locationId);
      for (const l of i.lines) if (l.billable && !l.billableToId) throw new BadRequestException({ code: 'INVALID_BILLABLE', message: 'Pick the customer a billable cost is for' });
      for (const c of new Set(i.lines.map((l) => l.billableToId).filter((x): x is string => !!x))) await this.checkContact(tx, companyId, c, 'CUSTOMER');
      await this.checkAccounts(tx, companyId, i.lines.map((l) => l.accountId), ['EXPENSE', 'ASSET']);
      const paid = await tx.account.findFirst({ where: { id: i.paidFromAccountId, companyId, isActive: true, role: null, type: { in: ['ASSET', 'LIABILITY'] } } });
      if (!paid) throw new BadRequestException({ code: 'INVALID_ACCOUNT', message: 'Pick an active bank, card or reimbursement account to pay from' });
      const taxes = await this.tax.compute(tx, companyId, i.date, i.taxInclusive, i.lines.map((l) => ({ amount: l.amount, taxCodeId: l.taxCodeId })));
      const subtotal = taxes.reduce((s, t) => s.plus(t.net), D(0));
      const taxTotal = taxes.reduce((s, t) => s.plus(t.taxTotal), D(0));
      const e = await tx.expense.create({
        data: { companyId, contactId: i.contactId, date: toDate(i.date), description: i.description, paidFromAccountId: i.paidFromAccountId, taxInclusive: i.taxInclusive, locationId: i.locationId ?? null, subtotal: subtotal.toFixed(2), taxTotal: taxTotal.toFixed(2), total: subtotal.plus(taxTotal).toFixed(2), submittedById: actorId, ...(extra ?? {}),
          lines: { create: i.lines.map((l, n) => ({ companyId, lineNo: n + 1, description: l.description, amount: l.amount, accountId: l.accountId, taxCodeId: l.taxCodeId, net: taxes[n].net, taxDetail: taxes[n].taxes as unknown as Prisma.InputJsonValue, taxAmount: taxes[n].taxTotal, classId: l.classId ?? null, projectId: l.projectId ?? null, billable: Boolean(l.billable && l.billableToId), billableToId: l.billable ? l.billableToId ?? null : null })) } },
        include: { lines: true },
      });
      await this.audit.record({ action: 'expense.submitted', companyId, actorId, entityType: 'Expense', entityId: e.id, ip }, tx);
      return e;
    };
    return outerTx ? run(outerTx) : this.prisma.$transaction(run);
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
      const lines = purchaseJournal({ lines: this.docLines(e.lines), counterAccountId: e.paidFromAccountId, contactId: e.contactId, taxAccounts: roles.taxAccounts, memo: e.description, locationId: e.locationId });
      const entry = await this.ledger.post(tx, { companyId, date: isoOf(e.date), memo: e.description, sourceType: 'expense', sourceId: e.id, lines, actorId, ip });
      const u = await tx.expense.update({ where: { id }, data: { status: 'POSTED', journalEntryId: entry.id } });
      await this.audit.record({ action: 'expense.posted', companyId, actorId, entityType: 'Expense', entityId: id, metadata: { journal: entry.number }, ip }, tx);
      return u;
    });
  }
}
