import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@ca/database';
import { btNode, ontarioOrder, payoutNode, quebecOrderTaxIncluded, refund, txn } from '@ca/shopify-integration/dist/fixtures';
import { ShopifySyncService } from '../src/shopify/sync.service';
import { shopifyFetch } from '../src/shopify/shopify.module';
import { PASSWORD, ORIGIN, agent, bootApp, resetDb, setupAdmin } from './helpers';
import { fakeShopifyFetch, newFake, type FakeState } from './fake-shopify';

const SECRET = 'shpss_unit_test_secret';
const SHOP = 'maple-goods.myshopify.com';
let app: INestApplication;
let prisma: PrismaClient;
let sync: ShopifySyncService;
let fake: FakeState;

beforeAll(async () => {
  ({ app, prisma } = await bootApp({ SHOPIFY_CLIENT_ID: 'cid', SHOPIFY_CLIENT_SECRET: SECRET, QUEUE_MODE: 'none' }));
  sync = app.get(ShopifySyncService);
});
afterAll(async () => { await prisma.$disconnect(); await app.close(); });
beforeEach(async () => { await resetDb(prisma); fake = newFake(); shopifyFetch.fn = fakeShopifyFetch(fake); });

type A = ReturnType<typeof agent>;
const sign = (params: Record<string, string>) => createHmac('sha256', SECRET).update(Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&')).digest('hex');

async function company(root: A, name = 'Maple Goods Inc.') {
  const c = (await root.post('/admin/companies', { legalName: name, province: 'ON', ownerEmail: 'root@example.test' }).expect(201)).body;
  await root.post(`/companies/${c.id}/fiscal-years`, { startDate: '2026-01-01' });
  const accts = (await root.get(`/companies/${c.id}/accounts`).expect(200)).body as { id: string; code: string }[];
  return { id: c.id as string, acct: Object.fromEntries(accts.map((a) => [a.code, a.id])) as Record<string, string> };
}

/** Full OAuth round trip through the real endpoints. */
async function connect(root: A, companyId: string, shop = SHOP) {
  const { authorizeUrl } = (await root.post(`/companies/${companyId}/shopify/connect`, { shop }).expect(201)).body;
  const state = new URL(authorizeUrl).searchParams.get('state')!;
  const params = { code: 'authcode', shop, state, timestamp: '1700000000' };
  const res = await request(app.getHttpServer()).get('/shopify/callback').query({ ...params, hmac: sign(params) });
  return { res, state, authorizeUrl };
}

async function ready() {
  const root = await setupAdmin(app);
  const co = await company(root);
  fake.orders.push(ontarioOrder());
  fake.payouts.push(payoutNode(9001, '120.38'));
  fake.balanceTransactions.push(btNode(1, 'CHARGE', '124.30', '3.92', '120.38'), btNode(2, 'TRANSFER', '-120.38', '0.00', '-120.38', { sourceType: 'TRANSFER' }));
  const { res } = await connect(root, co.id);
  expect(res.headers.location).toContain('connected=1');
  const store = await prisma.shopifyStore.findFirstOrThrow();
  return { root, co, store };
}
const runSync = async (storeId: string, kind: 'HISTORICAL' | 'INCREMENTAL' = 'INCREMENTAL', finalAttempt = true) => {
  const s = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: storeId } });
  await prisma.shopifySyncJob.deleteMany({ where: { storeId, status: 'PENDING', trigger: { not: 'test' } } }); // the connect/webhook job queued by the app
  const job = await prisma.shopifySyncJob.create({ data: { companyId: s.companyId, storeId, kind, trigger: 'test' } });
  await sync.runJob(job.id, { finalAttempt });
  return prisma.shopifySyncJob.findUniqueOrThrow({ where: { id: job.id } });
};
const tb = async (root: A, id: string) => (await root.get(`/companies/${id}/reports/trial-balance?asOf=2026-12-31`).expect(200)).body;
const bal = (t: { rows: { code: string; debit: string; credit: string }[] }, code: string) => { const r = t.rows.find((x) => x.code === code); return r ? (Number(r.debit) - Number(r.credit)).toFixed(2) : '0.00'; };
const journals = (companyId: string, like = 'shopify_%') => prisma.journalEntry.count({ where: { companyId, sourceType: { startsWith: like.replace('%', '') } } });

