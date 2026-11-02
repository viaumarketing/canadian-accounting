import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@ca/database';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../accounting/ledger.service';
import { isoOf, toDate } from '../accounting/setup';
import { BillingService, type RawLine } from './billing.service';

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;
const TERM_DAYS: Record<string, number> = { DUE_ON_RECEIPT: 0, NET_15: 15, NET_30: 30, NET_60: 60 };

export interface EstimateInput { contactId: string; issueDate: string; expiryDate?: string; taxInclusive: boolean; lines: RawLine[]; billingAddress?: string; message?: string; memo?: string; locationId?: string }

/** Estimates (quotes): no ledger effect. Accepted estimates are converted into a draft invoice with the same lines. */
@Injectable()
export class EstimatesService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly billing: BillingService, private readonly audit: AuditService) {}

  private async data(tx: Tx, companyId: string, i: EstimateInput) {
    await this.billing.checkContact(tx, companyId, i.contactId, 'CUSTOMER');
    await this.billing.checkAccounts(tx, companyId, i.lines.map((l) => l.accountId), ['REVENUE']);
    if (i.expiryDate && i.expiryDate < i.issueDate) throw new BadRequestException({ code: 'INVALID_EXPIRY', message: 'The expiry date cannot be before the estimate date' });
    if (i.lines.some((l) => l.sourceRef)) throw new BadRequestException({ code: 'INVALID_BILLABLE', message: 'Billable time and costs go on invoices' });
    const p = await this.billing.priceLines(tx, companyId, i.issueDate, i.taxInclusive, i.lines);
    const extras = await this.billing.salesLineExtras(tx, companyId, i.lines);
    return {
      contactId: i.contactId, issueDate: toDate(i.issueDate), expiryDate: i.expiryDate ? toDate(i.expiryDate) : null, taxInclusive: i.taxInclusive,
      billingAddress: i.billingAddress ?? null, message: i.message ?? null, memo: i.memo ?? null,
      subtotal: p.subtotal, taxTotal: p.taxTotal, total: p.total,
      lines: { create: p.priced.map((l, n) => ({ ...l, ...extras[n], companyId })) },
    };
  }

  async create(companyId: string, i: EstimateInput, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const data = await this.data(tx, companyId, i);
      // Estimates are numbered when created (EST-0001): they never post, so gaps (voided quotes) are harmless.
      const number = `EST-${String(await this.ledger.nextNumber(tx, companyId, 'estimate')).padStart(4, '0')}`;
      const e = await tx.estimate.create({ data: { ...data, companyId, number, createdById: actorId }, include: { lines: true } });
      await this.audit.record({ action: 'estimate.created', companyId, actorId, entityType: 'Estimate', entityId: e.id, metadata: { number }, ip }, tx);
      return e;
    });
  }

  async update(companyId: string, id: string, i: EstimateInput, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Estimate" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const cur = await tx.estimate.findFirst({ where: { id, companyId } });
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Estimate not found' });
      if (cur.status === 'CLOSED' || cur.status === 'VOID') throw new ConflictException({ code: 'NOT_EDITABLE', message: `A ${cur.status === 'CLOSED' ? 'converted' : 'voided'} estimate cannot be edited` });
      const data = await this.data(tx, companyId, i);
      await tx.estimateLine.deleteMany({ where: { estimateId: id } });
      const e = await tx.estimate.update({ where: { id }, data, include: { lines: true } });
      await this.audit.record({ action: 'estimate.updated', companyId, actorId, entityType: 'Estimate', entityId: id, ip }, tx);
      return e;
    });
  }

  async decide(companyId: string, id: string, i: { status: 'ACCEPTED' | 'DECLINED'; acceptedBy?: string }, actorId: string, ip: string | null) {
    const e = await this.get(companyId, id);
    if (e.status === 'CLOSED' || e.status === 'VOID') throw new ConflictException({ code: 'NOT_EDITABLE', message: `The estimate is ${e.status === 'CLOSED' ? 'already converted' : 'void'}` });
    const u = await this.prisma.estimate.update({ where: { id }, data: { status: i.status, acceptedBy: i.status === 'ACCEPTED' ? i.acceptedBy ?? null : null, decidedAt: new Date() } });
    await this.audit.record({ action: `estimate.${i.status.toLowerCase()}`, companyId, actorId, entityType: 'Estimate', entityId: id, ip });
    return u;
  }

  /** Copy the estimate into a draft invoice (due date from the customer's default terms) and close the estimate. */
  async convert(companyId: string, id: string, actorId: string, ip: string | null, issueDate?: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Estimate" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const e = await tx.estimate.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } }, contact: true } });
      if (!e) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Estimate not found' });
      if (e.status === 'CLOSED' || e.status === 'VOID' || e.status === 'DECLINED') throw new ConflictException({ code: 'NOT_CONVERTIBLE', message: `A ${e.status.toLowerCase()} estimate cannot be converted` });
      const date = issueDate ?? isoOf(new Date());
      const terms = e.contact.defaultTerms ?? 'NET_30';
      const due = isoOf(new Date(toDate(date).getTime() + (TERM_DAYS[terms] ?? 30) * DAY));
      const inv = await this.billing.createInvoice(companyId, {
        contactId: e.contactId, issueDate: date, dueDate: due, terms, taxInclusive: e.taxInclusive, kind: 'STANDARD',
        billingAddress: e.billingAddress ?? undefined, message: e.message ?? undefined, memo: e.memo ?? `From estimate ${e.number}`,
        lines: e.lines.map((l) => ({ description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), accountId: l.accountId, taxCodeId: l.taxCodeId, itemId: l.itemId ?? undefined, serviceDate: l.serviceDate ? isoOf(l.serviceDate) : undefined, classId: l.classId ?? undefined, projectId: l.projectId ?? undefined })),
      }, actorId, ip, { estimateId: e.id }, tx);
      await tx.estimate.update({ where: { id }, data: { status: 'CLOSED', invoiceId: inv.id } });
      await this.audit.record({ action: 'estimate.converted', companyId, actorId, entityType: 'Estimate', entityId: id, metadata: { invoiceId: inv.id }, ip }, tx);
      return inv;
    });
  }

  async void(companyId: string, id: string, actorId: string, ip: string | null) {
    const e = await this.get(companyId, id);
    if (e.status === 'CLOSED') throw new ConflictException({ code: 'NOT_EDITABLE', message: 'A converted estimate cannot be voided; void its invoice instead' });
    const u = await this.prisma.estimate.update({ where: { id }, data: { status: 'VOID' } });
    await this.audit.record({ action: 'estimate.voided', companyId, actorId, entityType: 'Estimate', entityId: id, ip });
    return u;
  }

  list(companyId: string, status?: string) {
    const ok = ['PENDING', 'ACCEPTED', 'DECLINED', 'CLOSED', 'VOID'];
    return this.prisma.estimate.findMany({ where: { companyId, ...(status && ok.includes(status) ? { status: status as 'PENDING' } : {}) }, orderBy: [{ issueDate: 'desc' }, { number: 'desc' }], include: { contact: { select: { name: true } } }, take: 300 });
  }

  async get(companyId: string, id: string) {
    const e = await this.prisma.estimate.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } }, contact: true } });
    if (!e) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Estimate not found' });
    return e;
  }
}
