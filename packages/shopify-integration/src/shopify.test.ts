import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';
import {
  ShopifyAuthError, ShopifyClient, ShopifyThrottledError, allocate, buildAuthorizeUrl, isValidShopDomain, mapBalanceTransaction, mapOrder, mapPayout,
  normaliseShopInput, orderFingerprint, planBalanceTransaction, planOrder, planPayout, planRefund, payoutComponentsNet, requiredScopes, taxAccountFor,
  verifyOAuthCallbackHmac, verifyWebhookHmac,
} from './index';
import { btNode, ontarioOrder, payoutNode, quebecOrderTaxIncluded, refund, txn } from './fixtures';

const total = (lines: { debit: string; credit: string }[]) => ({ d: lines.reduce((s, l) => s.plus(l.debit), new Decimal(0)), c: lines.reduce((s, l) => s.plus(l.credit), new Decimal(0)) });
const amountOf = (lines: { account: string; debit: string; credit: string }[], account: string, side: 'debit' | 'credit') => lines.filter((l) => l.account === account).reduce((s, l) => s.plus(l[side]), new Decimal(0)).toFixed(2);

describe('webhook HMAC', () => {
  const secret = 'shpss_test_secret';
  const body = Buffer.from('{"id":1,"name":"#1001"}');
  const good = createHmac('sha256', secret).update(body).digest('base64');
  it('accepts a correct signature over the raw body', () => expect(verifyWebhookHmac(body, good, secret)).toBe(true));
  it('rejects tampered body, wrong secret, missing or garbage header', () => {
    expect(verifyWebhookHmac(Buffer.from('{"id":2}'), good, secret)).toBe(false);
    expect(verifyWebhookHmac(body, good, 'other')).toBe(false);
    expect(verifyWebhookHmac(body, undefined, secret)).toBe(false);
    expect(verifyWebhookHmac(body, 'not-base64!!', secret)).toBe(false);
    expect(verifyWebhookHmac(body, '', secret)).toBe(false);
  });
});

describe('OAuth helpers', () => {
  it('validates shop domains with anchors (no lookalike hosts)', () => {
    expect(isValidShopDomain('maple-goods.myshopify.com')).toBe(true);
    for (const bad of ['evil.com', 'maple.myshopify.com.evil.com', 'maple.myshopify.com/x', '-x.myshopify.com', 'a@b.myshopify.com', 'maple.myshopify.co']) expect(isValidShopDomain(bad)).toBe(false);
    expect(normaliseShopInput(' https://Maple-Goods.myshopify.com/admin ')).toBe('maple-goods.myshopify.com');
    expect(normaliseShopInput('maple-goods')).toBe('maple-goods.myshopify.com');
    expect(normaliseShopInput('evil.com')).toBeNull();
  });
  it('verifies the callback HMAC per Shopify rules (hmac removed, sorted, joined with &)', () => {
    const secret = 's3cret';
    const params = { code: 'abc', shop: 'maple.myshopify.com', state: 'xyz', timestamp: '1700000000' };
    const hmac = createHmac('sha256', secret).update('code=abc&shop=maple.myshopify.com&state=xyz&timestamp=1700000000').digest('hex');
    expect(verifyOAuthCallbackHmac({ ...params, hmac }, secret)).toBe(true);
    expect(verifyOAuthCallbackHmac({ ...params, code: 'evil', hmac }, secret)).toBe(false);
    expect(verifyOAuthCallbackHmac(params, secret)).toBe(false);
  });
  it('builds the authorize URL with state and read-only scopes', () => {
    const u = new URL(buildAuthorizeUrl({ shop: 'm.myshopify.com', clientId: 'cid', scopes: requiredScopes({ allOrders: false }), redirectUri: 'https://x/cb', state: 'st' }));
    expect(u.pathname).toBe('/admin/oauth/authorize');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('scope')).toBe('read_orders,read_shopify_payments_accounts,read_shopify_payments_payouts,read_shopify_payments_disputes');
    expect(requiredScopes({ allOrders: true })).toContain('read_all_orders');
  });
});