describe('OAuth connection', () => {
  it('builds a Shopify authorize URL with state, read-only scopes and our callback; stores encrypted tokens on success', async () => {
    const { co, store } = await ready();
    const row = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: store.id } });
    expect(row.accessTokenEnc).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain('shpat_secret_token_123');
    expect(JSON.stringify(row)).not.toContain('shprt_refresh_456');
    expect(row).toMatchObject({ companyId: co.id, shopDomain: SHOP, currency: 'CAD', timezone: 'America/Toronto', paymentsEnabled: true, status: 'CONNECTED' });
    expect(Object.keys(row.accountMap as object)).toEqual(expect.arrayContaining(['clearing', 'sales', 'shipping', 'giftCard', 'fees', 'bank', 'refunds']));
    expect(fake.tokenRequests[0].get('expiring')).toBe('1');
    expect(await prisma.shopifySyncJob.count({ where: { storeId: store.id, trigger: 'connect' } })).toBe(1);
  });
  it('the authorize URL targets the shop, carries state and the redirect URI', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const { authorizeUrl } = await connect(root, co.id);
    const u = new URL(authorizeUrl);
    expect(u.host).toBe(SHOP);
    expect(u.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/shopify/callback`);
    expect(u.searchParams.get('scope')).toContain('read_orders');
    expect(u.searchParams.get('scope')).not.toMatch(/write_/);
  });
  it('rejects a bad HMAC, an unknown/replayed state, and a different shop; creates nothing', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const { authorizeUrl } = (await root.post(`/companies/${co.id}/shopify/connect`, { shop: SHOP }).expect(201)).body;
    const state = new URL(authorizeUrl).searchParams.get('state')!;
    const good = { code: 'c', shop: SHOP, state, timestamp: '1' };
    const bad = await request(app.getHttpServer()).get('/shopify/callback').query({ ...good, hmac: 'deadbeef' });
    expect(bad.headers.location).toContain('error=');
    // state was consumed by the failed attempt: replaying even a correct request fails
    const replay = await request(app.getHttpServer()).get('/shopify/callback').query({ ...good, hmac: sign(good) });
    expect(replay.headers.location).toContain('shopifyError=');
    // other shop than the one the user started with
    const { authorizeUrl: a2 } = (await root.post(`/companies/${co.id}/shopify/connect`, { shop: SHOP }).expect(201)).body;
    const s2 = new URL(a2).searchParams.get('state')!;
    const other = { code: 'c', shop: 'evil.myshopify.com', state: s2, timestamp: '1' };
    expect((await request(app.getHttpServer()).get('/shopify/callback').query({ ...other, hmac: sign(other) })).headers.location).toContain('error=');
    expect(await prisma.shopifyStore.count()).toBe(0);
  });
  it('refuses invalid shop names, non-CAD shops and a shop already used by another company', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await root.post(`/companies/${co.id}/shopify/connect`, { shop: 'evil.com' }).expect(400);
    fake.currency = 'USD';
    const r = await connect(root, co.id);
    expect(decodeURIComponent(r.res.headers.location)).toContain('USD');
    expect(await prisma.shopifyStore.count()).toBe(0);
    fake.currency = 'CAD';
    await connect(root, co.id);
    const co2 = await company(root, 'Other Co');
    await root.post(`/companies/${co2.id}/shopify/connect`, { shop: SHOP }).expect(409);
  });
  it('never returns credentials from the API; only owners/admins can connect; other companies get 404', async () => {
    const { root, co, store } = await ready();
    const list = (await root.get(`/companies/${co.id}/shopify/stores`).expect(200)).body;
    expect(JSON.stringify(list)).not.toMatch(/accessTokenEnc|refreshTokenEnc|shpat|shprt|v1\./);
    expect(list[0].id).toBe(store.id);
    await root.post(`/companies/${co.id}/members`, { email: 'bk@example.test', name: 'BK', role: 'BOOKKEEPER', temporaryPassword: PASSWORD }).expect(201);
    const bk = agent(app);
    await bk.post('/auth/login', { email: 'bk@example.test', password: PASSWORD }).expect(200);
    await bk.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' }).expect(204);
    await bk.post(`/companies/${co.id}/shopify/connect`, { shop: 'other.myshopify.com' }).expect(403);
    await bk.post(`/companies/${co.id}/shopify/stores/${store.id}/sync`, {}).expect(403);
    await bk.get(`/companies/${co.id}/shopify/stores`).expect(200);
    await root.post('/admin/companies', { legalName: 'B Co', province: 'ON', ownerEmail: 'b@example.test', ownerName: 'B', ownerTemporaryPassword: PASSWORD }).expect(201);
    const b = agent(app);
    await b.post('/auth/login', { email: 'b@example.test', password: PASSWORD }).expect(200);
    await b.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' }).expect(204);
    for (const p of ['stores', 'jobs', 'orders', 'payouts', 'review']) await b.get(`/companies/${co.id}/shopify/${p}`).expect(404);
  });
  it('refreshes an expiring token under a lock and rotates the refresh token', async () => {
    const { store } = await ready();
    await prisma.shopifyStore.update({ where: { id: store.id }, data: { accessTokenExpiresAt: new Date(Date.now() + 5_000) } });
    const svc = app.get((await import('../src/shopify/shopify.service')).ShopifyService);
    const [a, b] = await Promise.all([svc.accessToken(store.id), svc.accessToken(store.id)]);
    expect([a, b]).toEqual(['shpat_refreshed', 'shpat_refreshed']);
    expect(fake.tokenRequests.filter((t) => t.get('grant_type') === 'refresh_token')).toHaveLength(1);
  });
});

describe('webhooks', () => {
  const send = (body: object, headers: Record<string, string>, secret = SECRET) => {
    const raw = JSON.stringify(body);
    return request(app.getHttpServer()).post('/webhooks/shopify').set('Content-Type', 'application/json')
      .set('X-Shopify-Hmac-Sha256', createHmac('sha256', secret).update(raw).digest('base64')).set(headers).send(raw);
  };
  it('rejects bad or missing signatures; accepts valid ones without cookies or origin', async () => {
    const { store } = await ready();
    await prisma.shopifySyncJob.deleteMany({ where: { storeId: store.id } });
    const h = { 'X-Shopify-Topic': 'orders/updated', 'X-Shopify-Shop-Domain': SHOP, 'X-Shopify-Webhook-Id': 'w-1' };
    expect((await send({ id: 1 }, h, 'wrong-secret')).status).toBe(401);
    expect((await request(app.getHttpServer()).post('/webhooks/shopify').set(h).send({ id: 1 })).status).toBe(401);
    expect((await send({ id: 1 }, { ...h, 'X-Shopify-Webhook-Id': '' })).status).toBe(401);
    expect((await send({ id: 1 }, h)).body.status).toBe('queued');
    expect(await prisma.shopifySyncJob.count({ where: { storeId: store.id, trigger: 'webhook' } })).toBe(1);
  });
  it('processes a repeated delivery once, and ignores unknown shops', async () => {
    const { store } = await ready();
    const h = { 'X-Shopify-Topic': 'refunds/create', 'X-Shopify-Shop-Domain': SHOP, 'X-Shopify-Webhook-Id': 'w-dup' };
    expect((await send({ a: 1 }, h)).body.status).toBe('queued');
    expect((await send({ a: 1 }, h)).body.status).toBe('duplicate');
    expect(await prisma.shopifyWebhookEvent.count({ where: { storeId: store.id } })).toBe(1);
    expect((await send({ a: 1 }, { ...h, 'X-Shopify-Shop-Domain': 'nobody.myshopify.com', 'X-Shopify-Webhook-Id': 'w-x' })).body.status).toBe('ignored');
  });
  it('a burst of different webhooks collapses into one pending incremental job', async () => {
    const { store } = await ready();
    await prisma.shopifySyncJob.deleteMany({ where: { storeId: store.id } });
    for (let i = 0; i < 5; i++) await send({ i }, { 'X-Shopify-Topic': 'orders/updated', 'X-Shopify-Shop-Domain': SHOP, 'X-Shopify-Webhook-Id': `burst-${i}` });
    expect(await prisma.shopifySyncJob.count({ where: { storeId: store.id } })).toBe(1);
  });
  it('app/uninstalled disconnects the store', async () => {
    const { store } = await ready();
    expect((await send({}, { 'X-Shopify-Topic': 'app/uninstalled', 'X-Shopify-Shop-Domain': SHOP, 'X-Shopify-Webhook-Id': 'u-1' })).body.status).toBe('disconnected');
    const s = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: store.id } });
    expect(s.status).toBe('DISCONNECTED');
    expect(s.accessTokenEnc).toBe('revoked');
  });
});

describe('sync and accounting', () => {
  it('imports an order, its fee and the payout, posting each exactly once and clearing nets to zero', async () => {
    const { root, co, store } = await ready();
    const job = await runSync(store.id);
    expect(job.status).toBe('SUCCEEDED');
    const t = await tb(root, co.id);
    expect(bal(t, '4000')).toBe('-100.00');
    expect(bal(t, '4100')).toBe('-10.00');
    expect(bal(t, '2200')).toBe('-14.30');
    expect(bal(t, '6120')).toBe('3.92');
    expect(bal(t, '1010')).toBe('120.38');
    expect(bal(t, '1030')).toBe('0.00'); // 124.30 sold - 3.92 fee - 120.38 paid out
    expect(t.totals.balanced).toBe(true);
    expect(await journals(co.id)).toBe(3); // order, fee, payout (CHARGE/TRANSFER amounts post nothing)
    expect(job.progress).toMatchObject({ orders: 1, payouts: 1, balanceTransactions: 2, posted: 3 });
  });
  it('re-running (historical, incremental, even concurrently) creates no duplicates', async () => {
    const { co, store } = await ready();
    await runSync(store.id);
    await Promise.all([runSync(store.id, 'HISTORICAL'), runSync(store.id, 'INCREMENTAL')]);
    await runSync(store.id, 'HISTORICAL');
    expect(await prisma.shopifyOrder.count()).toBe(1);
    expect(await prisma.shopifyTransaction.count()).toBe(1);
    expect(await prisma.shopifyBalanceTransaction.count()).toBe(2);
    expect(await prisma.shopifyPayout.count()).toBe(1);
    expect(await journals(co.id)).toBe(3);
  });
  it('the database refuses a second journal for the same Shopify source row', async () => {
    const { co, store } = await ready();
    await runSync(store.id);
    const e = await prisma.journalEntry.findFirstOrThrow({ where: { companyId: co.id, sourceType: 'shopify_order' } });
    await expect(prisma.journalEntry.create({ data: { companyId: co.id, date: new Date('2026-10-05'), createdById: co.id, sourceType: 'shopify_order', sourceId: e.sourceId } })).rejects.toThrow();
  });
  it('paginates through more than one page of orders and uses the watermark for incremental runs', async () => {
    const { store } = await ready();
    fake.orders = Array.from({ length: 30 }, (_, i) => ontarioOrder({ id: `gid://shopify/Order/${2000 + i}`, name: `#${2000 + i}`, updatedAt: `2026-10-05T15:${String(i).padStart(2, '0')}:00Z`, transactions: [txn(8000 + i, 'SALE', '124.30')] }));
    await runSync(store.id, 'HISTORICAL');
    expect(await prisma.shopifyOrder.count()).toBe(30);
    expect(fake.calls.filter((c) => c.op === 'Orders').length).toBeGreaterThanOrEqual(2);
    fake.calls.length = 0;
    await runSync(store.id, 'INCREMENTAL');
    expect(fake.calls.find((c) => c.op === 'Orders')!.variables.query).toMatch(/^updated_at:>='2026-10-05T/);
    const s = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: store.id } });
    expect(s.ordersWatermark?.toISOString()).toBe('2026-10-05T15:29:00.000Z');
  });
  it('tax-included Quebec orders, third-party gateways and gift cards post to the right accounts', async () => {
    const { root, co, store } = await ready();
    fake.orders = [
      quebecOrderTaxIncluded(),
      ontarioOrder({ id: 'gid://shopify/Order/3001', name: '#3001', transactions: [txn(9001, 'SALE', '124.30', { gateway: 'paypal' })] }),
      ontarioOrder({ id: 'gid://shopify/Order/3002', name: '#3002', totalPriceSet: { shopMoney: { amount: '174.30', currencyCode: 'CAD' } },
        lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'a', isGiftCard: false, originalTotalSet: { shopMoney: { amount: '100.00', currencyCode: 'CAD' } } }, { id: 'b', isGiftCard: true, originalTotalSet: { shopMoney: { amount: '50.00', currencyCode: 'CAD' } } }] },
        transactions: [txn(9002, 'SALE', '174.30')] }),
    ];
    fake.payouts = []; fake.balanceTransactions = [];
    await runSync(store.id);
    const t = await tb(root, co.id);
    expect(bal(t, '2210')).toBe('-9.98'); // QST
    expect(bal(t, '1040')).toBe('124.30'); // PayPal clearing, kept apart from Shopify Payments
    expect(bal(t, '2510')).toBe('-50.00'); // gift card liability
    expect(bal(t, '1030')).toBe('289.28'); // 114.98 + 174.30
    expect(t.totals.balanced).toBe(true);
  });
  it('skips test and cancelled orders; waits for uncaptured payments; never guesses on odd data', async () => {
    const { co, store } = await ready();
    fake.orders = [
      ontarioOrder({ id: 'gid://shopify/Order/4001', name: '#4001', test: true }),
      ontarioOrder({ id: 'gid://shopify/Order/4002', name: '#4002', cancelledAt: '2026-10-06T00:00:00Z' }),
      ontarioOrder({ id: 'gid://shopify/Order/4003', name: '#4003', transactions: [txn(1, 'AUTHORIZATION', '124.30')] }),
      ontarioOrder({ id: 'gid://shopify/Order/4004', name: '#4004', taxLines: [{ title: 'Eco fee', ratePercentage: 1, priceSet: { shopMoney: { amount: '13.00', currencyCode: 'CAD' } } }] }),
      ontarioOrder({ id: 'gid://shopify/Order/4005', name: '#4005', currencyCode: 'USD' }),
    ];
    fake.payouts = []; fake.balanceTransactions = [];
    await runSync(store.id);
    const st = Object.fromEntries((await prisma.shopifyOrder.findMany()).map((o) => [o.name, o]));
    expect(st['#4001'].postingStatus).toBe('SKIPPED');
    expect(st['#4002'].postingStatus).toBe('SKIPPED');
    expect(st['#4003']).toMatchObject({ postingStatus: 'PENDING' });
    expect(st['#4003'].postingNote).toMatch(/not fully captured/);
    expect(st['#4004']).toMatchObject({ postingStatus: 'NEEDS_REVIEW' });
    expect(st['#4004'].postingNote).toMatch(/Eco fee/);
    expect(st['#4005'].postingStatus).toBe('NEEDS_REVIEW');
    expect(await journals(co.id)).toBe(0);
    // once payment is captured, the pending order posts on the next sync
    fake.orders = [ontarioOrder({ id: 'gid://shopify/Order/4003', name: '#4003', updatedAt: '2026-10-07T00:00:00Z', transactions: [txn(1, 'AUTHORIZATION', '124.30'), txn(2, 'CAPTURE', '124.30')] })];
    await runSync(store.id);
    expect((await prisma.shopifyOrder.findFirstOrThrow({ where: { name: '#4003' } })).postingStatus).toBe('POSTED');
  });
  it('an order edited after posting is flagged, and its journal is left untouched', async () => {
    const { root, co, store } = await ready();
    await runSync(store.id);
    fake.orders = [ontarioOrder({ updatedAt: '2026-10-20T00:00:00Z', totalPriceSet: { shopMoney: { amount: '150.00', currencyCode: 'CAD' } }, transactions: [txn(5001, 'SALE', '150.00')] })];
    await runSync(store.id);
    const o = await prisma.shopifyOrder.findFirstOrThrow();
    expect(o.postingStatus).toBe('NEEDS_REVIEW');
    expect(o.postingNote).toMatch(/changed in Shopify after it was posted/);
    expect(bal(await tb(root, co.id), '4000')).toBe('-100.00');
    expect(await journals(co.id, 'shopify_order')).toBe(1);
  });
  it('a refund reduces revenue and tax once, in the original proportions', async () => {
    const { root, co, store } = await ready();
    fake.orders = [{ ...quebecOrderTaxIncluded(), updatedAt: '2026-10-09T00:00:00Z', refunds: [refund(1, '57.49', '7.49')] }];
    fake.payouts = []; fake.balanceTransactions = [];
    await runSync(store.id);
    await runSync(store.id, 'HISTORICAL');
    const t = await tb(root, co.id);
    expect(bal(t, '4800')).toBe('50.00');
    expect(Number(bal(t, '2200')) + Number(bal(t, '2210'))).toBeCloseTo(-14.98 + 7.49, 2);
    expect(bal(t, '1030')).toBe('57.49'); // 114.98 in, 57.49 refunded
    expect(await journals(co.id, 'shopify_refund')).toBe(1);
  });
  it('fees, reserves and chargeback holds post by rule; unknown balance types wait for a human, who can classify them', async () => {
    const { root, co, store } = await ready();
    fake.payouts = [];
    fake.balanceTransactions = [
      btNode(10, 'RESERVED_FUNDS', '-500.00', '0.00', '-500.00', { sourceType: 'ADJUSTMENT', associatedPayout: { id: null, status: 'PENDING' } }),
      btNode(11, 'CHARGEBACK_HOLD', '-30.00', '0.00', '-30.00', { sourceType: 'DISPUTE', associatedPayout: { id: null, status: 'PENDING' } }),
      btNode(12, 'ADJUSTMENT', '-4.00', '0.00', '-4.00', { sourceType: 'ADJUSTMENT', adjustmentReason: 'Mystery', associatedPayout: { id: null, status: 'PENDING' } }),
    ];
    await runSync(store.id);
    let t = await tb(root, co.id);
    expect(bal(t, '1035')).toBe('500.00');
    expect(bal(t, '1036')).toBe('30.00');
    const review = (await root.get(`/companies/${co.id}/shopify/review`).expect(200)).body;
    expect(review.balanceTransactions).toHaveLength(1);
    expect(review.balanceTransactions[0].postingNote).toMatch(/no automatic mapping/);
    await root.post(`/companies/${co.id}/shopify/balance-transactions/${review.balanceTransactions[0].id}/classify`, { accountId: co.acct['6020'] }).expect(201);
    await root.post(`/companies/${co.id}/shopify/stores/${store.id}/repost`).expect(201);
    t = await tb(root, co.id);
    expect(bal(t, '6020')).toBe('4.00');
    expect((await root.get(`/companies/${co.id}/shopify/review`).expect(200)).body.balanceTransactions).toHaveLength(0);
    await root.post(`/companies/${co.id}/shopify/stores/${store.id}/repost`).expect(201);
    expect(bal(await tb(root, co.id), '6020')).toBe('4.00'); // not posted twice
  });
  it('a payout that does not tie out to its balance transactions is not posted', async () => {
    const { root, co, store } = await ready();
    fake.payouts = [payoutNode(9001, '130.00')]; // components only sum to 120.38
    await runSync(store.id);
    const p = await prisma.shopifyPayout.findFirstOrThrow();
    expect(p.postingStatus).toBe('NEEDS_REVIEW');
    expect(p.postingNote).toMatch(/≠ payout net/);
    expect(bal(await tb(root, co.id), '1010')).toBe('0.00');
  });
  it('a SCHEDULED payout waits and posts once it is PAID', async () => {
    const { root, co, store } = await ready();
    fake.payouts = [payoutNode(9001, '120.38', 'SCHEDULED')];
    await runSync(store.id);
    expect((await prisma.shopifyPayout.findFirstOrThrow()).postingStatus).toBe('PENDING');
    fake.payouts = [payoutNode(9001, '120.38', 'PAID')];
    await runSync(store.id);
    expect(bal(await tb(root, co.id), '1010')).toBe('120.38');
  });
  it('a locked accounting period sends the item to review instead of failing the sync', async () => {
    const { root, co, store } = await ready();
    const periods = (await root.get(`/companies/${co.id}/periods`).expect(200)).body as { id: string; label: string }[];
    await root.patch(`/companies/${co.id}/periods/${periods.find((p) => p.label === '2026-10')!.id}`, { locked: true }).expect(200);
    const job = await runSync(store.id);
    expect(job.status).toBe('SUCCEEDED');
    const o = await prisma.shopifyOrder.findFirstOrThrow();
    expect(o.postingStatus).toBe('NEEDS_REVIEW');
    expect(o.postingNote).toMatch(/locked/);
    await root.patch(`/companies/${co.id}/periods/${periods.find((p) => p.label === '2026-10')!.id}`, { locked: false }).expect(200);
    await root.post(`/companies/${co.id}/shopify/stores/${store.id}/repost`).expect(201);
    expect((await prisma.shopifyOrder.findFirstOrThrow()).postingStatus).toBe('POSTED');
  });
  it('records disputes without posting them', async () => {
    const { co, store } = await ready();
    fake.disputes = [{ id: 'gid://shopify/ShopifyPaymentsDispute/1', status: 'NEEDS_RESPONSE', type: 'CHARGEBACK', initiatedAt: '2026-10-06T00:00:00Z', finalizedOn: null, amount: { amount: '124.30', currencyCode: 'CAD' }, order: { id: 'gid://shopify/Order/1001' } }];
    await runSync(store.id);
    expect(await prisma.shopifyDispute.count({ where: { companyId: co.id } })).toBe(1);
  });
});

