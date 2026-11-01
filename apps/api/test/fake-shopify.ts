/* eslint-disable @typescript-eslint/no-explicit-any */
// An in-process stand-in for Shopify: OAuth token endpoint + Admin GraphQL with filtering, cursor pagination and failure injection.
export interface FakeState {
  shopName: string;
  currency: string;
  timezone: string;
  paymentsActivated: boolean;
  orders: any[];
  payouts: any[];
  balanceTransactions: any[];
  disputes: any[];
  /** respond with these statuses before behaving normally (e.g. [429]) */
  failNext: { status: number; headers?: Record<string, string> }[];
  graphqlError?: string;
  calls: { op: string; variables: any }[];
  tokenRequests: URLSearchParams[];
  tokenExpiresIn?: number;
}

export const newFake = (over: Partial<FakeState> = {}): FakeState => ({
  shopName: 'Maple Goods', currency: 'CAD', timezone: 'America/Toronto', paymentsActivated: true,
  orders: [], payouts: [], balanceTransactions: [], disputes: [], failNext: [], calls: [], tokenRequests: [], ...over,
});

const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function page<T>(items: T[], first: number, after: string | null) {
  const start = after ? Number(after) : 0;
  const nodes = items.slice(start, start + first);
  const end = start + nodes.length;
  return { nodes, pageInfo: { hasNextPage: end < items.length, endCursor: end < items.length ? String(end) : null } };
}

export function fakeShopifyFetch(s: FakeState): typeof fetch {
  return (async (url: any, init: any) => {
    const u = String(url);
    if (u.endsWith('/admin/oauth/access_token')) {
      const form = new URLSearchParams(String(init.body));
      s.tokenRequests.push(form);
      if (form.get('grant_type') === 'refresh_token') return json({ access_token: 'shpat_refreshed', scope: 'read_orders', expires_in: 3600, refresh_token: 'shprt_rotated', refresh_token_expires_in: 7776000 });
      return json({ access_token: 'shpat_secret_token_123', scope: 'read_orders,read_shopify_payments_payouts', expires_in: s.tokenExpiresIn ?? 3600, refresh_token: 'shprt_refresh_456', refresh_token_expires_in: 7776000 });
    }
    const fail = s.failNext.shift();
    if (fail) return new Response('', { status: fail.status, headers: fail.headers });
    const body = JSON.parse(String(init.body));
    const op = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? 'unknown';
    const v = body.variables ?? {};
    s.calls.push({ op, variables: v });
    if (s.graphqlError) return json({ errors: [{ message: s.graphqlError }] });
    const cost = { requestedQueryCost: 10, actualQueryCost: 5, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1990, restoreRate: 100 } };
    switch (op) {
      case 'ShopInfo':
        return json({ data: { shop: { name: s.shopName, myshopifyDomain: 'x', currencyCode: s.currency, ianaTimezone: s.timezone }, shopifyPaymentsAccount: s.paymentsActivated ? { activated: true, defaultCurrency: s.currency } : null }, extensions: { cost } });
      case 'Orders': {
        const m = /updated_at:>='([^']+)'/.exec(v.query ?? '');
        const rows = s.orders.filter((o) => !m || o.updatedAt >= m[1]).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
        return json({ data: { orders: page(rows, v.first, v.after) }, extensions: { cost } });
      }
      case 'Payouts': return json({ data: { shopifyPaymentsAccount: { payouts: page(s.payouts, v.first, v.after) } }, extensions: { cost } });
      case 'BalanceTransactions': return json({ data: { shopifyPaymentsAccount: { balanceTransactions: page(s.balanceTransactions, v.first, v.after) } }, extensions: { cost } });
      case 'Disputes': return json({ data: { shopifyPaymentsAccount: { disputes: page(s.disputes, v.first, v.after) } }, extensions: { cost } });
      case 'WebhookCreate': return json({ data: { webhookSubscriptionCreate: { webhookSubscription: { id: 'gid://shopify/WebhookSubscription/1' }, userErrors: [] } }, extensions: { cost } });
      default: return json({ errors: [{ message: `fake: unknown operation ${op}` }] });
    }
  }) as typeof fetch;
}