describe('GraphQL client throttling and retries', () => {
  const ok = (data: unknown, cost?: object) => new Response(JSON.stringify({ data, extensions: { cost } }), { status: 200 });
  const make = (responses: Response[], extra: object = {}) => {
    const f = vi.fn(async () => responses.shift()!);
    const sleeps: number[] = [];
    const c = new ShopifyClient({ shop: 'm.myshopify.com', apiVersion: '2026-10', getAccessToken: async () => 't', fetch: f as unknown as typeof fetch, sleep: async (ms) => { sleeps.push(ms); }, ...extra });
    return { c, f, sleeps };
  };
  it('retries HTTP 429 honouring Retry-After, then succeeds', async () => {
    const { c, f, sleeps } = make([new Response('', { status: 429, headers: { 'Retry-After': '2' } }), ok({ a: 1 })]);
    expect((await c.request('{a}')).data).toEqual({ a: 1 });
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2000]);
  });
  it('retries GraphQL THROTTLED waiting for the bucket to refill (min 1s)', async () => {
    const throttled = new Response(JSON.stringify({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: { cost: { requestedQueryCost: 500, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 100, restoreRate: 100 } } } }), { status: 200 });
    const { c, sleeps } = make([throttled, ok({ a: 1 })]);
    await c.request('{a}');
    expect(sleeps).toEqual([4000]); // (500-100)/100 s
  });
  it('pauses pre-emptively when the next query would not fit in the bucket', async () => {
    const { c, sleeps } = make([ok({ a: 1 }, { requestedQueryCost: 300, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 100, restoreRate: 100 } }), ok({ a: 2 })]);
    await c.request('{a}');
    await c.request('{a}');
    expect(sleeps).toEqual([2000]);
  });
  it('gives up after maxRetries with a typed error; 401 is never retried', async () => {
    const { c, f } = make(Array.from({ length: 4 }, () => new Response('', { status: 503 })), { maxRetries: 2 });
    await expect(c.request('{a}')).rejects.toBeInstanceOf(ShopifyThrottledError);
    expect(f).toHaveBeenCalledTimes(3);
    const { c: c2, f: f2 } = make([new Response('', { status: 401 })]);
    await expect(c2.request('{a}')).rejects.toBeInstanceOf(ShopifyAuthError);
    expect(f2).toHaveBeenCalledTimes(1);
  });
  it('retries network errors; non-throttle GraphQL errors fail fast', async () => {
    let n = 0;
    const f = vi.fn(async () => { if (n++ === 0) throw new Error('ECONNRESET'); return new Response(JSON.stringify({ errors: [{ message: 'Field x doesn\'t exist' }] }), { status: 200 }); });
    const c = new ShopifyClient({ shop: 'm.myshopify.com', apiVersion: '2026-10', getAccessToken: async () => 't', fetch: f as unknown as typeof fetch, sleep: async () => {} });
    await expect(c.request('{a}')).rejects.toThrow(/doesn't exist/);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('paginates with cursors until hasNextPage is false', async () => {
    const page = (nodes: number[], next: string | null) => ok({ conn: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } });
    const { c, f } = make([page([1, 2], 'c1'), page([3], null)]);
    const out: number[] = [];
    for await (const n of c.paginate<{ conn: { nodes: number[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }, number>('q', {}, (d) => d.conn)) out.push(...n);
    expect(out).toEqual([1, 2, 3]);
    expect(JSON.parse((f.mock.calls[1] as unknown as [string, { body: string }])[1].body).variables.after).toBe('c1');
  });
});

