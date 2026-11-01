import { createHmac, timingSafeEqual } from 'node:crypto';

/** X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(rawBody, clientSecret)). Must be computed over the raw bytes. */
export function verifyWebhookHmac(rawBody: Buffer | string, headerValue: string | undefined, clientSecret: string): boolean {
  if (!headerValue) return false;
  const digest = createHmac('sha256', clientSecret).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(headerValue, 'base64');
  } catch {
    return false;
  }
  return given.length === digest.length && timingSafeEqual(given, digest);
}

export const WEBHOOK_TOPICS = ['ORDERS_UPDATED', 'ORDERS_CANCELLED', 'REFUNDS_CREATE', 'DISPUTES_CREATE', 'DISPUTES_UPDATE', 'APP_UNINSTALLED'] as const;
