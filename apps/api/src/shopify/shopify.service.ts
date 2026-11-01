import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Prisma } from '@ca/database';
import {
  SHOP_QUERY, ShopifyClient, WEBHOOK_CREATE_MUTATION, WEBHOOK_TOPICS, buildAuthorizeUrl, exchangeCode, isValidShopDomain, normaliseShopInput, refreshAccessToken,
  requiredScopes, verifyOAuthCallbackHmac, type NormBalanceTransaction,
} from '@ca/shopify-integration';
import { AppConfig, CONFIG } from '../config';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { decrypt, encrypt, randomToken } from '../common/crypto';
import { seedAccounting } from '../accounting/setup';
import { SyncQueue } from './queue';

export const SHOPIFY_FETCH = Symbol('SHOPIFY_FETCH');
export const ACCOUNT_KEYS = ['clearing', 'otherClearing', 'sales', 'shipping', 'giftCard', 'fees', 'bank', 'refunds', 'reserve', 'disputeHold', 'chargebackFees', 'shippingExpense'] as const;
export type AccountMap = Partial<Record<(typeof ACCOUNT_KEYS)[number], string>>;

/** Default mapping by chart-of-accounts code (Canadian template). Editable per store. */
const DEFAULT_CODES: Record<(typeof ACCOUNT_KEYS)[number], string> = {
  clearing: '1030', otherClearing: '1040', sales: '4000', shipping: '4100', giftCard: '2510', fees: '6120', bank: '1010',
  refunds: '4800', reserve: '1035', disputeHold: '1036', chargebackFees: '6125', shippingExpense: '6165',
};

type StoreRow = Prisma.ShopifyStoreGetPayload<object>;