describe('failure handling', () => {
  it('throttling (HTTP 429) is retried transparently and counted', async () => {
    const { store } = await ready();
    fake.failNext = [{ status: 429, headers: { 'Retry-After': '1' } }];
    const job = await runSync(store.id);
    expect(job.status).toBe('SUCCEEDED');
    expect((job.progress as { throttleWaits: number }).throttleWaits).toBeGreaterThanOrEqual(1);
  });
  it('an API error fails the job (retryable) and goes DEAD on the final attempt, with the error recorded', async () => {
    const { store } = await ready();
    fake.graphqlError = 'Internal error. Looks like something went wrong on our end.';
    const s = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: store.id } });
    await prisma.shopifySyncJob.deleteMany({ where: { storeId: store.id } });
    const job = await prisma.shopifySyncJob.create({ data: { companyId: s.companyId, storeId: store.id, kind: 'INCREMENTAL', trigger: 'test' } });
    await expect(sync.runJob(job.id, { finalAttempt: false })).rejects.toThrow(/went wrong/);
    expect((await prisma.shopifySyncJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED');
    await sync.runJob(job.id, { finalAttempt: true }).catch(() => undefined);
    const dead = await prisma.shopifySyncJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(dead.status).toBe('DEAD');
    expect(dead.error).toMatch(/went wrong/);
    expect(dead.attempts).toBe(2);
  });
  it('a revoked token (401) is fatal: the job is DEAD immediately and the store is marked ERROR', async () => {
    const { store } = await ready();
    fake.failNext = [{ status: 401 }];
    const job = await runSync(store.id, 'INCREMENTAL', false);
    expect(job.status).toBe('DEAD');
    expect((await prisma.shopifyStore.findUniqueOrThrow({ where: { id: store.id } })).status).toBe('ERROR');
  });
  it('a missing Shopify Payments scope does not block order accounting', async () => {
    const { root, co, store } = await ready();
    const real = shopifyFetch.fn;
    shopifyFetch.fn = (async (url: Parameters<typeof fetch>[0], init: NonNullable<Parameters<typeof fetch>[1]>) => {
      if (String(url).includes('graphql') && /shopifyPaymentsAccount/.test(String(init.body)) && /payouts|balanceTransactions|disputes/.test(String(init.body))) {
        return new Response(JSON.stringify({ errors: [{ message: 'Access denied for shopifyPaymentsAccount field.' }] }), { status: 200 });
      }
      return real(url, init);
    }) as typeof fetch;
    const job = await runSync(store.id);
    expect(job.status).toBe('SUCCEEDED');
    expect(JSON.stringify(job.errorLog)).toMatch(/Access denied/);
    expect(bal(await tb(root, co.id), '4000')).toBe('-100.00');
    expect((await prisma.shopifyStore.findUniqueOrThrow({ where: { id: store.id } })).lastError).toMatch(/Access denied/);
  });
  it('manual sync requests are de-duplicated while one is pending', async () => {
    const { root, co, store } = await ready();
    await prisma.shopifySyncJob.deleteMany({ where: { storeId: store.id } });
    const a = (await root.post(`/companies/${co.id}/shopify/stores/${store.id}/sync`, { kind: 'INCREMENTAL' }).expect(201)).body;
    const b = (await root.post(`/companies/${co.id}/shopify/stores/${store.id}/sync`, { kind: 'INCREMENTAL' }).expect(201)).body;
    expect(b.id).toBe(a.id);
    const h = (await root.post(`/companies/${co.id}/shopify/stores/${store.id}/sync`, { kind: 'HISTORICAL', since: '2026-01-01' }).expect(201)).body;
    expect(h.id).not.toBe(a.id);
    expect((await root.get(`/companies/${co.id}/shopify/jobs`).expect(200)).body.length).toBe(2);
  });
});

describe('payout reconciliation view', () => {
  it('shows components, tie-out, posting status and the journal link', async () => {
    const { root, co, store } = await ready();
    await runSync(store.id);
    const p = (await root.get(`/companies/${co.id}/shopify/payouts`).expect(200)).body[0];
    const d = (await root.get(`/companies/${co.id}/shopify/payouts/${p.id}`).expect(200)).body;
    expect(d.payout).toMatchObject({ status: 'PAID', postingStatus: 'POSTED' });
    expect(d.components.charges).toMatchObject({ count: 1, gross: '124.30', fees: '3.92', net: '120.38' });
    expect(d.components.refunds.count).toBe(0);
    expect(d.tieOut).toMatchObject({ componentsNet: '120.38', payoutNet: '120.38', difference: '0.00', ok: true, unresolvedComponents: 0 });
    expect(d.orders[0]).toMatchObject({ name: '#1001', postingStatus: 'POSTED' });
    expect(d.bankMatch).toBeNull();
    expect(d.transactions.map((t: { type: string }) => t.type)).toEqual(['CHARGE', 'TRANSFER']);
  });
});
