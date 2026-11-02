import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@ca/database';
import { PASSWORD, agent, bootApp, resetDb, setupAdmin } from './helpers';
import { fakeResend, fakeStripe } from './fixtures';
import { signStripePayload } from '../src/payments/stripe';

let app: INestApplication;
let prisma: PrismaClient;
let mail: ReturnType<typeof fakeResend>;
let stripe: ReturnType<typeof fakeStripe>;
const WHSEC = 'whsec_platform0123456789';
beforeAll(async () => ({ app, prisma } = await bootApp({ APP_MODE: 'saas', RESEND_API_KEY: 're_test_key', MAIL_FROM: 'hello@mail.example.test', STRIPE_SECRET_KEY: 'sk_test_platformKEY123', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_PRICE_STARTER: 'price_starter', STRIPE_PRICE_ESSENTIALS: 'price_essentials', STRIPE_PRICE_PLUS: 'price_plus' })));
afterAll(async () => { await prisma.$disconnect(); await app.close(); });
beforeEach(async () => { await resetDb(prisma); await prisma.billingEvent.deleteMany(); mail = fakeResend(); stripe = fakeStripe(); });

const SIGNUP = { name: 'Jeanne Tremblay', email: 'jeanne@example.test', password: 'a-long-enough-passphrase', organizationName: 'Tremblay Holdings', companyName: 'Érablière Tremblay Inc.', province: 'QC', plan: 'essentials' };