describe('mapOrder', () => {
  it('normalises an Ontario order', () => {
    const o = mapOrder(ontarioOrder());
    expect([o.total, o.tax, o.shippingNet, o.giftCardSales]).toEqual(['124.3', '14.3', '10', '0']);
    expect(o.taxLines).toEqual([{ title: 'HST', amount: '14.3', rate: 13 }]);
    expect(o.transactions[0]).toMatchObject({ numericId: '5001', kind: 'SALE', gateway: 'shopify_payments', amount: '124.3' });
    expect(o.currencies).toEqual(['CAD']);
  });
  it('strips tax from shipping when taxes are included, and detects gift cards and truncation', () => {
    const o = mapOrder(ontarioOrder({ taxesIncluded: true, lineItems: { pageInfo: { hasNextPage: true }, nodes: [{ id: 'a', isGiftCard: true, originalTotalSet: { shopMoney: { amount: '50.00', currencyCode: 'CAD' } } }] } }));
    expect(o.shippingNet).toBe('8.7');
    expect(o.giftCardSales).toBe('50');
    expect(o.truncated).toContain('lineItems');
  });
});

describe('planOrder: revenue is recognised once and balances', () => {
  it('Ontario order', () => {
    const p = planOrder(mapOrder(ontarioOrder()));
    if (p.kind !== 'post') throw new Error(p.kind);
    const t = total(p.lines);
    expect(t.d.eq(t.c)).toBe(true);
    expect(amountOf(p.lines, 'clearing', 'debit')).toBe('124.30');
    expect(amountOf(p.lines, 'sales', 'credit')).toBe('100.00');
    expect(amountOf(p.lines, 'shipping', 'credit')).toBe('10.00');
    expect(amountOf(p.lines, 'tax:GST_HST', 'credit')).toBe('14.30');
  });
  it('Quebec tax-included order splits GST and QST', () => {
    const p = planOrder(mapOrder(quebecOrderTaxIncluded()));
    if (p.kind !== 'post') throw new Error(p.kind);
    expect(amountOf(p.lines, 'sales', 'credit')).toBe('100.00');
    expect(amountOf(p.lines, 'tax:GST_HST', 'credit')).toBe('5.00');
    expect(amountOf(p.lines, 'tax:QST', 'credit')).toBe('9.98');
  });
  it('gift-card sales are a liability, not revenue; gift-card payments clear against that liability; other gateways clear separately', () => {
    const o = mapOrder(ontarioOrder({
      totalPriceSet: { shopMoney: { amount: '174.30', currencyCode: 'CAD' } },
      lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'a', isGiftCard: false, originalTotalSet: { shopMoney: { amount: '100.00', currencyCode: 'CAD' } } }, { id: 'b', isGiftCard: true, originalTotalSet: { shopMoney: { amount: '50.00', currencyCode: 'CAD' } } }] },
      transactions: [txn(1, 'SALE', '100.00', { gateway: 'paypal' }), txn(2, 'SALE', '24.30', { gateway: 'gift_card' }), txn(3, 'SALE', '50.00')],
    }));
    const p = planOrder(o);
    if (p.kind !== 'post') throw new Error(p.kind + (p as { reason?: string }).reason);
    expect(amountOf(p.lines, 'otherClearing', 'debit')).toBe('100.00');
    expect(amountOf(p.lines, 'clearing', 'debit')).toBe('50.00');
    expect(amountOf(p.lines, 'giftCard', 'debit')).toBe('24.30');
    expect(amountOf(p.lines, 'giftCard', 'credit')).toBe('50.00');
    expect(amountOf(p.lines, 'sales', 'credit')).toBe('100.00');
  });
  it('waits when payment is not fully captured; skips test and cancelled orders', () => {
    expect(planOrder(mapOrder(ontarioOrder({ transactions: [txn(1, 'AUTHORIZATION', '124.30')] }))).kind).toBe('wait');
    expect(planOrder(mapOrder(ontarioOrder({ transactions: [txn(1, 'SALE', '100.00')] }))).kind).toBe('wait');
    expect(planOrder(mapOrder(ontarioOrder({ test: true }))).kind).toBe('skip');
    expect(planOrder(mapOrder(ontarioOrder({ cancelledAt: '2026-10-06T00:00:00Z' }))).kind).toBe('skip');
  });
  it('sends uncertain orders to review instead of guessing', () => {
    const unknownTax = planOrder(mapOrder(ontarioOrder({ taxLines: [{ title: 'Eco fee', ratePercentage: 1, priceSet: { shopMoney: { amount: '13.00', currencyCode: 'CAD' } } }] })));
    expect(unknownTax).toMatchObject({ kind: 'review' });
    const mismatch = planOrder(mapOrder(ontarioOrder({ totalTaxSet: { shopMoney: { amount: '99.00', currencyCode: 'CAD' } } })));
    expect(mismatch).toMatchObject({ kind: 'review' });
    const truncated = planOrder(mapOrder(ontarioOrder({ lineItems: { pageInfo: { hasNextPage: true }, nodes: [] } })));
    expect(truncated).toMatchObject({ kind: 'review' });
  });
  it('fingerprint changes when money fields change, not when unrelated fields do', () => {
    const a = orderFingerprint(mapOrder(ontarioOrder()));
    expect(orderFingerprint(mapOrder(ontarioOrder({ updatedAt: '2027-01-01T00:00:00Z', displayFinancialStatus: 'PARTIALLY_REFUNDED' })))).toBe(a);
    expect(orderFingerprint(mapOrder(ontarioOrder({ totalPriceSet: { shopMoney: { amount: '130.00', currencyCode: 'CAD' } } })))).not.toBe(a);
  });
});