@Injectable()
export class ShopifyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: SyncQueue,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(SHOPIFY_FETCH) private readonly fetchFn: typeof fetch,
  ) {}

  private creds() {
    if (!this.config.SHOPIFY_CLIENT_ID || !this.config.SHOPIFY_CLIENT_SECRET) {
      throw new ServiceUnavailableException({ code: 'SHOPIFY_NOT_CONFIGURED', message: 'Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (from your Shopify app in the Dev Dashboard)' });
    }
    return { clientId: this.config.SHOPIFY_CLIENT_ID, clientSecret: this.config.SHOPIFY_CLIENT_SECRET };
  }
  redirectUri() { return `${new URL(this.config.WEB_ORIGIN).origin}/api/shopify/callback`; }

  // ---------- connect (OAuth authorization-code grant) ----------

  async startConnect(companyId: string, userId: string, shopInput: string, ip: string | null) {
    const { clientId } = this.creds();
    const shop = normaliseShopInput(shopInput);
    if (!shop) throw new BadRequestException({ code: 'INVALID_SHOP', message: 'Enter your store as your-store.myshopify.com' });
    const existing = await this.prisma.shopifyStore.findUnique({ where: { shopDomain: shop } });
    if (existing && existing.status !== 'DISCONNECTED') {
      throw new ConflictException({ code: 'SHOP_IN_USE', message: existing.companyId === companyId ? 'This store is already connected' : 'This store is connected to another company' });
    }
    const state = randomToken(24);
    await this.prisma.shopifyOAuthState.create({ data: { state, companyId, userId, shopDomain: shop, expiresAt: new Date(Date.now() + 10 * 60_000) } });
    await this.audit.record({ action: 'shopify.connect_started', companyId, actorId: userId, metadata: { shop }, ip });
    return { authorizeUrl: buildAuthorizeUrl({ shop, clientId, scopes: requiredScopes({ allOrders: this.config.SHOPIFY_REQUEST_ALL_ORDERS === 'true' }), redirectUri: this.redirectUri(), state }) };
  }

  /** Handles Shopify's redirect. Order of checks follows Shopify's documentation: state, HMAC, shop domain. */
  async finishConnect(query: Record<string, string>, ip: string | null): Promise<{ companyId: string; ok: boolean; error?: string }> {
    const { clientId, clientSecret } = this.creds();
    const st = query.state ? await this.prisma.shopifyOAuthState.findUnique({ where: { state: query.state } }) : null;
    // State is single-use: delete it whatever happens next.
    if (st) await this.prisma.shopifyOAuthState.delete({ where: { state: st.state } }).catch(() => undefined);
    if (!st || st.expiresAt < new Date()) return { companyId: '', ok: false, error: 'This connection attempt expired or is invalid. Start again.' };
    const fail = (error: string) => ({ companyId: st.companyId, ok: false, error });
    if (!verifyOAuthCallbackHmac(query, clientSecret)) return fail('Shopify signature check failed.');
    if (!query.shop || !isValidShopDomain(query.shop) || query.shop !== st.shopDomain || !query.code) return fail('Unexpected store in the response.');

    try {
      const tok = await exchangeCode({ shop: query.shop, clientId, clientSecret, code: query.code }, this.fetchFn);
      const probe = new ShopifyClient({ shop: query.shop, apiVersion: this.config.SHOPIFY_API_VERSION, getAccessToken: async () => tok.accessToken, fetch: this.fetchFn });
      const info = await probe.request<{ shop: { name: string; currencyCode: string; ianaTimezone: string }; shopifyPaymentsAccount: { activated: boolean } | null }>(SHOP_QUERY, {}, { allowPartial: true });
      const shop = info.data?.shop;
      if (!shop) return fail('Could not read the shop.');
      const company = await this.prisma.company.findUniqueOrThrow({ where: { id: st.companyId } });
      if (shop.currencyCode !== company.baseCurrency) {
        return fail(`This store sells in ${shop.currencyCode} but the company's books are in ${company.baseCurrency}. Multi-currency is not supported yet.`);
      }
      const store = await this.prisma.$transaction(async (tx) => {
        await seedAccounting(tx, st.companyId); // make sure the Shopify accounts exist
        const accountMap = await this.defaultAccountMap(tx, st.companyId);
        const data = {
          companyId: st.companyId, shopName: shop.name, status: 'CONNECTED' as const, scopes: tok.scope, accessTokenEnc: encrypt(tok.accessToken, this.config.ENCRYPTION_KEY),
          refreshTokenEnc: tok.refreshToken ? encrypt(tok.refreshToken, this.config.ENCRYPTION_KEY) : null, accessTokenExpiresAt: tok.expiresAt, refreshTokenExpiresAt: tok.refreshTokenExpiresAt,
          apiVersion: this.config.SHOPIFY_API_VERSION, currency: shop.currencyCode, timezone: shop.ianaTimezone, paymentsEnabled: Boolean(info.data?.shopifyPaymentsAccount?.activated),
          accountMap: accountMap as Prisma.InputJsonValue, lastError: null,
        };
        const prev = await tx.shopifyStore.findUnique({ where: { shopDomain: query.shop } });
        if (prev && prev.companyId !== st.companyId) throw new ConflictException({ code: 'SHOP_IN_USE', message: 'This store is connected to another company' });
        return prev
          ? tx.shopifyStore.update({ where: { id: prev.id }, data })
          : tx.shopifyStore.create({ data: { ...data, shopDomain: query.shop, historyStart: new Date(Date.now() - 60 * 86_400_000) } });
      });
      await this.audit.record({ action: 'shopify.connected', companyId: st.companyId, actorId: st.userId, entityType: 'ShopifyStore', entityId: store.id, metadata: { shop: query.shop, scopes: tok.scope }, ip });
      await this.registerWebhooks(store).catch(async (e) => { await this.prisma.shopifyStore.update({ where: { id: store.id }, data: { lastError: `Webhook registration failed: ${(e as Error).message}` } }); });
      await this.createJob(store, 'INCREMENTAL', { trigger: 'connect', requestedById: st.userId });
      return { companyId: st.companyId, ok: true };
    } catch (e) {
      if (e instanceof ConflictException) return fail(e.message);
      return fail(`Could not complete the connection: ${(e as Error).message}`);
    }
  }

  private async defaultAccountMap(tx: Prisma.TransactionClient, companyId: string): Promise<AccountMap> {
    const rows = await tx.account.findMany({ where: { companyId, code: { in: Object.values(DEFAULT_CODES) } } });
    const byCode = new Map(rows.map((r) => [r.code, r.id]));
    return Object.fromEntries(ACCOUNT_KEYS.flatMap((k) => (byCode.get(DEFAULT_CODES[k]) ? [[k, byCode.get(DEFAULT_CODES[k])!]] : [])));
  }

  /** Webhooks are an accelerator: they only trigger an incremental pull. Skipped unless a public URL is configured. */
  private async registerWebhooks(store: StoreRow) {
    if (!this.config.SHOPIFY_WEBHOOK_BASE_URL) return;
    const uri = `${this.config.SHOPIFY_WEBHOOK_BASE_URL.replace(/\/$/, '')}/api/webhooks/shopify`;
    const c = await this.clientFor(store);
    for (const topic of WEBHOOK_TOPICS) {
      const r = await c.request<{ webhookSubscriptionCreate: { userErrors: { message: string }[] } }>(WEBHOOK_CREATE_MUTATION, { topic, uri });
      const errs = r.data?.webhookSubscriptionCreate.userErrors ?? [];
      // "already exists" style errors are fine on reconnect
      if (errs.length && !errs.every((e) => /already|taken|exists/i.test(e.message))) throw new Error(`${topic}: ${errs.map((e) => e.message).join('; ')}`);
    }
  }

  // ---------- tokens and client ----------

  /** Returns a valid access token, refreshing (and rotating the refresh token) under a row lock when it is about to expire. */
  async accessToken(storeId: string): Promise<string> {
    const need = (s: StoreRow) => s.accessTokenExpiresAt && s.refreshTokenEnc && s.accessTokenExpiresAt.getTime() - Date.now() < 60_000;
    const peek = await this.prisma.shopifyStore.findUniqueOrThrow({ where: { id: storeId } });
    if (!need(peek)) return decrypt(peek.accessTokenEnc, this.config.ENCRYPTION_KEY);
    const { clientId, clientSecret } = this.creds();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ShopifyStore" WHERE id = ${storeId}::uuid FOR UPDATE`;
      const s = await tx.shopifyStore.findUniqueOrThrow({ where: { id: storeId } });
      if (!need(s)) return decrypt(s.accessTokenEnc, this.config.ENCRYPTION_KEY); // someone else refreshed
      const t = await refreshAccessToken({ shop: s.shopDomain, clientId, clientSecret, refreshToken: decrypt(s.refreshTokenEnc!, this.config.ENCRYPTION_KEY) }, this.fetchFn);
      await tx.shopifyStore.update({
        where: { id: storeId },
        data: { accessTokenEnc: encrypt(t.accessToken, this.config.ENCRYPTION_KEY), refreshTokenEnc: t.refreshToken ? encrypt(t.refreshToken, this.config.ENCRYPTION_KEY) : s.refreshTokenEnc, accessTokenExpiresAt: t.expiresAt, refreshTokenExpiresAt: t.refreshTokenExpiresAt ?? s.refreshTokenExpiresAt },
      });
      return t.accessToken;
    });
  }

  async clientFor(store: StoreRow, onThrottle?: (ms: number, why: string) => void) {
    return new ShopifyClient({ shop: store.shopDomain, apiVersion: store.apiVersion, getAccessToken: () => this.accessToken(store.id), fetch: this.fetchFn, onThrottle });
  }

  // ---------- stores ----------

  private sanitize(s: StoreRow) {
    const { accessTokenEnc: _a, refreshTokenEnc: _r, ...rest } = s;
    return rest;
  }

  async listStores(companyId: string) {
    const stores = await this.prisma.shopifyStore.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } });
    return Promise.all(stores.map(async (s) => {
      const [review, orders, lastJob] = await Promise.all([
        this.prisma.$queryRaw<{ n: bigint }[]>`SELECT (
          (SELECT count(*) FROM "ShopifyOrder" WHERE "storeId" = ${s.id}::uuid AND "postingStatus" = 'NEEDS_REVIEW') +
          (SELECT count(*) FROM "ShopifyRefund" WHERE "storeId" = ${s.id}::uuid AND "postingStatus" = 'NEEDS_REVIEW') +
          (SELECT count(*) FROM "ShopifyBalanceTransaction" WHERE "storeId" = ${s.id}::uuid AND "postingStatus" = 'NEEDS_REVIEW') +
          (SELECT count(*) FROM "ShopifyPayout" WHERE "storeId" = ${s.id}::uuid AND "postingStatus" = 'NEEDS_REVIEW')) AS n`,
        this.prisma.shopifyOrder.count({ where: { storeId: s.id } }),
        this.prisma.shopifySyncJob.findFirst({ where: { storeId: s.id }, orderBy: { createdAt: 'desc' } }),
      ]);
      return { ...this.sanitize(s), health: { needsReview: Number(review[0].n), orders, lastJob } };
    }));
  }

  async getStore(companyId: string, id: string) {
    const s = await this.prisma.shopifyStore.findFirst({ where: { id, companyId } });
    if (!s) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Store not found' });
    return s;
  }

  async updateSettings(companyId: string, id: string, input: { accountMap?: AccountMap; historyStart?: string | null }, actorId: string, ip: string | null) {
    const s = await this.getStore(companyId, id);
    const data: Prisma.ShopifyStoreUpdateInput = {};
    if (input.accountMap) {
      const ids = Object.values(input.accountMap).filter((x): x is string => !!x);
      const found = await this.prisma.account.findMany({ where: { companyId, id: { in: ids }, isActive: true } });
      if (found.length !== new Set(ids).size) throw new BadRequestException({ code: 'INVALID_ACCOUNT', message: 'Every mapped account must exist, be active, and belong to this company' });
      data.accountMap = { ...(s.accountMap as AccountMap), ...input.accountMap } as Prisma.InputJsonValue;
    }
    if (input.historyStart !== undefined) data.historyStart = input.historyStart ? new Date(input.historyStart) : null;
    const u = await this.prisma.shopifyStore.update({ where: { id }, data });
    await this.audit.record({ action: 'shopify.settings_updated', companyId, actorId, entityType: 'ShopifyStore', entityId: id, ip });
    return this.sanitize(u);
  }

  async disconnect(companyId: string, id: string, actorId: string | null, ip: string | null) {
    const s = await this.getStore(companyId, id);
    await this.prisma.shopifyStore.update({ where: { id }, data: { status: 'DISCONNECTED', accessTokenEnc: 'revoked', refreshTokenEnc: null, accessTokenExpiresAt: null } });
    await this.audit.record({ action: 'shopify.disconnected', companyId, actorId, entityType: 'ShopifyStore', entityId: id, metadata: { shop: s.shopDomain }, ip });
  }

  // ---------- jobs ----------

  async createJob(store: StoreRow, kind: 'HISTORICAL' | 'INCREMENTAL', o: { trigger: string; requestedById?: string | null; since?: Date | null }) {
    try {
      const job = await this.prisma.shopifySyncJob.create({ data: { companyId: store.companyId, storeId: store.id, kind, trigger: o.trigger, requestedById: o.requestedById ?? null, since: o.since ?? null } });
      await this.queue.enqueue(job.id);
      return job;
    } catch (e) {
      // The partial unique index allows only one active job per store+kind: reuse it instead of piling up.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const active = await this.prisma.shopifySyncJob.findFirst({ where: { storeId: store.id, kind, status: { in: ['PENDING', 'RUNNING'] } } });
        if (active) return active;
      }
      throw e;
    }
  }

  /** Pending + running sync jobs across the whole platform (the database row is the source of truth, whatever the queue holds). */
  backlog() {
    return this.prisma.shopifySyncJob.count({ where: { status: { in: ['PENDING', 'RUNNING'] } } });
  }

  async requestSync(companyId: string, storeId: string, kind: 'HISTORICAL' | 'INCREMENTAL', since: string | undefined, actorId: string, ip: string | null) {
    const s = await this.getStore(companyId, storeId);
    if (s.status !== 'CONNECTED') throw new UnprocessableEntityException({ code: 'NOT_CONNECTED', message: 'Store is not connected' });
    // Asking again for a store that already has a job queued is answered with that job, busy or not.
    const active = await this.prisma.shopifySyncJob.findFirst({ where: { storeId, kind, status: { in: ['PENDING', 'RUNNING'] } } });
    if (active) return active;
    // Backpressure: a small NAS works through jobs one at a time; refuse to pile up more than it can clear.
    if ((await this.backlog()) >= this.config.SYNC_MAX_BACKLOG) {
      throw new ServiceUnavailableException({ code: 'QUEUE_BUSY', message: 'Background jobs are backed up. Your data is safe; try this sync again in a few minutes.' });
    }
    const job = await this.createJob(s, kind, { trigger: 'manual', requestedById: actorId, since: since ? new Date(since) : null });
    await this.audit.record({ action: 'shopify.sync_requested', companyId, actorId, entityType: 'ShopifySyncJob', entityId: job.id, metadata: { kind }, ip });
    return job;
  }

  listJobs(companyId: string, storeId?: string) {
    return this.prisma.shopifySyncJob.findMany({ where: { companyId, ...(storeId ? { storeId } : {}) }, orderBy: { createdAt: 'desc' }, take: 50 });
  }

  // ---------- reads ----------

  async reviewQueue(companyId: string) {
    const w = { companyId, postingStatus: 'NEEDS_REVIEW' as const };
    const [orders, refunds, bts, payouts] = await Promise.all([
      this.prisma.shopifyOrder.findMany({ where: w, select: { id: true, name: true, processedAt: true, total: true, postingNote: true }, take: 100, orderBy: { processedAt: 'desc' } }),
      this.prisma.shopifyRefund.findMany({ where: w, select: { id: true, shopifyId: true, processedAt: true, total: true, postingNote: true }, take: 100 }),
      this.prisma.shopifyBalanceTransaction.findMany({ where: w, select: { id: true, type: true, transactionDate: true, amount: true, fee: true, orderName: true, adjustmentReason: true, postingNote: true }, take: 100, orderBy: { transactionDate: 'desc' } }),
      this.prisma.shopifyPayout.findMany({ where: w, select: { id: true, shopifyId: true, issuedAt: true, net: true, postingNote: true }, take: 100 }),
    ]);
    return { orders, refunds, balanceTransactions: bts, payouts };
  }

  listOrders(companyId: string, status?: string) {
    return this.prisma.shopifyOrder.findMany({
      where: { companyId, ...(status ? { postingStatus: status as 'PENDING' } : {}) }, orderBy: { processedAt: 'desc' }, take: 200,
      select: { id: true, name: true, processedAt: true, total: true, tax: true, shipping: true, giftCardSales: true, financialStatus: true, postingStatus: true, postingNote: true, journalEntryId: true, test: true },
    });
  }

  listPayouts(companyId: string) {
    return this.prisma.shopifyPayout.findMany({ where: { companyId }, orderBy: { issuedAt: 'desc' }, take: 200 });
  }

  /** Everything needed to reconcile one payout: components, tie-out, posting status. Bank matching arrives with the banking module. */
  async payoutDetail(companyId: string, id: string) {
    const p = await this.prisma.shopifyPayout.findFirst({ where: { id, companyId } });
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payout not found' });
    const bts = await this.prisma.shopifyBalanceTransaction.findMany({ where: { storeId: p.storeId, payoutShopifyId: p.shopifyId }, orderBy: { transactionDate: 'asc' } });
    const orderNames = [...new Set(bts.map((b) => b.orderName).filter((x): x is string => !!x))];
    const orders = orderNames.length ? await this.prisma.shopifyOrder.findMany({ where: { storeId: p.storeId, name: { in: orderNames } }, select: { name: true, total: true, postingStatus: true, journalEntryId: true } }) : [];
    const D = (v: Prisma.Decimal | string) => new Decimal(v.toString());
    const real = bts.filter((b) => !b.test);
    const comp = real.filter((b) => b.type !== 'TRANSFER');
    const sum = (rows: typeof comp, k: 'amount' | 'fee' | 'net') => rows.reduce((s, r) => s.plus(D(r[k])), new Decimal(0));
    const group = (pred: (b: (typeof comp)[number]) => boolean) => { const r = comp.filter(pred); return { count: r.length, gross: sum(r, 'amount').toFixed(2), fees: sum(r, 'fee').toFixed(2), net: sum(r, 'net').toFixed(2) }; };
    const componentsNet = sum(comp, 'net');
    const unresolved = comp.filter((b) => b.postingStatus === 'NEEDS_REVIEW' || b.postingStatus === 'PENDING').length;
    return {
      payout: p,
      components: {
        charges: group((b) => b.type === 'CHARGE'),
        refunds: group((b) => b.type === 'REFUND'),
        adjustments: group((b) => !['CHARGE', 'REFUND'].includes(b.type) && !/RESERVED_FUNDS/.test(b.type)),
        reserves: group((b) => /RESERVED_FUNDS/.test(b.type)),
        total: { count: comp.length, gross: sum(comp, 'amount').toFixed(2), fees: sum(comp, 'fee').toFixed(2), net: componentsNet.toFixed(2) },
      },
      tieOut: { componentsNet: componentsNet.toFixed(2), payoutNet: D(p.net).toFixed(2), difference: componentsNet.minus(D(p.net)).toFixed(2), ok: p.direction === 'WITHDRAWAL' ? null : componentsNet.eq(D(p.net)), unresolvedComponents: unresolved },
      transactions: bts.map((b) => ({ id: b.id, type: b.type, date: b.transactionDate, amount: b.amount, fee: b.fee, net: b.net, orderName: b.orderName, postingStatus: b.postingStatus, postingNote: b.postingNote })),
      orders,
      bankMatch: null as null, // Milestone 4: matched bank deposit
    };
  }

  async classifyBalanceTransaction(companyId: string, id: string, accountId: string, actorId: string, ip: string | null) {
    const bt = await this.prisma.shopifyBalanceTransaction.findFirst({ where: { id, companyId } });
    if (!bt) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Balance transaction not found' });
    if (bt.amountJournalId) throw new ConflictException({ code: 'ALREADY_POSTED', message: 'Already posted' });
    const acct = await this.prisma.account.findFirst({ where: { id: accountId, companyId, isActive: true, role: null } });
    if (!acct) throw new BadRequestException({ code: 'INVALID_ACCOUNT', message: 'Pick an active, non-control account of this company' });
    await this.prisma.shopifyBalanceTransaction.update({ where: { id }, data: { classifiedAccountId: accountId, postingStatus: 'PENDING', postingNote: null } });
    await this.audit.record({ action: 'shopify.balance_transaction_classified', companyId, actorId, entityType: 'ShopifyBalanceTransaction', entityId: id, metadata: { type: bt.type, accountCode: acct.code }, ip });
    return { ok: true };
  }
}

