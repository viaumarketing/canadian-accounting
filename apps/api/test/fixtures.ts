import { mailFetch } from '../src/mail/mail.service';
import { stripeFetch } from '../src/payments/stripe';
import type { agent } from './helpers';

type A = ReturnType<typeof agent>;

/** An Ontario company with a fiscal year, its chart of accounts and tax codes, and one customer and one supplier. */
export async function company(root: A, o: { province?: string; legalName?: string } = {}) {
  const c = (await root.post('/admin/companies', { legalName: o.legalName ?? 'Érablière Test Inc.', province: o.province ?? 'ON', ownerEmail: 'root@example.test' }).expect(201)).body;
  await root.post(`/companies/${c.id}/fiscal-years`, { startDate: '2026-01-01' });
  const accts = (await root.get(`/companies/${c.id}/accounts`).expect(200)).body as { id: string; code: string }[];
  const codes = (await root.get(`/companies/${c.id}/tax-codes`).expect(200)).body as { id: string; code: string }[];
  const customer = (await root.post(`/companies/${c.id}/contacts`, { kind: 'CUSTOMER', name: 'Maple Café', email: 'ap@maple.example', billingAddress: '12 Rue Principale\nOttawa ON K1A 0A1', defaultTerms: 'NET_30' }).expect(201)).body.id as string;
  const vendor = (await root.post(`/companies/${c.id}/contacts`, { kind: 'VENDOR', name: 'Sugar Shack Supply', email: 'orders@shack.example' }).expect(201)).body.id as string;
  return { id: c.id as string, acct: Object.fromEntries(accts.map((a) => [a.code, a.id])) as Record<string, string>, tax: Object.fromEntries(codes.map((a) => [a.code, a.id])) as Record<string, string>, customer, vendor };
}
export type Co = Awaited<ReturnType<typeof company>>;

export const invoiceBody = (co: Co, o: Partial<{ amount: string; qty: string; issueDate: string; dueDate: string; contactId: string }> = {}) => ({
  contactId: o.contactId ?? co.customer, issueDate: o.issueDate ?? '2026-10-01', dueDate: o.dueDate ?? '2026-10-31', terms: 'NET_30',
  lines: [{ description: 'Syrup case', quantity: o.qty ?? '1', unitPrice: o.amount ?? '100.00', accountId: co.acct['4000'], taxCodeId: co.tax.HST_ON }],
});

export async function postedInvoice(root: A, co: Co, o: Parameters<typeof invoiceBody>[1] = {}) {
  const inv = (await root.post(`/companies/${co.id}/invoices`, invoiceBody(co, o)).expect(201)).body;
  return (await root.post(`/companies/${co.id}/invoices/${inv.id}/post`).expect(201)).body as { id: string; number: string };
}

/** Fake Resend: records each request and answers like the real API ({"id": ...} or an error object). */
export function fakeResend() {
  const sent: { headers: Record<string, string>; body: { from: string; to: string[]; cc?: string[]; reply_to?: string; subject: string; html: string; text: string; attachments?: { filename: string; content: string }[]; tags?: { name: string; value: string }[] } }[] = [];
  let fail: { status: number; message: string } | null = null;
  mailFetch.fn = (async (url: string, init: RequestInit) => {
    if (url !== 'https://api.resend.com/emails') throw new Error(`unexpected URL ${url}`);
    const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    if (fail) return new Response(JSON.stringify({ statusCode: fail.status, name: 'validation_error', message: fail.message }), { status: fail.status, headers: { 'content-type': 'application/json' } });
    sent.push({ headers, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { sent, failNext: (status: number, message: string) => { fail = { status, message }; }, ok: () => { fail = null; } };
}

/** 1×1 PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** Fake Stripe: GET /v1/account and POST /v1/checkout/sessions, answering with the documented shapes. */
export function fakeStripe() {
  const sessions: { auth: string; form: URLSearchParams; id: string }[] = [];
  const portals: { auth: string; form: URLSearchParams }[] = [];
  stripeFetch.fn = (async (url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).Authorization;
    if (auth.includes('sk_test_rejected')) return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid API Key provided: sk_test_****cted' } }), { status: 401 });
    if (url === 'https://api.stripe.com/v1/account') return new Response(JSON.stringify({ id: 'acct_123', object: 'account', settings: { dashboard: { display_name: 'Érablière Test' } } }), { status: 200 });
    if (url === 'https://api.stripe.com/v1/checkout/sessions' && init.method === 'POST') {
      const id = `cs_test_${sessions.length + 1}`;
      sessions.push({ auth, form: new URLSearchParams(String(init.body)), id });
      return new Response(JSON.stringify({ id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}`, status: 'open', payment_status: 'unpaid' }), { status: 200 });
    }
    if (url === 'https://api.stripe.com/v1/billing_portal/sessions' && init.method === 'POST') {
      portals.push({ auth, form: new URLSearchParams(String(init.body)) });
      return new Response(JSON.stringify({ id: 'bps_1', object: 'billing_portal.session', url: 'https://billing.stripe.com/p/session/test_1' }), { status: 200 });
    }
    throw new Error(`unexpected Stripe call ${init.method} ${url}`);
  }) as unknown as typeof fetch;
  return { sessions, portals };
}

export const checkoutCompleted = (o: { eventId: string; sessionId: string; amountCents: number; currency?: string; paid?: boolean; type?: string; created?: number }) => JSON.stringify({
  id: o.eventId, object: 'event', type: o.type ?? 'checkout.session.completed', created: o.created ?? Math.floor(Date.parse('2026-10-15T15:00:00Z') / 1000), livemode: false,
  data: { object: { id: o.sessionId, object: 'checkout.session', payment_status: o.paid === false ? 'unpaid' : 'paid', status: 'complete', amount_total: o.amountCents, currency: o.currency ?? 'cad', payment_intent: `pi_${o.sessionId}`, metadata: {} } },
});
