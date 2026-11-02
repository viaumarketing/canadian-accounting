import { createHmac } from 'node:crypto';
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { safeEqual } from '../common/crypto';

/** Tests swap `stripeFetch.fn` for a fake Stripe; production leaves the real fetch. */
export const stripeFetch: { fn: typeof fetch } = { fn: (...a) => fetch(...a) };

const API = 'https://api.stripe.com';

type Param = string | number | boolean | null | undefined | Param[] | { [k: string]: Param };

/** Stripe's form encoding: nested objects and arrays become `a[b][0][c]=v`. */
export function formEncode(params: Record<string, Param>): string {
  const out: string[] = [];
  const walk = (key: string, v: Param) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${key}[${i}]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(`${key}[${k}]`, x);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.join('&');
}

export class StripeError extends Error {
  constructor(readonly status: number, message: string, readonly type?: string) { super(message); }
}

/** One call to the Stripe REST API with a secret key (Bearer auth, form-encoded body). */
export async function stripeRequest<T>(secretKey: string, method: 'GET' | 'POST', path: string, params: Record<string, Param> = {}, idempotencyKey?: string): Promise<T> {
  const body = formEncode(params);
  const url = method === 'GET' && body ? `${API}${path}?${body}` : `${API}${path}`;
  let res: Response;
  try {
    res = await stripeFetch.fn(url, {
      method,
      headers: { Authorization: `Bearer ${secretKey}`, ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      ...(method === 'POST' ? { body } : {}),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new BadGatewayException({ code: 'STRIPE_UNREACHABLE', message: `Stripe could not be reached: ${(e as Error).message}` });
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; type?: string } };
  if (!res.ok) throw new StripeError(res.status, json.error?.message ?? `Stripe returned ${res.status}`, json.error?.type);
  return json;
}

/**
 * Verify a `Stripe-Signature` header (docs.stripe.com/webhooks, "Verify webhook signatures manually"): take `t` and every
 * `v1` value, compute HMAC-SHA256(secret, `${t}.${rawBody}`) as hex, compare in constant time, and reject timestamps more
 * than `toleranceSec` from now (Stripe's libraries use 300 s). Other schemes (v0) are ignored.
 */
export function verifyStripeSignature(rawBody: Buffer, header: string | undefined, secret: string, toleranceSec = 300, now = Date.now()) {
  if (!header) throw new BadRequestException({ code: 'BAD_SIGNATURE', message: 'Missing Stripe-Signature header' });
  let t: string | undefined;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') v1.push(v);
  }
  if (!t || !/^\d+$/.test(t) || !v1.length) throw new BadRequestException({ code: 'BAD_SIGNATURE', message: 'Malformed Stripe-Signature header' });
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
  if (!v1.some((s) => safeEqual(s, expected))) throw new BadRequestException({ code: 'BAD_SIGNATURE', message: 'Stripe signature does not match' });
  if (Math.abs(now / 1000 - Number(t)) > toleranceSec) throw new BadRequestException({ code: 'STALE_SIGNATURE', message: 'Stripe signature timestamp is outside the tolerance' });
}

/** Sign a payload the way Stripe does (used by tests and by the fake). */
export function signStripePayload(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
}

/** Amounts in Stripe are integers in the currency's smallest unit (cents for CAD). */
export const toCents = (amount: string) => {
  const [w, f = ''] = amount.split('.');
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
};
export const fromCents = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