describe('planRefund', () => {
  it('reverses sales and tax proportionally and credits clearing', () => {
    const order = mapOrder(quebecOrderTaxIncluded());
    const r = mapOrder({ ...quebecOrderTaxIncluded(), refunds: [refund(1, '57.49', '7.49')] }).refunds[0];
    const p = planRefund(order, r);
    if (p.kind !== 'post') throw new Error(p.kind);
    expect(amountOf(p.lines, 'refunds', 'debit')).toBe('50.00');
    expect(amountOf(p.lines, 'clearing', 'credit')).toBe('57.49');
    const gst = new Decimal(amountOf(p.lines, 'tax:GST_HST', 'debit'));
    const qst = new Decimal(amountOf(p.lines, 'tax:QST', 'debit'));
    expect(gst.plus(qst).toFixed(2)).toBe('7.49');
    const t = total(p.lines);
    expect(t.d.eq(t.c)).toBe(true);
  });
  it('reviews refunds not returned to a payment method; allocation never loses a cent', () => {
    const order = mapOrder(ontarioOrder());
    const bad = mapOrder({ ...ontarioOrder(), refunds: [{ ...refund(2, '10.00', '1.15'), transactions: { pageInfo: { hasNextPage: false }, nodes: [] } }] }).refunds[0];
    expect(planRefund(order, bad).kind).toBe('review');
    const w = new Map([['tax:GST_HST', new Decimal('5')], ['tax:QST', new Decimal('9.98')]] as const);
    for (let c = 1; c < 400; c++) {
      const parts = allocate(new Decimal(c).div(100), w as never);
      expect([...parts.values()].reduce((s, v) => s.plus(v), new Decimal(0)).toFixed(2)).toBe(new Decimal(c).div(100).toFixed(2));
    }
  });
});

