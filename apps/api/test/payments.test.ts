import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@ca/database';
import { ORIGIN, agent, bootApp, resetDb, setupAdmin } from './helpers';
import { checkoutCompleted, company, fakeResend, fakeStripe, postedInvoice } from './fixtures';
import { formEncode, signStripePayload, toCents, fromCents } from '../src/payments/stripe';

let app: INestApplication;
let prisma: PrismaClient;
let stripe: ReturnType<typeof fakeStripe>;
beforeAll(async () => ({ app, prisma } = await bootApp({ RESEND_API_KEY: 're_test_key', MAIL_FROM: 'billing@mail.example.test' })));
afterAll(async () => { await prisma.$disconnect(); await app.close(); });
beforeEach(async () => { await resetDb(prisma); stripe = fakeStripe(); fakeResend(); });

const WHSEC = 'whsec_test0123456789abcdef';

describe('Stripe helpers', () => {
  it('form-encodes nested params like Stripe expects and converts cents exactly', () => {
    expect(decodeURIComponent(formEncode({ mode: 'payment', line_items: [{ price_data: { currency: 'cad', unit_amount: 11300 }, quantity: 1 }], metadata: { a: 'b' }, skip: undefined })))
      .toBe('mode=payment&line_items[0][price_data][currency]=cad&line_items[0][price_data][unit_amount]=11300&line_items[0][quantity]=1&metadata[a]=b');
    expect([toCents('113.00'), toCents('0.1'), toCents('19.99'), toCents('5')]).toEqual([11300, 10, 1999, 500]);
    expect([fromCents(11300), fromCents(5), fromCents(1999)]).toEqual(['113.00', '0.05', '19.99']);
  });
});

