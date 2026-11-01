export class ShopifyAuthError extends Error {}
export class ShopifyHttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export class ShopifyGraphQLError extends Error {
  constructor(message: string, public errors: unknown[]) { super(message); }
}
export class ShopifyThrottledError extends Error {}

export interface ThrottleStatus { maximumAvailable: number; currentlyAvailable: number; restoreRate: number }
export interface GqlResult<T> { data: T | null; errors?: { message: string; extensions?: { code?: string }; path?: unknown[] }[]; extensions?: { cost?: { requestedQueryCost?: number; actualQueryCost?: number; throttleStatus?: ThrottleStatus } } }

export interface ClientOptions {
  shop: string;
  apiVersion: string;
  getAccessToken: () => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  onThrottle?: (waitMs: number, reason: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimal Admin GraphQL client. Behaviour:
 *  - HTTP 429 / 5xx / network errors / GraphQL THROTTLED are retried with back-off (honours Retry-After; otherwise
 *    waits for the bucket to refill using the reported throttleStatus, minimum 1 s as Shopify recommends).
 *  - After every response, if the leaky bucket is nearly empty it pauses first rather than provoking a throttle.
 *  - 401 -> ShopifyAuthError (never retried). Other 4xx and non-throttle GraphQL errors fail fast.
 */
export class ShopifyClient {
  private f: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private maxRetries: number;
  private pauseUntilReadyMs = 0;

  constructor(private o: ClientOptions) {
    this.f = o.fetch ?? fetch;
    this.sleep = o.sleep ?? defaultSleep;
    this.maxRetries = o.maxRetries ?? 6;
  }

  async request<T>(query: string, variables: Record<string, unknown> = {}, opts: { allowPartial?: boolean } = {}): Promise<GqlResult<T>> {
    if (this.pauseUntilReadyMs > 0) {
      const w = this.pauseUntilReadyMs;
      this.pauseUntilReadyMs = 0;
      await this.sleep(w);
    }
    let attempt = 0;
    for (;;) {
      let wait = 0;
      let reason = '';
      try {
        const res = await this.f(`https://${this.o.shop}/admin/api/${this.o.apiVersion}/graphql.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': await this.o.getAccessToken() },
          body: JSON.stringify({ query, variables }),
        });
        if (res.status === 401) throw new ShopifyAuthError('Shopify rejected the access token (401)');
        if (res.status === 429 || res.status >= 500) {
          reason = `HTTP ${res.status}`;
          const ra = Number(res.headers.get('Retry-After'));
          wait = ra > 0 ? ra * 1000 : Math.min(1000 * 2 ** attempt, 30_000);
        } else if (!res.ok) {
          throw new ShopifyHttpError(res.status, `Shopify returned HTTP ${res.status}`);
        } else {
          const body = (await res.json()) as GqlResult<T>;
          const throttled = body.errors?.some((e) => e.extensions?.code === 'THROTTLED');
          if (throttled) {
            reason = 'THROTTLED';
            const c = body.extensions?.cost;
            const ts = c?.throttleStatus;
            const need = (c?.requestedQueryCost ?? 0) - (ts?.currentlyAvailable ?? 0);
            wait = ts && ts.restoreRate > 0 && need > 0 ? Math.max(1000, Math.ceil((need / ts.restoreRate) * 1000)) : 1000 * 2 ** Math.min(attempt, 5);
          } else {
            if (body.errors?.length && !(opts.allowPartial && body.data)) {
              throw new ShopifyGraphQLError(body.errors.map((e) => e.message).join('; '), body.errors);
            }
            // Pre-emptive pause when the bucket is low, so the next call doesn't get throttled.
            const ts = body.extensions?.cost?.throttleStatus;
            const nextCost = body.extensions?.cost?.requestedQueryCost ?? 0;
            if (ts && ts.restoreRate > 0 && ts.currentlyAvailable < nextCost) {
              this.pauseUntilReadyMs = Math.ceil(((nextCost - ts.currentlyAvailable) / ts.restoreRate) * 1000);
            }
            return body;
          }
        }
      } catch (e) {
        if (e instanceof ShopifyAuthError || e instanceof ShopifyHttpError || e instanceof ShopifyGraphQLError) throw e;
        reason = `network: ${(e as Error).message}`;
        wait = Math.min(1000 * 2 ** attempt, 30_000);
      }
      if (attempt >= this.maxRetries) throw new ShopifyThrottledError(`Gave up after ${attempt + 1} attempts (${reason})`);
      attempt += 1;
      this.o.onThrottle?.(wait, reason);
      await this.sleep(wait);
    }
  }

  /** Cursor pagination over a connection. `pick` extracts {nodes, pageInfo} from the response data. */
  async *paginate<T, N>(query: string, variables: Record<string, unknown>, pick: (d: T) => { nodes: N[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } | null | undefined, opts: { allowPartial?: boolean } = {}): AsyncGenerator<N[]> {
    let after: string | null = null;
    for (;;) {
      const r: GqlResult<T> = await this.request<T>(query, { ...variables, after }, opts);
      const conn = r.data ? pick(r.data) : null;
      if (!conn) return;
      yield conn.nodes;
      if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) return;
      after = conn.pageInfo.endCursor;
    }
  }
}
