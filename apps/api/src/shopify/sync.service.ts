import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import Decimal from 'decimal.js';
import { Prisma } from '@ca/database';
import {
  BALANCE_TRANSACTIONS_QUERY, DISPUTES_QUERY, ORDERS_QUERY, PAYOUTS_QUERY, ShopifyAuthError, mapBalanceTransaction, mapDispute, mapOrder, mapPayout, orderFingerprint,
  payoutComponentsNet, planBalanceTransaction, planOrder, planPayout, planRefund, type AccountKey, type NormBalanceTransaction, type NormOrder, type NormPayout, type NormRefund, type Plan,
} from '@ca/shopify-integration';
import { LineInput } from '@ca/accounting-engine';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../accounting/ledger.service';
import { ShopifyService, type AccountMap } from './shopify.service';
import { JOB_ATTEMPTS, SyncQueue, SyncQueueImpl } from './queue';

/** Automated postings are attributed to this id (no user is acting). Not a FK. */
export const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

type Tx = Prisma.TransactionClient;
type StoreRow = Prisma.ShopifyStoreGetPayload<object>;
type PostPlan = Extract<Plan, { kind: 'post' }>;
const json = (v: unknown) => v as Prisma.InputJsonValue;

class ReviewError extends Error {}

export function localDate(iso: string | Date, tz: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

interface Progress { phase: string; orders: number; refunds: number; payouts: number; balanceTransactions: number; disputes: number; posted: number; needsReview: number; throttleWaits: number }

@Injectable()
export class ShopifySyncService {
  private readonly log = new Logger('ShopifySync');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly shopify: ShopifyService,
    queue: SyncQueue,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {
    // In inline mode the queue runs jobs through us.
    (queue as SyncQueueImpl).bindInline?.((id) => this.runJob(id, { finalAttempt: true }));
  }

  // =================================================================== job runner

  /**
   * Executes one sync job. Safe to retry: every write is an upsert keyed by Shopify's ids and every posting is guarded by
   * a row lock + unique journal link. On failure the job is FAILED (BullMQ retries) or DEAD on the final attempt.
   */
  async runJob(jobId: string, opts: { finalAttempt?: boolean } = {}): Promise<void> {
    const job = await this.prisma.shopifySyncJob.findUnique({ where: { id: jobId }, include: { store: true } });
    if (!job) return;
    if (job.status === 'SUCCEEDED' || job.status === 'DEAD') return;
    const store = job.store;
    const progress: Progress = { phase: 'starting', orders: 0, refunds: 0, payouts: 0, balanceTransactions: 0, disputes: 0, posted: 0, needsReview: 0, throttleWaits: 0, ...(job.progress as object) };
    const errors: { at: string; ref?: string; message: string }[] = [];
    const save = (extra: Prisma.ShopifySyncJobUpdateInput = {}) =>
      this.prisma.shopifySyncJob.update({ where: { id: jobId }, data: { progress: json(progress), errorLog: json(errors.slice(0, 100)), ...extra } });
    const note = (message: string, ref?: string) => { if (errors.length < 100) errors.push({ at: new Date().toISOString(), ref, message }); };

    await this.prisma.shopifySyncJob.update({ where: { id: jobId }, data: { status: 'RUNNING', attempts: { increment: 1 }, startedAt: job.startedAt ?? new Date(), error: null } });
    try {
      if (store.status !== 'CONNECTED') throw new ShopifyAuthError(`Store is ${store.status.toLowerCase()}`);
      const client = await this.shopify.clientFor(store, () => { progress.throttleWaits += 1; });

      progress.phase = 'orders';
      await save();
      await this.syncOrders(job.kind, job.since, store, client, progress, note, save);

      if (store.paymentsEnabled) {
        for (const [phase, fn] of [['payouts', this.syncPayouts], ['balance transactions', this.syncBalanceTransactions], ['disputes', this.syncDisputes]] as const) {
          progress.phase = phase;
          await save();
          try {
            await fn.call(this, job.kind, job.since, store, client, progress, note);
          } catch (e) {
            if (e instanceof ShopifyAuthError) throw e;
            // A missing Shopify Payments scope must not block order accounting; surface it instead.
            note(`${phase}: ${(e as Error).message}`);
            await this.prisma.shopifyStore.update({ where: { id: store.id }, data: { lastError: `${phase}: ${(e as Error).message}` } });
          }
        }
      }

      progress.phase = 'posting';
      await save();
      const r = await this.postStore(store.id);
      progress.posted = r.posted;
      progress.needsReview = r.review;
      progress.phase = 'done';
      await save({ status: 'SUCCEEDED', finishedAt: new Date() });
      await this.prisma.shopifyStore.update({ where: { id: store.id }, data: { lastSyncAt: new Date(), ...(errors.length ? {} : { lastError: null }) } });
    } catch (e) {
      const message = (e as Error).message;
      const fatal = e instanceof ShopifyAuthError;
      const attemptsMade = (await this.prisma.shopifySyncJob.findUniqueOrThrow({ where: { id: jobId } })).attempts;
      const dead = fatal || opts.finalAttempt || attemptsMade >= JOB_ATTEMPTS;
      note(message);
      await save({ status: dead ? 'DEAD' : 'FAILED', error: message, finishedAt: dead ? new Date() : null });
      await this.prisma.shopifyStore.update({ where: { id: store.id }, data: { lastError: message, ...(fatal ? { status: 'ERROR' } : {}) } });
      this.log.warn(`job ${jobId} ${dead ? 'DEAD' : 'FAILED'}: ${message}`);
      if (!dead) throw e; // lets BullMQ schedule the retry
    }
  }

  /** Called by the worker's scheduler: queue an incremental sync per connected store. */
  async scheduleAll() {
    // Backpressure: only top the backlog up to SYNC_MAX_BACKLOG, longest-unsynced stores first; the rest wait for the next round.
    const room = this.config.SYNC_MAX_BACKLOG - (await this.shopify.backlog());
    if (room <= 0) {
      this.log.warn(`scheduler skipped: ${this.config.SYNC_MAX_BACKLOG}+ sync jobs already pending`);
      return 0;
    }
    const stores = await this.prisma.shopifyStore.findMany({ where: { status: 'CONNECTED' }, orderBy: { lastSyncAt: { sort: 'asc', nulls: 'first' } }, take: room });
    for (const s of stores) await this.shopify.createJob(s, 'INCREMENTAL', { trigger: 'schedule' });
    return stores.length;
  }

  // =================================================================== pulling

  private since(kind: 'HISTORICAL' | 'INCREMENTAL', jobSince: Date | null, store: StoreRow, watermark: Date | null, overlapMs: number): Date | null {
    if (kind === 'HISTORICAL') return jobSince ?? store.historyStart;
    return watermark ? new Date(watermark.getTime() - overlapMs) : store.historyStart;
  }

  private async syncOrders(kind: 'HISTORICAL' | 'INCREMENTAL', jobSince: Date | null, store: StoreRow, client: Awaited<ReturnType<ShopifyService['clientFor']>>, progress: Progress, note: (m: string, r?: string) => void, save: () => Promise<unknown>) {
    const since = this.since(kind, jobSince, store, store.ordersWatermark, 5 * 60_000);
    const query = since ? `updated_at:>='${since.toISOString()}'` : undefined;
    let max = store.ordersWatermark;
    for await (const page of client.paginate<{ orders: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }, unknown>(ORDERS_QUERY, { first: 25, query }, (d) => d.orders)) {
      for (const raw of page) {
        try {
          const n = mapOrder(raw);
          const counts = await this.upsertOrder(store, n);
          progress.orders += 1;
          progress.refunds += counts.refunds;
          const u = new Date(n.updatedAt);
          if (!max || u > max) max = u;
        } catch (e) {
          note(`order ${(raw as { name?: string }).name ?? (raw as { id?: string }).id}: ${(e as Error).message}`, (raw as { id?: string }).id);
        }
      }
      if (max) await this.prisma.shopifyStore.update({ where: { id: store.id }, data: { ordersWatermark: max } });
      await save();
    }
  }

  async upsertOrder(store: StoreRow, n: NormOrder): Promise<{ refunds: number }> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.shopifyOrder.findUnique({ where: { storeId_shopifyId: { storeId: store.id, shopifyId: n.shopifyId } } });
      const base = {
        name: n.name, processedAt: new Date(n.processedAt), updatedAtShopify: new Date(n.updatedAt), cancelledAt: n.cancelledAt ? new Date(n.cancelledAt) : null, test: n.test, currency: n.currency,
        taxesIncluded: n.taxesIncluded, financialStatus: n.financialStatus, total: n.total, tax: n.tax, shipping: n.shippingNet, giftCardSales: n.giftCardSales, discounts: n.discounts, payload: json(n), syncedAt: new Date(),
      };
      let row;
      if (!existing) {
        row = await tx.shopifyOrder.create({ data: { ...base, companyId: store.companyId, storeId: store.id, shopifyId: n.shopifyId } });
      } else if (existing.journalEntryId) {
        const changed = orderFingerprint(n) !== existing.postedFingerprint;
        row = await tx.shopifyOrder.update({ where: { id: existing.id }, data: { ...base, ...(changed ? { postingStatus: 'NEEDS_REVIEW', postingNote: 'Order changed in Shopify after it was posted. The journal was NOT modified; reverse it and re-post, or adjust manually.' } : {}) } });
      } else {
        row = await tx.shopifyOrder.update({ where: { id: existing.id }, data: { ...base, postingStatus: 'PENDING', postingNote: null } });
      }
      for (const t of n.transactions) await this.upsertTxn(tx, store, row.id, t);
      for (const r of n.refunds) {
        for (const t of r.transactions) await this.upsertTxn(tx, store, row.id, t);
        const refundedToPayment = r.transactions.filter((t) => t.kind === 'REFUND' && t.status === 'SUCCESS' && !t.test).reduce((s, t) => s.plus(t.amount), new Decimal(0));
        const rdata = { processedAt: new Date(r.processedAt), total: r.total, tax: r.tax, refundedToPayment: refundedToPayment.toString(), gateway: r.transactions[0]?.gateway ?? null, payload: json(r) };
        const ex = await tx.shopifyRefund.findUnique({ where: { storeId_shopifyId: { storeId: store.id, shopifyId: r.shopifyId } } });
        if (!ex) await tx.shopifyRefund.create({ data: { ...rdata, companyId: store.companyId, storeId: store.id, orderId: row.id, shopifyId: r.shopifyId } });
        else if (!ex.journalEntryId) await tx.shopifyRefund.update({ where: { id: ex.id }, data: { ...rdata, postingStatus: 'PENDING', postingNote: null } });
      }
      return { refunds: n.refunds.length };
    });
  }

  private upsertTxn(tx: Tx, store: StoreRow, orderId: string, t: NormOrder['transactions'][number]) {
    const data = { orderId, numericId: t.numericId, kind: t.kind, status: t.status, gateway: t.gateway, amount: t.amount, currency: t.currency, processedAt: t.processedAt ? new Date(t.processedAt) : null, test: t.test, parentShopifyId: t.parentShopifyId, feeAmount: t.feeAmount, feeTax: t.feeTax };
    return tx.shopifyTransaction.upsert({ where: { storeId_shopifyId: { storeId: store.id, shopifyId: t.shopifyId } }, update: data, create: { ...data, companyId: store.companyId, storeId: store.id, shopifyId: t.shopifyId } });
  }

  private async syncPayouts(kind: 'HISTORICAL' | 'INCREMENTAL', jobSince: Date | null, store: StoreRow, client: Awaited<ReturnType<ShopifyService['clientFor']>>, progress: Progress, _note?: unknown) {
    // Payout status changes after creation (SCHEDULED -> PAID), so always re-read a generous window.
    const since = this.since(kind, jobSince, store, store.paymentsWatermark, 30 * 86_400_000);
    const query = since ? `issued_at:>='${since.toISOString()}'` : undefined;
    let max = store.paymentsWatermark;
    for await (const page of client.paginate<{ shopifyPaymentsAccount: { payouts: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null }, unknown>(PAYOUTS_QUERY, { first: 50, query }, (d) => d.shopifyPaymentsAccount?.payouts)) {
      for (const raw of page) {
        const p = mapPayout(raw);
        const data = { issuedAt: new Date(p.issuedAt), status: p.status, direction: p.direction, net: p.net, currency: p.currency, summary: json(p.summary), externalTraceId: p.externalTraceId, syncedAt: new Date() };
        const ex = await this.prisma.shopifyPayout.findUnique({ where: { storeId_shopifyId: { storeId: store.id, shopifyId: p.shopifyId } } });
        if (!ex) await this.prisma.shopifyPayout.create({ data: { ...data, companyId: store.companyId, storeId: store.id, shopifyId: p.shopifyId } });
        else if (!ex.journalEntryId) await this.prisma.shopifyPayout.update({ where: { id: ex.id }, data: { ...data, postingStatus: 'PENDING', postingNote: null } });
        progress.payouts += 1;
        const at = new Date(p.issuedAt);
        if (!max || at > max) max = at;
      }
    }
    if (max) await this.prisma.shopifyStore.update({ where: { id: store.id }, data: { paymentsWatermark: max } });
  }

  private async syncBalanceTransactions(kind: 'HISTORICAL' | 'INCREMENTAL', jobSince: Date | null, store: StoreRow, client: Awaited<ReturnType<ShopifyService['clientFor']>>, progress: Progress, _note?: unknown) {
    // Payout association is assigned later than the transaction itself, so re-read the last 30 days every run.
    const since = this.since(kind, jobSince, store, store.paymentsWatermark, 30 * 86_400_000);
    const query = since ? `processed_at:>='${since.toISOString()}'` : undefined;
    for await (const page of client.paginate<{ shopifyPaymentsAccount: { balanceTransactions: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null }, unknown>(BALANCE_TRANSACTIONS_QUERY, { first: 100, query }, (d) => d.shopifyPaymentsAccount?.balanceTransactions)) {
      for (const raw of page) {
        const b = mapBalanceTransaction(raw);
        const data = {
          payoutShopifyId: b.payoutShopifyId, payoutStatus: b.payoutStatus, type: b.type, amount: b.amount, fee: b.fee, net: b.net, currency: b.currency, transactionDate: new Date(b.transactionDate), test: b.test,
          sourceType: b.sourceType, sourceId: b.sourceId, sourceOrderTransactionId: b.sourceOrderTransactionId, orderName: b.orderName, adjustmentReason: b.adjustmentReason, syncedAt: new Date(),
        };
        const ex = await this.prisma.shopifyBalanceTransaction.findUnique({ where: { storeId_shopifyId: { storeId: store.id, shopifyId: b.shopifyId } } });
        if (!ex) await this.prisma.shopifyBalanceTransaction.create({ data: { ...data, companyId: store.companyId, storeId: store.id, shopifyId: b.shopifyId } });
        else await this.prisma.shopifyBalanceTransaction.update({ where: { id: ex.id }, data: { ...data, ...(ex.postingStatus === 'NEEDS_REVIEW' || ex.postingStatus === 'PENDING' ? { postingStatus: 'PENDING', postingNote: null } : {}) } });
        progress.balanceTransactions += 1;
      }
    }
  }

  private async syncDisputes(_kind: 'HISTORICAL' | 'INCREMENTAL', _since: Date | null, store: StoreRow, client: Awaited<ReturnType<ShopifyService['clientFor']>>, progress: Progress, _note?: unknown) {
    for await (const page of client.paginate<{ shopifyPaymentsAccount: { disputes: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null }, unknown>(DISPUTES_QUERY, { first: 50 }, (d) => d.shopifyPaymentsAccount?.disputes)) {
      for (const raw of page) {
        const x = mapDispute(raw);
        const data = { amount: x.amount, currency: x.currency, status: x.status, type: x.type, initiatedAt: new Date(x.initiatedAt), finalizedOn: x.finalizedOn ? new Date(x.finalizedOn) : null, orderShopifyId: x.orderShopifyId };
        await this.prisma.shopifyDispute.upsert({ where: { storeId_shopifyId: { storeId: store.id, shopifyId: x.shopifyId } }, update: data, create: { ...data, companyId: store.companyId, storeId: store.id, shopifyId: x.shopifyId } });
        progress.disputes += 1;
      }
    }
  }

  // =================================================================== posting

  async postStore(storeId: string): Promise<{ posted: number; review: number }> {
    let posted = 0;
    let review = 0;
    const open = { in: ['PENDING', 'NEEDS_REVIEW'] as ('PENDING' | 'NEEDS_REVIEW')[] };
    const tally = (r: 'posted' | 'review' | 'other') => { if (r === 'posted') posted += 1; else if (r === 'review') review += 1; };
    // Order matters: refunds need their order posted; payouts are checked against posted components.
    for (const o of await this.prisma.shopifyOrder.findMany({ where: { storeId, postingStatus: open, journalEntryId: null }, select: { id: true }, orderBy: { processedAt: 'asc' } })) tally(await this.postOrder(o.id));
    for (const r of await this.prisma.shopifyRefund.findMany({ where: { storeId, postingStatus: open }, select: { id: true }, orderBy: { processedAt: 'asc' } })) tally(await this.postRefund(r.id));
    for (const b of await this.prisma.shopifyBalanceTransaction.findMany({ where: { storeId, postingStatus: open }, select: { id: true }, orderBy: { transactionDate: 'asc' } })) tally(await this.postBalanceTransaction(b.id));
    for (const p of await this.prisma.shopifyPayout.findMany({ where: { storeId, postingStatus: open }, select: { id: true }, orderBy: { issuedAt: 'asc' } })) tally(await this.postPayout(p.id));
    return { posted, review };
  }

  /** Symbolic account key -> ledger account id. Missing mapping is a review item, never a guess. */
  private async accountIds(tx: Tx, store: StoreRow, classified?: string | null) {
    const roles = await this.ledger.roleAccounts(tx, store.companyId);
    const map = store.accountMap as AccountMap;
    return (key: AccountKey): string => {
      const id =
        key === 'tax:GST_HST' ? roles.taxAccounts.gstHstPayable : key === 'tax:QST' ? roles.taxAccounts.qstPayable : key === 'tax:PST' ? roles.taxAccounts.pstPayable
        : key === 'classified' ? (classified ?? undefined) : map[key];
      if (!id) throw new ReviewError(`No ledger account is mapped for "${key}". Set it in the store's account mapping.`);
      return id;
    };
  }

  private async journal(tx: Tx, store: StoreRow, plan: PostPlan, p: { date: string; sourceType: string; sourceId: string; memo: string; classified?: string | null }) {
    const acct = await this.accountIds(tx, store, p.classified);
    const lines: LineInput[] = plan.lines.map((l) => ({ accountId: acct(l.account), debit: l.debit, credit: l.credit, memo: l.memo }));
    try {
      return await this.ledger.post(tx, { companyId: store.companyId, date: p.date, memo: p.memo, sourceType: p.sourceType, sourceId: p.sourceId, lines, actorId: SYSTEM_ACTOR });
    } catch (e) {
      if (e instanceof HttpException) throw new ReviewError(`Could not post: ${(e.getResponse() as { message?: string }).message ?? e.message}`);
      throw e;
    }
  }

  private async lock(tx: Tx, table: string, id: string) {
    await tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1::uuid FOR UPDATE`, id);
  }

  async postOrder(id: string): Promise<'posted' | 'review' | 'other'> {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, 'ShopifyOrder', id);
      const row = await tx.shopifyOrder.findUniqueOrThrow({ where: { id }, include: { store: { include: { company: { select: { baseCurrency: true } } } } } });
      if (row.journalEntryId || row.postingStatus === 'POSTED' || row.postingStatus === 'SKIPPED') return 'other';
      const n = row.payload as unknown as NormOrder;
      const set = (postingStatus: 'PENDING' | 'SKIPPED' | 'NEEDS_REVIEW', postingNote: string) => tx.shopifyOrder.update({ where: { id }, data: { postingStatus, postingNote } });
      if (n.currency !== row.store.company.baseCurrency) { await set('NEEDS_REVIEW', `Order currency ${n.currency} differs from the company's ${row.store.company.baseCurrency}`); return 'review'; }
      const plan = planOrder(n);
      if (plan.kind === 'skip') { await set('SKIPPED', plan.reason); return 'other'; }
      if (plan.kind === 'wait') { await set('PENDING', plan.reason); return 'other'; }
      if (plan.kind === 'review') { await set('NEEDS_REVIEW', plan.reason); return 'review'; }
      try {
        const e = await this.journal(tx, row.store, plan, { date: localDate(n.processedAt, row.store.timezone), sourceType: 'shopify_order', sourceId: id, memo: `Shopify order ${n.name}` });
        await tx.shopifyOrder.update({ where: { id }, data: { postingStatus: 'POSTED', postingNote: null, journalEntryId: e.id, postedFingerprint: orderFingerprint(n) } });
        return 'posted';
      } catch (e) {
        if (e instanceof ReviewError) { await set('NEEDS_REVIEW', e.message); return 'review'; }
        throw e;
      }
    });
  }

  async postRefund(id: string): Promise<'posted' | 'review' | 'other'> {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, 'ShopifyRefund', id);
      const row = await tx.shopifyRefund.findUniqueOrThrow({ where: { id }, include: { store: true, order: true } });
      if (row.journalEntryId || row.postingStatus === 'POSTED' || row.postingStatus === 'SKIPPED') return 'other';
      const set = (postingStatus: 'PENDING' | 'SKIPPED' | 'NEEDS_REVIEW', postingNote: string) => tx.shopifyRefund.update({ where: { id }, data: { postingStatus, postingNote } });
      const order = row.order.payload as unknown as NormOrder;
      if (row.order.test) { await set('SKIPPED', 'Test order'); return 'other'; }
      if (!row.order.journalEntryId) { await set('PENDING', 'Waiting for the order to be posted first'); return 'other'; }
      const plan = planRefund(order, row.payload as unknown as NormRefund);
      if (plan.kind === 'skip') { await set('SKIPPED', plan.reason); return 'other'; }
      if (plan.kind !== 'post') { await set('NEEDS_REVIEW', plan.kind === 'review' || plan.kind === 'wait' ? plan.reason : ''); return 'review'; }
      try {
        const e = await this.journal(tx, row.store, plan, { date: localDate(row.processedAt, row.store.timezone), sourceType: 'shopify_refund', sourceId: id, memo: `Shopify refund on ${order.name}` });
        await tx.shopifyRefund.update({ where: { id }, data: { postingStatus: 'POSTED', postingNote: null, journalEntryId: e.id } });
        return 'posted';
      } catch (e) {
        if (e instanceof ReviewError) { await set('NEEDS_REVIEW', e.message); return 'review'; }
        throw e;
      }
    });
  }

  private btNorm(r: Prisma.ShopifyBalanceTransactionGetPayload<object>): NormBalanceTransaction {
    return { shopifyId: r.shopifyId, type: r.type, test: r.test, transactionDate: r.transactionDate.toISOString(), amount: r.amount.toString(), fee: r.fee.toString(), net: r.net.toString(), currency: r.currency, sourceType: r.sourceType, sourceId: r.sourceId, sourceOrderTransactionId: r.sourceOrderTransactionId, adjustmentReason: r.adjustmentReason, orderName: r.orderName, payoutShopifyId: r.payoutShopifyId, payoutStatus: r.payoutStatus };
  }

  async postBalanceTransaction(id: string): Promise<'posted' | 'review' | 'other'> {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, 'ShopifyBalanceTransaction', id);
      const row = await tx.shopifyBalanceTransaction.findUniqueOrThrow({ where: { id }, include: { store: true } });
      if (row.postingStatus === 'POSTED' || row.postingStatus === 'SKIPPED') return 'other';
      const plans = planBalanceTransaction(this.btNorm(row), row.classifiedAccountId ? 'classified' : undefined);
      const date = localDate(row.transactionDate, row.store.timezone);
      const notes: string[] = [];
      let feeJ = row.feeJournalId;
      let amtJ = row.amountJournalId;
      const run = async (plan: Plan, existing: string | null, sourceType: string, memo: string): Promise<string | null> => {
        if (existing) return existing;
        if (plan.kind === 'review') { notes.push(plan.reason); return null; }
        if (plan.kind !== 'post') return null;
        try {
          return (await this.journal(tx, row.store, plan, { date, sourceType, sourceId: id, memo, classified: row.classifiedAccountId })).id;
        } catch (e) {
          if (e instanceof ReviewError) { notes.push(e.message); return null; }
          throw e;
        }
      };
      feeJ = await run(plans.fee, feeJ, 'shopify_bt_fee', `Shopify fee ${row.orderName ?? row.type}`);
      amtJ = await run(plans.amount, amtJ, 'shopify_bt', `Shopify ${row.type}${row.orderName ? ` ${row.orderName}` : ''}`);
      const status = notes.length ? 'NEEDS_REVIEW' : feeJ || amtJ ? 'POSTED' : 'SKIPPED';
      await tx.shopifyBalanceTransaction.update({ where: { id }, data: { feeJournalId: feeJ, amountJournalId: amtJ, postingStatus: status, postingNote: notes.join(' | ') || null } });
      return status === 'POSTED' ? 'posted' : status === 'NEEDS_REVIEW' ? 'review' : 'other';
    });
  }

  async postPayout(id: string): Promise<'posted' | 'review' | 'other'> {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, 'ShopifyPayout', id);
      const row = await tx.shopifyPayout.findUniqueOrThrow({ where: { id }, include: { store: true } });
      if (row.journalEntryId || row.postingStatus === 'POSTED' || row.postingStatus === 'SKIPPED') return 'other';
      const set = (postingStatus: 'PENDING' | 'SKIPPED' | 'NEEDS_REVIEW', postingNote: string) => tx.shopifyPayout.update({ where: { id }, data: { postingStatus, postingNote } });
      const bts = await tx.shopifyBalanceTransaction.findMany({ where: { storeId: row.storeId, payoutShopifyId: row.shopifyId } });
      const norm: NormPayout = { shopifyId: row.shopifyId, issuedAt: row.issuedAt.toISOString(), status: row.status, direction: row.direction as 'DEPOSIT' | 'WITHDRAWAL', net: row.net.toString(), currency: row.currency, externalTraceId: row.externalTraceId, summary: {} };
      const plan = planPayout(norm, payoutComponentsNet(bts.map((b) => this.btNorm(b))));
      if (plan.kind === 'skip') { await set('SKIPPED', plan.reason); return 'other'; }
      if (plan.kind === 'wait') { await set('PENDING', plan.reason); return 'other'; }
      if (plan.kind === 'review') { await set('NEEDS_REVIEW', plan.reason); return 'review'; }
      try {
        const e = await this.journal(tx, row.store, plan, { date: localDate(row.issuedAt, row.store.timezone), sourceType: 'shopify_payout', sourceId: id, memo: `Shopify payout ${row.shopifyId.split('/').pop()}` });
        await tx.shopifyPayout.update({ where: { id }, data: { postingStatus: 'POSTED', postingNote: null, journalEntryId: e.id } });
        return 'posted';
      } catch (e) {
        if (e instanceof ReviewError) { await set('NEEDS_REVIEW', e.message); return 'review'; }
        throw e;
      }
    });
  }

  /** Manual "try posting again" (e.g. after fixing the account mapping or unlocking a period). */
  async repost(companyId: string, storeId: string, actorId: string, ip: string | null) {
    const store = await this.shopify.getStore(companyId, storeId);
    const r = await this.postStore(store.id);
    await this.audit.record({ action: 'shopify.repost', companyId, actorId, entityType: 'ShopifyStore', entityId: storeId, metadata: r, ip });
    return r;
  }
}