describe('card payments through the company\'s Stripe account', () => {
  it('connects, opens Checkout from the customer link, records the paid webhook once, and refuses bad signatures', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    expect((await root.put(`/companies/${co.id}/stripe`, { secretKey: 'sk_test_rejected0000' }).expect(400)).body.code).toBe('STRIPE_KEY_REJECTED');
    const st = (await root.put(`/companies/${co.id}/stripe`, { secretKey: 'sk_test_51abcdefghijKLMN', webhookSecret: WHSEC }).expect(200)).body;
    expect(st).toMatchObject({ connected: true, mode: 'test', accountName: 'Érablière Test', webhookConfigured: true, clearingAccount: { code: '1045', name: 'Stripe Clearing' } });
    const acct = await prisma.stripeAccount.findUniqueOrThrow({ where: { companyId: co.id } });
    expect(acct.secretKeyEnc).not.toContain('sk_test'); // encrypted at rest
    expect(st.webhookUrl).toBe(`${ORIGIN}/api/webhooks/stripe/${acct.id}`);

    const inv = await postedInvoice(root, co); // 113.00
    await root.post(`/companies/${co.id}/invoices/${inv.id}/send`, { to: ['ap@maple.example'] }).expect(201);
    const token = (await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).payToken!;
    const pub = agent(app);
    expect((await pub.get(`/public/invoices/${token}`).expect(200)).body).toMatchObject({ number: 'INV-0001', balance: '113.00', status: 'open', canPayOnline: true, customer: 'Maple Café' });
    await pub.get('/public/invoices/not-a-real-token-but-long-enough').expect(404);
    expect((await pub.get(`/public/invoices/${token}/pdf`).expect(200)).headers['content-type']).toBe('application/pdf');

    const c1 = (await pub.post(`/public/invoices/${token}/checkout`).expect(201)).body;
    expect(c1.url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    const f = stripe.sessions[0].form;
    expect(stripe.sessions[0].auth).toBe('Bearer sk_test_51abcdefghijKLMN');
    expect(Object.fromEntries(f)).toMatchObject({ mode: 'payment', 'line_items[0][price_data][currency]': 'cad', 'line_items[0][price_data][product_data][name]': 'Invoice INV-0001', 'line_items[0][price_data][unit_amount]': '11300', 'line_items[0][quantity]': '1', success_url: `${ORIGIN}/i/${token}?paid=1`, cancel_url: `${ORIGIN}/i/${token}`, client_reference_id: inv.id, customer_email: 'ap@maple.example', 'metadata[invoiceId]': inv.id });
    expect((await pub.post(`/public/invoices/${token}/checkout`).expect(201)).body.url).toBe(c1.url); // reused, not a second session
    expect(stripe.sessions).toHaveLength(1);

    const hook = (body: string, sig: string) => pub.raw.post(`/webhooks/stripe/${acct.id}`).set('Content-Type', 'application/json').set('Stripe-Signature', sig).send(body);
    const body = checkoutCompleted({ eventId: 'evt_1', sessionId: 'cs_test_1', amountCents: 11300 });
    expect((await hook(body, signStripePayload(body, 'whsec_wrongsecret0000')).expect(400)).body.code).toBe('BAD_SIGNATURE');
    expect((await hook(body, signStripePayload(body, WHSEC, Math.floor(Date.now() / 1000) - 600)).expect(400)).body.code).toBe('STALE_SIGNATURE');
    expect((await hook(body.replace('11300', '1'), signStripePayload(body, WHSEC)).expect(400)).body.code).toBe('BAD_SIGNATURE'); // tampered
    expect((await hook(body, signStripePayload(body, WHSEC)).expect(200)).body).toEqual({ received: true });
    expect((await hook(body, signStripePayload(body, WHSEC)).expect(200)).body).toEqual({ received: true, duplicate: true });

    const paid = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(paid.status).toBe('PAID');
    const payments = await prisma.payment.findMany({ where: { companyId: co.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ bankAccountId: st.clearingAccount.id, method: 'CREDIT_CARD', reference: 'Stripe pi_cs_test_1' });
    expect(payments[0].date.toISOString().slice(0, 10)).toBe('2026-10-15');
    expect((await pub.get(`/public/invoices/${token}`).expect(200)).body).toMatchObject({ status: 'paid', canPayOnline: false });
    expect((await pub.post(`/public/invoices/${token}/checkout`).expect(409)).body.code).toBe('NOTHING_DUE');
    expect((await root.post(`/companies/${co.id}/payments/${payments[0].id}/void`, {})).body.code).toBe('CARD_PAYMENT');
  });

  it('holds a payment that does not fit the invoice for review instead of guessing', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await root.put(`/companies/${co.id}/stripe`, { secretKey: 'sk_test_51abcdefghijKLMN', webhookSecret: WHSEC }).expect(200);
    const acct = await prisma.stripeAccount.findUniqueOrThrow({ where: { companyId: co.id } });
    const inv = await postedInvoice(root, co);
    await root.post(`/companies/${co.id}/invoices/${inv.id}/send`, { to: ['ap@maple.example'] }).expect(201);
    const token = (await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).payToken!;
    await agent(app).post(`/public/invoices/${token}/checkout`).expect(201);
    // meanwhile the customer paid by cheque
    await root.post(`/companies/${co.id}/payments`, { direction: 'RECEIPT', contactId: co.customer, bankAccountId: co.acct['1010'], date: '2026-10-14', amount: '113.00', allocations: [{ documentId: inv.id, amount: '113.00' }] }).expect(201);
    const body = checkoutCompleted({ eventId: 'evt_9', sessionId: 'cs_test_1', amountCents: 11300 });
    await agent(app).raw.post(`/webhooks/stripe/${acct.id}`).set('Content-Type', 'application/json').set('Stripe-Signature', signStripePayload(body, WHSEC)).send(body).expect(200);
    expect((await prisma.stripeCheckout.findUniqueOrThrow({ where: { sessionId: 'cs_test_1' } })).status).toBe('NEEDS_REVIEW');
    expect(await prisma.payment.count({ where: { companyId: co.id } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { action: 'stripe.payment_needs_review' } })).toBe(1);
  });
});

