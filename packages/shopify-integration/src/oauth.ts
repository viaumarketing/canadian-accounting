import { createHmac, timingSafeEqual } from 'node:crypto';

/** Anchored at both ends: a lookalike host must not receive our authorization code. */
const SHOP_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
export const isValidShopDomain = (shop: string): boolean => SHOP_RE.test(shop);

export function normaliseShopInput(input: string): string | null {
  let s = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!s.includes('.')) s = `${s}.myshopify.com`;
  return isValidShopDomain(s) ? s : null;
}

export function buildAuthorizeUrl(p: { shop: string; clientId: string; scopes: string[]; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({ client_id: p.clientId, scope: p.scopes.join(','), redirect_uri: p.redirectUri, state: p.state });
  return `https://${p.shop}/admin/oauth/authorize?${q.toString()}`;
}

/** Callback HMAC: drop `hmac`, sort the rest, join as key=value with '&', HMAC-SHA256 hex with the client secret. */
export function verifyOAuthCallbackHmac(params: Record<string, string>, clientSecret: string): boolean {
  const { hmac, ...rest } = params;
  if (!hmac) return false;
  const message = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join('&');
  const expected = createHmac('sha256', clientSecret).update(message).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(hmac);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface TokenResponse {
  accessToken: string;
  scope: string;
  expiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
}

type Fetch = typeof fetch;

async function tokenRequest(shop: string, form: Record<string, string>, f: Fetch, now: () => number): Promise<TokenResponse> {
  const res = await f(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) throw new Error(`Shopify token endpoint returned HTTP ${res.status}`);
  const j = (await res.json()) as { access_token?: string; scope?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number };
  if (!j.access_token) throw new Error('Shopify token response had no access_token');
  // No positive expires_in => treat as a non-expiring token (as Shopify's docs instruct).
  const exp = (s?: number) => (s && s > 0 ? new Date(now() + s * 1000) : null);
  return { accessToken: j.access_token, scope: j.scope ?? '', expiresAt: exp(j.expires_in), refreshToken: j.refresh_token ?? null, refreshTokenExpiresAt: exp(j.refresh_token_expires_in) };
}

/** `expiring=1`: new apps must use expiring offline tokens for GraphQL Admin API requests. */
export const exchangeCode = (p: { shop: string; clientId: string; clientSecret: string; code: string }, f: Fetch = fetch, now = Date.now) =>
  tokenRequest(p.shop, { client_id: p.clientId, client_secret: p.clientSecret, code: p.code, expiring: '1' }, f, now);

export const refreshAccessToken = (p: { shop: string; clientId: string; clientSecret: string; refreshToken: string }, f: Fetch = fetch, now = Date.now) =>
  tokenRequest(p.shop, { client_id: p.clientId, client_secret: p.clientSecret, grant_type: 'refresh_token', refresh_token: p.refreshToken }, f, now);