async function signUpAndVerify() {
  await agent(app).post('/signup', SIGNUP).expect(201);
  const token = decodeURIComponent(/token=([^\s"&<]+)/.exec(mail.sent.at(-1)!.body.text)![1]);
  await agent(app).post('/signup/verify', { token }).expect(200);
  const a = agent(app);
  await a.post('/auth/login', { email: SIGNUP.email, password: SIGNUP.password }).expect(200);
  const companyId = (await prisma.company.findFirstOrThrow({ where: { legalName: SIGNUP.companyName } })).id;
  const org = await prisma.organization.findFirstOrThrow();
  return { a, companyId, org };
}
const hook = (event: object) => { const body = JSON.stringify(event); return agent(app).raw.post('/webhooks/stripe-billing').set('Content-Type', 'application/json').set('Stripe-Signature', signStripePayload(body, WHSEC)).send(body); };
const subEvent = (id: string, type: string, o: { status: string; price: string; orgId: string; periodEnd?: number; cancel?: boolean }) => ({ id, object: 'event', type, created: 1, data: { object: { id: 'sub_1', object: 'subscription', customer: 'cus_1', status: o.status, cancel_at_period_end: Boolean(o.cancel), metadata: { organizationId: o.orgId }, items: { object: 'list', data: [{ id: 'si_1', price: { id: o.price }, current_period_end: o.periodEnd ?? 1798761600 }] } } } });

describe('SaaS edition', () => {
  it('publishes its mode and plans (prices stay in Stripe)', async () => {
    const c = (await agent(app).get('/config').expect(200)).body;
    expect(c).toMatchObject({ mode: 'saas', trialDays: 30, signup: true });
    expect(c.plans.map((p: { id: string; maxUsers: number; available: boolean }) => [p.id, p.maxUsers, p.available])).toEqual([['starter', 1, true], ['essentials', 3, true], ['plus', 5, true]]);
  });

  it('signs up, requires the e-mail to be confirmed, and does not reveal existing addresses', async () => {
    expect((await agent(app).post('/signup', SIGNUP).expect(201)).body).toEqual({ email: SIGNUP.email, verificationSent: true });
    expect(mail.sent[0].body.to).toEqual([SIGNUP.email]);
    expect((await agent(app).post('/auth/login', { email: SIGNUP.email, password: SIGNUP.password }).expect(403)).body.code).toBe('EMAIL_NOT_VERIFIED');
    expect((await agent(app).post('/signup', { ...SIGNUP, organizationName: 'Again' }).expect(201)).body).toEqual({ email: SIGNUP.email, verificationSent: true });
    expect(await prisma.organization.count()).toBe(1);
    expect((await agent(app).post('/signup/verify', { token: 'x'.repeat(40) }).expect(400)).body.code).toBe('INVALID_TOKEN');
    const token = decodeURIComponent(/token=([^\s"&<]+)/.exec(mail.sent[0].body.text)![1]);
    expect((await prisma.emailToken.findFirstOrThrow()).tokenHash).not.toContain(token); // only the hash is stored
    await agent(app).post('/signup/verify', { token }).expect(200);
    expect((await agent(app).post('/signup/verify', { token }).expect(400)).body.code).toBe('INVALID_TOKEN'); // single use
    const a = agent(app);
    await a.post('/auth/login', { email: SIGNUP.email, password: SIGNUP.password }).expect(200);
    const b = (await a.get('/billing').expect(200)).body;
    expect(b).toMatchObject({ organization: { name: 'Tremblay Holdings' }, plan: { id: 'essentials' }, status: 'trialing', writable: true, subscribed: false, usage: { companies: 1, users: 1 } });
    const co = await prisma.company.findFirstOrThrow({ include: { memberships: true, accounts: true } });
    expect(co).toMatchObject({ legalName: SIGNUP.companyName, province: 'QC' });
    expect(co.memberships[0].role).toBe('OWNER');
    expect(co.accounts.length).toBeGreaterThan(40); // chart of accounts seeded
  });

  it('limits features and users by plan, then follows the Stripe subscription (checkout, upgrade, cancel → read-only)', async () => {
    const { a, companyId, org } = await signUpAndVerify();
    expect((await a.get(`/companies/${companyId}/inventory/valuation`).expect(403)).body.code).toBe('PLAN_FEATURE');
    await a.get(`/companies/${companyId}/time`).expect(200); // Essentials includes time
    const acct = await prisma.account.findFirstOrThrow({ where: { companyId, code: '4000' } });
    expect((await a.post(`/companies/${companyId}/items`, { name: 'Syrup', type: 'NON_INVENTORY', trackInventory: true, incomeAccountId: acct.id }).expect(403)).body.code).toBe('PLAN_FEATURE');
    for (const n of [1, 2]) await a.post(`/companies/${companyId}/members`, { email: `u${n}@example.test`, name: `U${n}`, role: 'BOOKKEEPER', temporaryPassword: PASSWORD }).expect(201);
    expect((await a.post(`/companies/${companyId}/members`, { email: 'u3@example.test', name: 'U3', role: 'BOOKKEEPER', temporaryPassword: PASSWORD }).expect(403)).body.code).toBe('PLAN_LIMIT');
    expect((await a.post('/billing/companies', { legalName: 'Second Co', province: 'ON' }).expect(403)).body.code).toBe('PLAN_LIMIT');

    const co = (await a.post('/billing/checkout', { plan: 'plus' }).expect(201)).body;
    expect(co.url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    const f = Object.fromEntries(stripe.sessions[0].form);
    expect(stripe.sessions[0].auth).toBe('Bearer sk_test_platformKEY123');
    expect(f).toMatchObject({ mode: 'subscription', 'line_items[0][price]': 'price_plus', 'line_items[0][quantity]': '1', client_reference_id: org.id, customer_email: SIGNUP.email, 'subscription_data[metadata][organizationId]': org.id, 'subscription_data[trial_period_days]': '29' });

    await hook({ id: 'evt_c', object: 'event', type: 'checkout.session.completed', created: 1, data: { object: { id: 'cs_test_1', object: 'checkout.session', mode: 'subscription', customer: 'cus_1', subscription: 'sub_1', client_reference_id: org.id, metadata: { organizationId: org.id } } } }).expect(200);
    await hook(subEvent('evt_s1', 'customer.subscription.updated', { status: 'active', price: 'price_plus', orgId: org.id })).expect(200);
    expect((await hook(subEvent('evt_s1', 'customer.subscription.updated', { status: 'active', price: 'price_plus', orgId: org.id })).expect(200)).body.duplicate).toBe(true);
    const after = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(after).toMatchObject({ plan: 'plus', status: 'active', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
    expect(after.currentPeriodEnd?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    await a.get(`/companies/${companyId}/inventory/valuation`).expect(200);
    expect((await a.post('/billing/checkout', { plan: 'plus' }).expect(400)).body.code).toBe('ALREADY_SUBSCRIBED');
    expect((await a.post('/billing/portal').expect(201)).body.url).toBe('https://billing.stripe.com/p/session/test_1');
    expect(Object.fromEntries(stripe.portals[0].form)).toEqual({ customer: 'cus_1', return_url: 'http://localhost:3000/billing' });

    // cancelled: everything stays readable and exportable, nothing can change
    await hook(subEvent('evt_s2', 'customer.subscription.deleted', { status: 'canceled', price: 'price_plus', orgId: org.id })).expect(200);
    const res = await a.post(`/companies/${companyId}/contacts`, { kind: 'CUSTOMER', name: 'Nope' });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('SUBSCRIPTION_INACTIVE');
    await a.get(`/companies/${companyId}/accounts`).expect(200);
    expect((await a.get('/billing').expect(200)).body).toMatchObject({ status: 'canceled', writable: false });
  });

  it('an expired trial is read-only; the platform console sees subscriptions, not books, and can extend a trial', async () => {
    const root = await setupAdmin(app, 'root@example.test'); // the platform administrator (first account on the server)
    const { a, companyId, org } = await signUpAndVerify();
    await prisma.organization.update({ where: { id: org.id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    expect((await a.post(`/companies/${companyId}/contacts`, { kind: 'CUSTOMER', name: 'Late' })).status).toBe(402);
    expect((await a.get('/admin/organizations')).status).toBe(403);

    const list = (await root.get('/admin/organizations').expect(200)).body;
    expect(list[0]).toMatchObject({ name: 'Tremblay Holdings', plan: 'essentials', writable: false, usage: { companies: 1, users: 1 }, owner: { email: SIGNUP.email } });
    await root.get(`/companies/${companyId}/accounts`).expect(404); // a super admin still has no access to the books
    await root.post(`/admin/organizations/${org.id}/extend-trial`, { days: 14 }).expect(201);
    await a.post(`/companies/${companyId}/contacts`, { kind: 'CUSTOMER', name: 'Back' }).expect(201);
  });

  it('webhooks must carry the platform signature', async () => {
    const body = JSON.stringify(subEvent('evt_x', 'customer.subscription.updated', { status: 'active', price: 'price_plus', orgId: '00000000-0000-4000-8000-000000000000' }));
    expect((await agent(app).raw.post('/webhooks/stripe-billing').set('Content-Type', 'application/json').set('Stripe-Signature', signStripePayload(body, 'whsec_other0000000000')).send(body).expect(400)).body.code).toBe('BAD_SIGNATURE');
  });
});

describe('self-hosted edition', () => {
  it('has no sign-up or billing', async () => {
    const { app: selfApp, prisma: p2 } = await bootApp({ APP_MODE: 'selfhosted' });
    try {
      expect((await agent(selfApp).get('/config').expect(200)).body).toEqual({ mode: 'selfhosted', appName: 'Canadian Accounting' });
      await agent(selfApp).post('/signup', SIGNUP).expect(404);
    } finally {
      await p2.$disconnect();
      await selfApp.close();
    }
  });
});
