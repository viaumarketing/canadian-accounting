import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@ca/database';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../accounting/ledger.service';
import { isoOf, toDate } from '../accounting/setup';
import { BillingService, type RawLine } from './billing.service';

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;

export interface PurchaseOrderInput { contactId: string; issueDate: string; expectedDate?: string; taxInclusive: boolean; lines: RawLine[]; shipTo?: string; message?: string; memo?: string }

/** Purchase orders: no ledger effect. Converting one creates a draft bill with the same lines (received stock posts with the bill). */
@Injectable()
export class PurchaseOrdersService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly billing: BillingService, private readonly audit: AuditService) {}

  private async data(tx: Tx, companyId: string, i: PurchaseOrderInput) {
    await this.billing.checkContact(tx, companyId, i.contactId, 'VENDOR');
    await this.billing.checkAccounts(tx, companyId, i.lines.map((l) => l.accountId), ['EXPENSE', 'ASSET']);
    if (i.expectedDate && i.expectedDate < i.issueDate) throw new BadRequestException({ code: 'INVALID_DATE', message: 'The expected date cannot be before the order date' });
    const p = await this.billing.priceLines(tx, companyId, i.issueDate, i.taxInclusive, i.lines);
    const extras = await this.billing.purchaseLineExtras(tx, companyId, i.lines);
    return {
      contactId: i.contactId, issueDate: toDate(i.issueDate), expectedDate: i.expectedDate ? toDate(i.expectedDate) : null, taxInclusive: i.taxInclusive,
      shipTo: i.shipTo ?? null, message: i.message ?? null, memo: i.memo ?? null, subtotal: p.subtotal, taxTotal: p.taxTotal, total: p.total,
      lines: { create: p.priced.map((l, n) => ({ ...l, itemId: extras[n].itemId, classId: extras[n].classId, projectId: extras[n].projectId, companyId })) },
    };
  }

  async create(companyId: string, i: PurchaseOrderInput, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const data = await this.data(tx, companyId, i);
      const number = `PO-${String(await this.ledger.nextNumber(tx, companyId, 'purchase_order')).padStart(4, '0')}`;
      const po = await tx.purchaseOrder.create({ data: { ...data, companyId, number, createdById: actorId }, include: { lines: true } });
      await this.audit.record({ action: 'purchase_order.created', companyId, actorId, entityType: 'PurchaseOrder', entityId: po.id, metadata: { number }, ip }, tx);
      return po;
    });
  }

  async update(companyId: string, id: string, i: PurchaseOrderInput, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const cur = await tx.purchaseOrder.findFirst({ where: { id, companyId } });
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Purchase order not found' });
      if (cur.status !== 'OPEN') throw new ConflictException({ code: 'NOT_EDITABLE', message: `A ${cur.status.toLowerCase()} purchase order cannot be edited` });
      const data = await this.data(tx, companyId, i);
      await tx.purchaseOrderLine.deleteMany({ where: { orderId: id } });
      const po = await tx.purchaseOrder.update({ where: { id }, data, include: { lines: true } });
      await this.audit.record({ action: 'purchase_order.updated', companyId, actorId, entityType: 'PurchaseOrder', entityId: id, ip }, tx);
      return po;
    });
  }

  async convert(companyId: string, id: string, actorId: string, ip: string | null, i: { issueDate?: string; supplierRef?: string } = {}) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const po = await tx.purchaseOrder.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
      if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Purchase order not found' });
      if (po.status !== 'OPEN') throw new ConflictException({ code: 'NOT_CONVERTIBLE', message: `A ${po.status.toLowerCase()} purchase order cannot be converted` });
      const date = i.issueDate ?? isoOf(new Date());
      const bill = await this.billing.createBill(companyId, {
        contactId: po.contactId, issueDate: date, dueDate: isoOf(new Date(toDate(date).getTime() + 30 * DAY)), taxInclusive: po.taxInclusive, kind: 'STANDARD', supplierRef: i.supplierRef, memo: `From ${po.number}`,
        lines: po.lines.map((l) => ({ description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), accountId: l.accountId, taxCodeId: l.taxCodeId, itemId: l.itemId ?? undefined, classId: l.classId ?? undefined, projectId: l.projectId ?? undefined })),
      }, actorId, ip, { purchaseOrderId: po.id }, tx);
      await tx.purchaseOrder.update({ where: { id }, data: { status: 'CLOSED', billId: bill.id } });
      await this.audit.record({ action: 'purchase_order.converted', companyId, actorId, entityType: 'PurchaseOrder', entityId: id, metadata: { billId: bill.id }, ip }, tx);
      return bill;
    });
  }

  async void(companyId: string, id: string, actorId: string, ip: string | null) {
    const po = await this.get(companyId, id);
    if (po.status !== 'OPEN') throw new ConflictException({ code: 'NOT_EDITABLE', message: `A ${po.status.toLowerCase()} purchase order cannot be voided` });
    const u = await this.prisma.purchaseOrder.update({ where: { id }, data: { status: 'VOID' } });
    await this.audit.record({ action: 'purchase_order.voided', companyId, actorId, entityType: 'PurchaseOrder', entityId: id, ip });
    return u;
  }

  list(companyId: string, status?: string) {
    return this.prisma.purchaseOrder.findMany({ where: { companyId, ...(status && ['OPEN', 'CLOSED', 'VOID'].includes(status) ? { status: status as 'OPEN' } : {}) }, orderBy: [{ issueDate: 'desc' }, { number: 'desc' }], include: { contact: { select: { name: true } } }, take: 300 });
  }

  async get(companyId: string, id: string) {
    const po = await this.prisma.purchaseOrder.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } }, contact: true } });
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Purchase order not found' });
    return po;
  }
}