describe('Undeposited Funds and bank deposits', () => {
  it('groups undeposited payments and receipts into one deposit with a fee line, and void releases them', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const uf = await prisma.account.findFirstOrThrow({ where: { companyId: co.id, special: 'UNDEPOSITED_FUNDS' } });
    expect(uf.code).toBe('1050');
    const a = await postedInvoice(root, co); const b = await postedInvoice(root, co, { amount: '50.00' });
    const p1 = (await root.post(`/companies/${co.id}/payments`, { direction: 'RECEIPT', contactId: co.customer, bankAccountId: uf.id, date: '2026-10-10', amount: '113.00', method: 'CHEQUE', reference: 'Chq 101', allocations: [{ documentId: a.id, amount: '113.00' }] }).expect(201)).body;
    await root.post(`/companies/${co.id}/payments`, { direction: 'RECEIPT', contactId: co.customer, bankAccountId: uf.id, date: '2026-10-11', amount: '56.50', allocations: [{ documentId: b.id, amount: '56.50' }] }).expect(201);
    const r = (await root.post(`/companies/${co.id}/sales-receipts`, { contactId: co.customer, date: '2026-10-12', paymentMethod: 'CASH', depositAccountId: uf.id, lines: [{ description: 'Tour', quantity: '1', unitPrice: '20', accountId: co.acct['4000'], taxCodeId: co.tax.HST_ON }], post: true }).expect(201)).body;

    const und = (await root.get(`/companies/${co.id}/deposits/undeposited`).expect(200)).body;
    expect(und.items.map((i: { type: string; amount: string }) => [i.type, i.amount])).toEqual([['payment', '113.00'], ['payment', '56.50'], ['sales_receipt', '22.60']]);

    expect((await root.post(`/companies/${co.id}/deposits`, { date: '2026-10-13', bankAccountId: uf.id, items: [{ type: 'payment', id: p1.id }] })).body.code).toBe('INVALID_ACCOUNT');
    const dep = (await root.post(`/companies/${co.id}/deposits`, { date: '2026-10-13', bankAccountId: co.acct['1010'], memo: 'Branch deposit', items: und.items.map((i: { type: string; id: string }) => ({ type: i.type, id: i.id })), otherLines: [{ accountId: co.acct['6020'], amount: '-2.50', description: 'Deposit fee' }] }).expect(201)).body;
    expect(dep.total).toBe('189.6');
    const lines = await prisma.journalLine.findMany({ where: { entryId: dep.journalEntryId } });
    const net = (id: string) => lines.filter((l) => l.accountId === id).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    expect(net(co.acct['1010'])).toBeCloseTo(189.6);
    expect(net(uf.id)).toBeCloseTo(-192.1);
    expect(net(co.acct['6020'])).toBeCloseTo(2.5);
    expect((await root.get(`/companies/${co.id}/deposits/undeposited`).expect(200)).body.items).toHaveLength(0);
    // a deposited item cannot be deposited again, nor voided on its own
    expect((await root.post(`/companies/${co.id}/deposits`, { date: '2026-10-14', bankAccountId: co.acct['1010'], items: [{ type: 'payment', id: p1.id }] }).expect(409)).body.code).toBe('NOT_UNDEPOSITED');
    expect((await root.post(`/companies/${co.id}/payments/${p1.id}/void`, {})).body.code).toBe('DEPOSITED');
    expect((await root.post(`/companies/${co.id}/sales-receipts/${r.id}/void`)).body.code).toBe('DEPOSITED');

    await root.post(`/companies/${co.id}/deposits/${dep.id}/void`).expect(201);
    expect((await root.get(`/companies/${co.id}/deposits/undeposited`).expect(200)).body.items).toHaveLength(3);
    const bank = await prisma.journalLine.aggregate({ where: { companyId: co.id, accountId: co.acct['1010'] }, _sum: { debit: true, credit: true } });
    expect(Number(bank._sum.debit) - Number(bank._sum.credit)).toBe(0);
  });
});