describe('balance transactions and payouts', () => {
  it('CHARGE posts only the fee (revenue came from the order)', () => {
    const p = planBalanceTransaction(mapBalanceTransaction(btNode(1, 'CHARGE', '124.30', '3.92', '120.38')));
    expect(p.amount.kind).toBe('skip');
    if (p.fee.kind !== 'post') throw new Error('fee');
    expect(amountOf(p.fee.lines, 'fees', 'debit')).toBe('3.92');
    expect(amountOf(p.fee.lines, 'clearing', 'credit')).toBe('3.92');
  });
  it('reserves, holds, chargeback fees and shipping labels map; unknown types need review', () => {
    const plan = (type: string, amount: string) => planBalanceTransaction(mapBalanceTransaction(btNode(2, type, amount, '0.00', amount, { sourceType: 'ADJUSTMENT' })));
    const reserve = plan('RESERVED_FUNDS', '-500.00').amount;
    if (reserve.kind !== 'post') throw new Error('reserve');
    expect(amountOf(reserve.lines, 'reserve', 'debit')).toBe('500.00');
    expect(amountOf(reserve.lines, 'clearing', 'credit')).toBe('500.00');
    const release = plan('RESERVED_FUNDS_REVERSAL', '500.00').amount;
    if (release.kind !== 'post') throw new Error('release');
    expect(amountOf(release.lines, 'clearing', 'debit')).toBe('500.00');
    expect(plan('CHARGEBACK_HOLD', '-30.00').amount.kind).toBe('post');
    expect(plan('CHARGEBACK_FEE', '-15.00').amount.kind).toBe('post');
    expect(plan('SHIPPING_LABEL', '-9.20').amount.kind).toBe('post');
    expect(plan('ADJUSTMENT', '-4.00').amount.kind).toBe('review');
    expect(plan('DISPUTE_WITHDRAWAL', '-30.00').amount.kind).toBe('review');
    expect(plan('TRANSFER_FAILURE', '-30.00').amount.kind).toBe('review');
    expect(plan('TRANSFER', '-120.38').amount.kind).toBe('skip');
  });
  it('a human classification overrides the review state', () => {
    const p = planBalanceTransaction(mapBalanceTransaction(btNode(3, 'ADJUSTMENT', '-4.00', '0.00', '-4.00')), 'classified');
    expect(p.amount.kind).toBe('post');
  });
  it('payout posts Dr bank / Cr clearing only when it is PAID and ties out', () => {
    const payout = mapPayout(payoutNode(9001, '120.38'));
    const bts = [mapBalanceTransaction(btNode(1, 'CHARGE', '124.30', '3.92', '120.38')), mapBalanceTransaction(btNode(2, 'TRANSFER', '-120.38', '0.00', '-120.38'))];
    const net = payoutComponentsNet(bts);
    expect(net.toFixed(2)).toBe('120.38');
    const p = planPayout(payout, net);
    if (p.kind !== 'post') throw new Error(p.kind);
    expect(amountOf(p.lines, 'bank', 'debit')).toBe('120.38');
    expect(planPayout(payout, '100.00').kind).toBe('review');
    expect(planPayout(mapPayout(payoutNode(9002, '120.38', 'SCHEDULED')), net).kind).toBe('wait');
  });
  it('clearing nets to zero across a full cycle: order + fee + payout', () => {
    const order = planOrder(mapOrder(ontarioOrder()));
    const fee = planBalanceTransaction(mapBalanceTransaction(btNode(1, 'CHARGE', '124.30', '3.92', '120.38'))).fee;
    const payout = planPayout(mapPayout(payoutNode(9001, '120.38')), '120.38');
    if (order.kind !== 'post' || fee.kind !== 'post' || payout.kind !== 'post') throw new Error('plans');
    const all = [...order.lines, ...fee.lines, ...payout.lines].filter((l) => l.account === 'clearing');
    const t = total(all);
    expect(t.d.minus(t.c).toFixed(2)).toBe('0.00');
  });
});

describe('tax title mapping', () => {
  it('maps common Canadian titles and refuses to guess', () => {
    expect(taxAccountFor('HST')).toBe('tax:GST_HST');
    expect(taxAccountFor('GST')).toBe('tax:GST_HST');
    expect(taxAccountFor('QST')).toBe('tax:QST');
    expect(taxAccountFor('BC PST')).toBe('tax:PST');
    expect(taxAccountFor('Ecofee')).toBeNull();
  });
});
