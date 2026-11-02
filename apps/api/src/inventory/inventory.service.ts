import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Prisma } from '@ca/database';
import type { LineInput } from '@ca/accounting-engine';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../accounting/ledger.service';
import { isoOf, toDate } from '../accounting/setup';

type Tx = Prisma.TransactionClient;
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const r2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * A change to one inventory item. Inflows carry their value (purchase cost); outflows with `value` undefined are costed at
 * the weighted average: quantity × (current value ÷ quantity on hand), and the last unit out takes whatever value is left,
 * so the inventory account always equals the sum of the movements to the cent.
 */
export interface StockChange { itemId: string; qty: Decimal; value?: Decimal; lineId?: string; memo?: string }
export interface PlannedChange extends StockChange { value: Decimal; qtyAfter: Decimal; valueAfter: Decimal; avgAfter: Decimal; inventoryAccountId: string; cogsAccountId: string; name: string }

/**
 * Perpetual inventory at weighted-average cost (allowed under ASPE section 3031 and IFRS IAS 2). Quantities move when
 * documents are posted, in posting order. Stock cannot go below zero: a sale or return larger than what is on hand is
 * refused, so cost of goods sold is never estimated.
 */
@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly audit: AuditService) {}

  /** Current value of an item's stock: the sum of its movements. */
  private async value(tx: Tx | PrismaService, itemId: string) {
    const a = await tx.inventoryMovement.aggregate({ where: { itemId }, _sum: { value: true } });
    return D(a._sum.value ?? 0);
  }

  /** Inventory items among these ids (locked for update, in id order so two postings never deadlock). */
  async tracked(tx: Tx, companyId: string, itemIds: (string | null | undefined)[]) {
    const ids = [...new Set(itemIds.filter((x): x is string => !!x))].sort();
    if (!ids.length) return new Map<string, Prisma.ItemGetPayload<object>>();
    await tx.$queryRawUnsafe(`SELECT id FROM "Item" WHERE "companyId" = $1::uuid AND id = ANY($2::uuid[]) AND "trackInventory" ORDER BY id FOR UPDATE`, companyId, ids);
    const rows = await tx.item.findMany({ where: { companyId, id: { in: ids }, trackInventory: true } });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Work out values and the resulting quantities without writing anything (the caller posts the journal first). */
  async plan(tx: Tx, companyId: string, changes: StockChange[]): Promise<PlannedChange[]> {
    const items = await this.tracked(tx, companyId, changes.map((c) => c.itemId));
    const state = new Map<string, { qty: Decimal; value: Decimal }>();
    const out: PlannedChange[] = [];
    for (const c of changes) {
      const it = items.get(c.itemId);
      if (!it) continue;
      if (!it.inventoryAccountId || !it.cogsAccountId) throw new UnprocessableEntityException({ code: 'INVENTORY_ACCOUNTS', message: `${it.name}: set its inventory asset and cost of goods sold accounts first` });
      const cur = state.get(it.id) ?? { qty: D(it.qtyOnHand), value: await this.value(tx, it.id) };
      let value: Decimal;
      if (c.value !== undefined) value = r2(c.value);
      else if (c.qty.isNegative()) value = cur.qty.plus(c.qty).isZero() ? cur.value.neg() : r2(cur.value.times(c.qty).div(cur.qty.isZero() ? 1 : cur.qty));
      else value = r2(c.qty.times(cur.qty.isZero() ? it.avgCost.toString() : cur.value.div(cur.qty)));
      const qtyAfter = cur.qty.plus(c.qty);
      const valueAfter = cur.value.plus(value);
      if (qtyAfter.isNegative()) throw new UnprocessableEntityException({ code: 'INSUFFICIENT_STOCK', message: `${it.name}: only ${cur.qty.toString()} on hand, ${c.qty.abs().toString()} needed` });
      if (valueAfter.isNegative() || (qtyAfter.isZero() && !valueAfter.isZero())) throw new UnprocessableEntityException({ code: 'INVENTORY_VALUE', message: `${it.name}: this change would leave ${valueAfter.toFixed(2)} of value on ${qtyAfter.toString()} units` });
      state.set(it.id, { qty: qtyAfter, value: valueAfter });
      out.push({ ...c, value, qtyAfter, valueAfter, avgAfter: qtyAfter.isZero() ? D(it.avgCost) : valueAfter.div(qtyAfter).toDecimalPlaces(6), inventoryAccountId: it.inventoryAccountId, cogsAccountId: it.cogsAccountId, name: it.name });
    }
    return out;
  }

  /** Journal lines moving the value between inventory and cost of goods sold (sales, credit notes). */
  cogsLines(planned: PlannedChange[], contactId: string | null, memo: string): LineInput[] {
    const out: LineInput[] = [];
    for (const p of planned) {
      if (p.value.isZero()) continue;
      const out_ = p.value.isNegative(); // stock leaves: Dr COGS, Cr inventory
      const amt = p.value.abs().toFixed(2);
      out.push({ accountId: p.cogsAccountId, debit: out_ ? amt : '0.00', credit: out_ ? '0.00' : amt, memo: `Cost of goods sold – ${memo}`, contactId });
      out.push({ accountId: p.inventoryAccountId, debit: out_ ? '0.00' : amt, credit: out_ ? amt : '0.00', memo: `${p.name} – ${memo}`, contactId });
    }
    return out;
  }

  /** Write the movements and the items' new quantity and average cost. */
  async commit(tx: Tx, companyId: string, planned: PlannedChange[], ctx: { date: string | Date; sourceType: string; sourceId?: string | null; journalEntryId?: string | null; actorId: string }) {
    const date = typeof ctx.date === 'string' ? toDate(ctx.date) : ctx.date;
    for (const p of planned) {
      await tx.inventoryMovement.create({ data: { companyId, itemId: p.itemId, date, sourceType: ctx.sourceType, sourceId: ctx.sourceId ?? null, quantity: p.qty.toString(), value: p.value.toFixed(2), qtyAfter: p.qtyAfter.toString(), avgCostAfter: p.avgAfter.toString(), journalEntryId: ctx.journalEntryId ?? null, memo: p.memo ?? null, createdById: ctx.actorId } });
    }
    const last = new Map(planned.map((p) => [p.itemId, p]));
    for (const p of last.values()) await tx.item.update({ where: { id: p.itemId }, data: { qtyOnHand: p.qtyAfter.toString(), avgCost: p.avgAfter.toString() } });
  }

  /** Undo every movement of a document (it is being voided). Refused if the stock has already been sold on. */
  async reverseSource(tx: Tx, companyId: string, sourceType: string, sourceId: string, ctx: { date: string; journalEntryId?: string | null; actorId: string }) {
    const moves = await tx.inventoryMovement.findMany({ where: { companyId, sourceType, sourceId } });
    if (!moves.length) return;
    try {
      const planned = await this.plan(tx, companyId, moves.map((m) => ({ itemId: m.itemId, qty: D(m.quantity).neg(), value: D(m.value).neg(), memo: 'Void' })));
      await this.commit(tx, companyId, planned, { ...ctx, sourceType: 'reversal', sourceId });
    } catch (e) {
      if (e instanceof UnprocessableEntityException) throw new ConflictException({ code: 'INVENTORY_IN_USE', message: `This document cannot be voided: ${(e.getResponse() as { message: string }).message}. Adjust the stock first.` });
      throw e;
    }
  }

  // ---------------------------------------------------------------- adjustments and reports

  /** Quantity and/or value adjustment (count corrections, shrinkage, opening stock). Dr/Cr inventory against `accountId`. */
  async adjust(companyId: string, i: { date: string; itemId: string; quantityChange: string; valueChange?: string; accountId: string; memo?: string }, actorId: string, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.item.findFirst({ where: { id: i.itemId, companyId } });
      if (!item) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Product not found' });
      if (!item.trackInventory) throw new BadRequestException({ code: 'NOT_INVENTORY', message: `${item.name} does not track quantity` });
      const acct = await tx.account.findFirst({ where: { id: i.accountId, companyId, isActive: true, role: null } });
      if (!acct || acct.id === item.inventoryAccountId) throw new BadRequestException({ code: 'INVALID_ACCOUNT', message: 'Pick the account the adjustment is charged to (e.g. Inventory shrinkage or Opening balance equity)' });
      const qty = D(i.quantityChange);
      if (qty.isZero() && !i.valueChange) throw new BadRequestException({ code: 'NO_CHANGE', message: 'Change the quantity, the value, or both' });
      const [p] = await this.plan(tx, companyId, [{ itemId: item.id, qty, value: i.valueChange !== undefined ? D(i.valueChange) : undefined, memo: i.memo }]);
      const memo = i.memo || `Inventory adjustment – ${item.name}`;
      let entryId: string | null = null;
      if (!p.value.isZero()) {
        const up = p.value.isPositive();
        const amt = p.value.abs().toFixed(2);
        const entry = await this.ledger.post(tx, { companyId, date: i.date, memo, sourceType: 'inventory_adjustment', sourceId: item.id, actorId, ip, lines: [
          { accountId: p.inventoryAccountId, debit: up ? amt : '0.00', credit: up ? '0.00' : amt, memo },
          { accountId: acct.id, debit: up ? '0.00' : amt, credit: up ? amt : '0.00', memo },
        ] });
        entryId = entry.id;
      }
      await this.commit(tx, companyId, [p], { date: i.date, sourceType: 'adjustment', sourceId: null, journalEntryId: entryId, actorId });
      await this.audit.record({ action: 'inventory.adjusted', companyId, actorId, entityType: 'Item', entityId: item.id, metadata: { quantity: qty.toString(), value: p.value.toFixed(2) }, ip }, tx);
      return { itemId: item.id, qtyOnHand: p.qtyAfter.toString(), value: p.valueAfter.toFixed(2), avgCost: p.avgAfter.toFixed(4), journalEntryId: entryId };
    });
  }

  /** Inventory Valuation Summary as of a date, checked against the inventory accounts in the ledger. */
  async valuation(companyId: string, asOf: string) {
    const date = toDate(asOf);
    const items = await this.prisma.item.findMany({ where: { companyId, trackInventory: true }, orderBy: { name: 'asc' } });
    const sums = await this.prisma.inventoryMovement.groupBy({ by: ['itemId'], where: { companyId, date: { lte: date } }, _sum: { quantity: true, value: true } });
    const by = new Map(sums.map((s) => [s.itemId, s._sum]));
    const rows = items.map((it) => {
      const s = by.get(it.id);
      const qty = D(s?.quantity ?? 0), value = D(s?.value ?? 0);
      return { itemId: it.id, name: it.name, sku: it.sku, qtyOnHand: qty.toString(), avgCost: qty.isZero() ? '0.0000' : value.div(qty).toFixed(4), value: value.toFixed(2), reorderPoint: it.reorderPoint?.toString() ?? null, low: it.reorderPoint !== null && qty.lte(it.reorderPoint.toString()) };
    });
    const total = rows.reduce((a, r) => a.plus(r.value), D(0));
    const accountIds = [...new Set(items.map((i) => i.inventoryAccountId).filter((x): x is string => !!x))];
    const gl = accountIds.length ? await this.prisma.journalLine.aggregate({ where: { companyId, accountId: { in: accountIds }, entry: { status: 'POSTED', date: { lte: date } } }, _sum: { debit: true, credit: true } }) : null;
    const ledger = D(gl?._sum.debit ?? 0).minus(D(gl?._sum.credit ?? 0));
    return { asOf, rows, total: total.toFixed(2), ledgerBalance: ledger.toFixed(2), difference: ledger.minus(total).toFixed(2), reconciled: ledger.eq(total) };
  }

  /** Inventory Valuation Detail: every movement of one item (or all) in a period, with running quantity and value. */
  async detail(companyId: string, q: { from: string; to: string; itemId?: string }) {
    const moves = await this.prisma.inventoryMovement.findMany({ where: { companyId, ...(q.itemId ? { itemId: q.itemId } : {}), date: { gte: toDate(q.from), lte: toDate(q.to) } }, orderBy: [{ itemId: 'asc' }, { createdAt: 'asc' }], include: { item: { select: { name: true } } } });
    return moves.map((m) => ({ id: m.id, date: isoOf(m.date), item: m.item.name, itemId: m.itemId, sourceType: m.sourceType, sourceId: m.sourceId, quantity: D(m.quantity).toString(), value: D(m.value).toFixed(2), qtyAfter: D(m.qtyAfter).toString(), avgCostAfter: D(m.avgCostAfter).toFixed(4), memo: m.memo }));
  }

  async lowStock(companyId: string) {
    const rows = await this.prisma.$queryRaw<{ id: string; name: string; qtyOnHand: string; reorderPoint: string }[]>`
      SELECT id, name, "qtyOnHand"::text AS "qtyOnHand", "reorderPoint"::text AS "reorderPoint" FROM "Item"
      WHERE "companyId" = ${companyId}::uuid AND "trackInventory" AND "isActive" AND "reorderPoint" IS NOT NULL AND "qtyOnHand" <= "reorderPoint" ORDER BY name`;
    return rows.map((r) => ({ ...r, qtyOnHand: D(r.qtyOnHand).toString(), reorderPoint: D(r.reorderPoint).toString() }));
  }
}