export type { NormBalanceTransaction };

// ---------------------------------------------------------------------------------------------
// Webhooks are triggers, not data sources: a verified, de-duplicated delivery queues an incremental pull
// through the GraphQL API, which is the single authoritative path into the books.
// ---------------------------------------------------------------------------------------------
export interface WebhookResult { status: 'queued' | 'duplicate' | 'ignored' | 'disconnected' }

declare module './shopify.service' {
  interface ShopifyService {
    handleWebhook(shopDomain: string, topic: string, webhookId: string): Promise<WebhookResult>;
  }
}

ShopifyService.prototype.handleWebhook = async function (this: ShopifyService, shopDomain: string, topic: string, webhookId: string): Promise<WebhookResult> {
  const self = this as unknown as { prisma: PrismaService; createJob: ShopifyService['createJob']; disconnect: ShopifyService['disconnect'] };
  const store = await self.prisma.shopifyStore.findUnique({ where: { shopDomain } });
  if (!store || store.status === 'DISCONNECTED') return { status: 'ignored' };
  try {
    await self.prisma.shopifyWebhookEvent.create({ data: { webhookId, companyId: store.companyId, storeId: store.id, topic } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { status: 'duplicate' };
    throw e;
  }
  if (topic === 'app/uninstalled') {
    await self.disconnect(store.companyId, store.id, null, null);
    return { status: 'disconnected' };
  }
  await self.createJob(store, 'INCREMENTAL', { trigger: 'webhook' });
  await self.prisma.shopifyWebhookEvent.update({ where: { webhookId }, data: { processedAt: new Date() } });
  return { status: 'queued' };
};
