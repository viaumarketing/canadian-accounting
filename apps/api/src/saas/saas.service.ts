import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@ca/database';
import type { PlanId } from '@ca/shared';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppConfig, CONFIG } from '../config';
import { hashPassword } from '../auth/password';
import { randomToken, sha256 } from '../common/crypto';
import { MailService } from '../mail/mail.service';
import { emailHtml } from '../documents/documents.service';
import { seedAccounting } from '../accounting/setup';
import { currentFiscalYear } from '../companies/fiscal-year';
import { StripeError, stripeRequest, verifyStripeSignature } from '../payments/stripe';
import { PLANS, writable, type Feature } from './plans';

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;
const VERIFY_HOURS = 24;

interface StripeSubscription { id: string; customer: string; status: string; cancel_at_period_end: boolean; metadata: Record<string, string> | null; items: { data: { price: { id: string }; current_period_end?: number }[] } }
interface StripeCheckoutSession { id: string; mode: string; customer: string | null; subscription: string | null; client_reference_id: string | null; metadata: Record<string, string> | null }

/**
 * The SaaS edition (APP_MODE=saas): public sign-up with e-mail verification, a trial, plans with limits, and subscriptions
 * through the platform's Stripe account (Checkout to subscribe, the customer portal to manage, webhooks to stay in sync).
 * In the self-hosted edition every method here refuses with 404, and nothing is limited.
 */
@Injectable()
export class SaasService {
  private readonly log = new Logger('Saas');
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly mail: MailService, @Inject(CONFIG) private readonly config: AppConfig) {}

  get enabled() { return this.config.APP_MODE === 'saas'; }
  private need() { if (!this.enabled) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not available on this installation' }); }

  /** What the web app needs before sign-in: which edition this is and, for SaaS, the plans. */
  publicConfig() {
    return {
      mode: this.config.APP_MODE, appName: this.config.APP_NAME,
      ...(this.enabled ? { trialDays: this.config.SAAS_TRIAL_DAYS, plans: Object.values(PLANS).map((p) => ({ ...p, available: Boolean(this.priceId(p.id)) })), signup: this.mail.configured } : {}),
    };
  }

  private priceId(plan: PlanId) {
    return { starter: this.config.STRIPE_PRICE_STARTER, essentials: this.config.STRIPE_PRICE_ESSENTIALS, plus: this.config.STRIPE_PRICE_PLUS }[plan];
  }
  private planOfPrice(priceId: string | undefined): PlanId | null {
    return (Object.keys(PLANS) as PlanId[]).find((p) => priceId && this.priceId(p) === priceId) ?? null;
  }

  // ================================================================ sign-up and verification

  async signup(i: { name: string; email: string; password: string; organizationName: string; companyName: string; province: string; plan: PlanId }, ip: string | null) {
    this.need();
    if (!this.mail.configured) throw new ServiceUnavailableException({ code: 'MAIL_NOT_CONFIGURED', message: 'Sign-up is not available yet: this server cannot send e-mail' });
    const generic = { email: i.email, verificationSent: true };
    // The same answer whether or not the address is already registered, so sign-up cannot be used to find accounts.
    if (await this.prisma.user.findUnique({ where: { email: i.email } })) {
      await this.audit.record({ action: 'saas.signup_existing_email', ip, metadata: { email: i.email } });
      return generic;
    }
    const passwordHash = await hashPassword(i.password);
    const token = randomToken(32);
    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({ data: { email: i.email, name: i.name, passwordHash } });
      const org = await tx.organization.create({ data: { name: i.organizationName, ownerId: u.id, plan: i.plan, status: 'trialing', trialEndsAt: new Date(Date.now() + this.config.SAAS_TRIAL_DAYS * DAY) } });
      await this.createCompany(tx, org.id, u.id, { legalName: i.companyName, province: i.province });
      await tx.emailToken.create({ data: { userId: u.id, purpose: 'verify_email', tokenHash: sha256(token), expiresAt: new Date(Date.now() + VERIFY_HOURS * 3600_000) } });
      await this.audit.record({ action: 'saas.signup', actorId: u.id, entityType: 'Organization', entityId: org.id, metadata: { plan: i.plan }, ip }, tx);
      return u;
    });
    await this.sendVerification(user.id, user.email, user.name, token).catch((e) => this.log.warn(`verification e-mail: ${(e as Error).message}`));
    return generic;
  }

  private async createCompany(tx: Tx, organizationId: string, ownerId: string, c: { legalName: string; province: string }) {
    const company = await tx.company.create({ data: { legalName: c.legalName, province: c.province, organizationId, memberships: { create: { userId: ownerId, role: 'OWNER' } }, fiscalYears: { create: currentFiscalYear(new Date(), 12, 31) } } });
    await seedAccounting(tx, company.id);
    return company;
  }

  private async sendVerification(userId: string, email: string, name: string, token: string) {
    const link = `${this.config.WEB_ORIGIN.replace(/\/$/, '')}/verify-email?token=${encodeURIComponent(token)}`;
    const text = `Hello ${name},\n\nConfirm your e-mail address to start your ${this.config.SAAS_TRIAL_DAYS}-day trial of ${this.config.APP_NAME}:\n\n${link}\n\nThe link expires in ${VERIFY_HOURS} hours. If you did not sign up, ignore this message.`;
    await this.mail.send({ kind: 'verify_email', to: [email], subject: `Confirm your e-mail for ${this.config.APP_NAME}`, text, html: emailHtml(text, { company: this.config.APP_NAME, link }), sentById: userId, idempotencyKey: `verify-${sha256(token).slice(0, 32)}` });
  }

  async verify(token: string) {
    this.need();
    const t = await this.prisma.emailToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!t || t.purpose !== 'verify_email' || t.usedAt || t.expiresAt < new Date()) throw new BadRequestException({ code: 'INVALID_TOKEN', message: 'This link is invalid or has expired; ask for a new one' });
    await this.prisma.$transaction([
      this.prisma.emailToken.update({ where: { id: t.id }, data: { usedAt: new Date() } }),
      this.prisma.user.update({ where: { id: t.userId }, data: { emailVerifiedAt: new Date() } }),
    ]);
    await this.audit.record({ action: 'saas.email_verified', actorId: t.userId });
    return { verified: true };
  }

  /** Always the same answer (no account enumeration). */
  async resend(email: string) {
    this.need();
    const u = await this.prisma.user.findUnique({ where: { email } });
    if (u && !u.emailVerifiedAt && (await this.prisma.emailToken.findFirst({ where: { userId: u.id, purpose: 'verify_email' } }))) {
      const recent = await this.prisma.emailToken.count({ where: { userId: u.id, purpose: 'verify_email', createdAt: { gt: new Date(Date.now() - 3600_000) } } });
      if (recent < 5) {
        const token = randomToken(32);
        await this.prisma.emailToken.create({ data: { userId: u.id, purpose: 'verify_email', tokenHash: sha256(token), expiresAt: new Date(Date.now() + VERIFY_HOURS * 3600_000) } });
        await this.sendVerification(u.id, u.email, u.name, token).catch(() => undefined);
      }
    }
    return { sent: true };
  }

  /** Login check: someone who signed up must confirm their address first (invited members and self-hosted users never need to). */
  async assertVerified(userId: string) {
    if (!this.enabled) return;
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
    if (u?.emailVerifiedAt) return;
    if (await this.prisma.emailToken.findFirst({ where: { userId, purpose: 'verify_email' } })) throw new ForbiddenException({ code: 'EMAIL_NOT_VERIFIED', message: 'Confirm your e-mail address first: use the link we sent you' });
  }

  // ================================================================ the organization, limits

  private async ownedOrg(userId: string) {
    this.need();
    const org = await this.prisma.organization.findFirst({ where: { ownerId: userId }, orderBy: { createdAt: 'asc' } });
    if (!org) throw new NotFoundException({ code: 'NO_ORGANIZATION', message: 'You do not own a subscription; ask the account owner' });
    return org;
  }

  private async usage(organizationId: string) {
    const companies = await this.prisma.company.count({ where: { organizationId } });
    const users = await this.prisma.companyMembership.findMany({ where: { company: { organizationId }, status: 'ACTIVE' }, distinct: ['userId'], select: { userId: true } });
    return { companies, users: users.length };
  }

  async billing(userId: string) {
    const org = await this.ownedOrg(userId);
    const plan = PLANS[org.plan as PlanId];
    return {
      organization: { id: org.id, name: org.name },
      plan: plan ?? null, status: org.status, trialEndsAt: org.trialEndsAt, currentPeriodEnd: org.currentPeriodEnd, cancelAtPeriodEnd: org.cancelAtPeriodEnd,
      subscribed: Boolean(org.stripeSubscriptionId), writable: writable(org), usage: await this.usage(org.id),
      plans: Object.values(PLANS).map((p) => ({ ...p, available: Boolean(this.priceId(p.id)) })),
    };
  }

  /** SaaS: a company may add a user only within its organization's plan. Counted across all the organization's companies. */
  async assertSeat(tx: Tx, companyId: string, userId?: string) {
    if (!this.enabled) return;
    const c = await tx.company.findUnique({ where: { id: companyId }, include: { organization: true } });
    if (!c?.organization) return;
    const plan = PLANS[c.organization.plan as PlanId];
    const members = await tx.companyMembership.findMany({ where: { company: { organizationId: c.organization.id }, status: 'ACTIVE' }, distinct: ['userId'], select: { userId: true } });
    if (userId && members.some((m) => m.userId === userId)) return; // already counted
    if (plan && members.length >= plan.maxUsers) throw new ForbiddenException({ code: 'PLAN_LIMIT', message: `Your ${plan.name} plan includes ${plan.maxUsers} user${plan.maxUsers === 1 ? '' : 's'}; upgrade to add more` });
  }

  async assertFeature(companyId: string, feature: Feature) {
    if (!this.enabled) return;
    const c = await this.prisma.company.findUnique({ where: { id: companyId }, include: { organization: true } });
    const plan = c?.organization ? PLANS[c.organization.plan as PlanId] : null;
    if (c?.organization && !plan?.features.includes(feature)) throw new ForbiddenException({ code: 'PLAN_FEATURE', message: `Your ${plan?.name ?? c.organization.plan} plan does not include this feature; upgrade in Billing`, feature });
  }

  /** Another company in the same subscription (within the plan's company limit). */
  async addCompany(userId: string, c: { legalName: string; province: string }, ip: string | null) {
    const org = await this.ownedOrg(userId);
    if (!writable(org)) throw new UnprocessableEntityException({ code: 'SUBSCRIPTION_INACTIVE', message: 'Renew your subscription to add a company' });
    const plan = PLANS[org.plan as PlanId];
    if ((await this.usage(org.id)).companies >= plan.maxCompanies) throw new ForbiddenException({ code: 'PLAN_LIMIT', message: `Your ${plan.name} plan includes ${plan.maxCompanies} compan${plan.maxCompanies === 1 ? 'y' : 'ies'}; upgrade to add more` });
    const company = await this.prisma.$transaction((tx) => this.createCompany(tx, org.id, userId, c));
    await this.audit.record({ action: 'company.provisioned', companyId: company.id, actorId: userId, entityType: 'Company', entityId: company.id, metadata: { organizationId: org.id }, ip });
    return company;
  }

  // ================================================================ Stripe Billing

  private stripeKey() {
    if (!this.config.STRIPE_SECRET_KEY) throw new ServiceUnavailableException({ code: 'BILLING_NOT_CONFIGURED', message: 'Subscriptions are not set up on this server (STRIPE_SECRET_KEY)' });
    return this.config.STRIPE_SECRET_KEY;
  }

  /** Stripe Checkout in subscription mode for the chosen plan; any trial days left carry over. */
  async checkout(userId: string, plan: PlanId) {
    const org = await this.ownedOrg(userId);
    const price = this.priceId(plan);
    if (!price) throw new BadRequestException({ code: 'PLAN_UNAVAILABLE', message: 'That plan cannot be bought yet' });
    if (org.stripeSubscriptionId && !['canceled', 'incomplete_expired'].includes(org.status)) throw new BadRequestException({ code: 'ALREADY_SUBSCRIBED', message: 'You already have a subscription; change it in the billing portal' });
    const owner = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const daysLeft = org.trialEndsAt ? Math.floor((org.trialEndsAt.getTime() - Date.now()) / DAY) : 0;
    const base = this.config.WEB_ORIGIN.replace(/\/$/, '');
    try {
      const s = await stripeRequest<{ id: string; url: string }>(this.stripeKey(), 'POST', '/v1/checkout/sessions', {
        mode: 'subscription',
        line_items: [{ price, quantity: 1 }],
        success_url: `${base}/billing?checkout=success`,
        cancel_url: `${base}/billing?checkout=cancelled`,
        client_reference_id: org.id,
        ...(org.stripeCustomerId ? { customer: org.stripeCustomerId } : { customer_email: owner.email }),
        metadata: { organizationId: org.id, plan },
        subscription_data: { metadata: { organizationId: org.id, plan }, ...(daysLeft >= 1 ? { trial_period_days: daysLeft } : {}) },
      });
      return { url: s.url };
    } catch (e) {
      if (e instanceof StripeError) throw new UnprocessableEntityException({ code: 'STRIPE_ERROR', message: `Stripe could not start the checkout: ${e.message}` });
      throw e;
    }
  }

  /** The Stripe customer portal: change plan, update the card, see invoices, cancel. */
  async portal(userId: string) {
    const org = await this.ownedOrg(userId);
    if (!org.stripeCustomerId) throw new BadRequestException({ code: 'NOT_SUBSCRIBED', message: 'Subscribe first' });
    try {
      const s = await stripeRequest<{ url: string }>(this.stripeKey(), 'POST', '/v1/billing_portal/sessions', { customer: org.stripeCustomerId, return_url: `${this.config.WEB_ORIGIN.replace(/\/$/, '')}/billing` });
      return { url: s.url };
    } catch (e) {
      if (e instanceof StripeError) throw new UnprocessableEntityException({ code: 'STRIPE_ERROR', message: `Stripe could not open the portal: ${e.message}` });
      throw e;
    }
  }

  async webhook(raw: Buffer | undefined, signature: string | undefined) {
    if (!this.enabled || !this.config.STRIPE_WEBHOOK_SECRET || !raw) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Unknown endpoint' });
    verifyStripeSignature(raw, signature, this.config.STRIPE_WEBHOOK_SECRET);
    const event = JSON.parse(raw.toString('utf8')) as { id: string; type: string; data: { object: StripeSubscription & StripeCheckoutSession } };
    try {
      await this.prisma.billingEvent.create({ data: { id: event.id, type: event.type } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { received: true, duplicate: true };
      throw e;
    }
    try {
      const o = event.data.object;
      if (event.type === 'checkout.session.completed' && o.mode === 'subscription') {
        const orgId = o.metadata?.organizationId ?? o.client_reference_id;
        if (orgId) await this.prisma.organization.updateMany({ where: { id: orgId }, data: { stripeCustomerId: o.customer, stripeSubscriptionId: o.subscription } });
      } else if (event.type.startsWith('customer.subscription.')) {
        await this.syncSubscription(o, event.type === 'customer.subscription.deleted');
      }
    } catch (e) {
      await this.prisma.billingEvent.delete({ where: { id: event.id } }).catch(() => undefined);
      throw e;
    }
    return { received: true };
  }

  /** Mirror the subscription: status, plan (from the price), period end (on the subscription item), cancel at period end. */
  private async syncSubscription(s: StripeSubscription, deleted: boolean) {
    const org = (await this.prisma.organization.findUnique({ where: { stripeSubscriptionId: s.id } })) ?? (s.metadata?.organizationId ? await this.prisma.organization.findUnique({ where: { id: s.metadata.organizationId } }) : null);
    if (!org) { this.log.warn(`subscription ${s.id} matches no organization`); return; }
    const item = s.items?.data?.[0];
    const plan = this.planOfPrice(item?.price?.id);
    await this.prisma.organization.update({
      where: { id: org.id },
      data: {
        stripeSubscriptionId: s.id, stripeCustomerId: s.customer, status: deleted ? 'canceled' : s.status, cancelAtPeriodEnd: Boolean(s.cancel_at_period_end),
        ...(plan ? { plan } : {}), ...(item?.current_period_end ? { currentPeriodEnd: new Date(item.current_period_end * 1000) } : {}),
      },
    });
    await this.audit.record({ action: 'saas.subscription_synced', entityType: 'Organization', entityId: org.id, metadata: { status: deleted ? 'canceled' : s.status, plan: plan ?? org.plan } });
  }

  // ================================================================ platform console (super admins: subscriptions only, no books)

  async listOrganizations() {
    this.need();
    const orgs = await this.prisma.organization.findMany({ orderBy: { createdAt: 'desc' }, include: { owner: { select: { email: true, name: true, emailVerifiedAt: true } }, _count: { select: { companies: true } } } });
    return Promise.all(orgs.map(async (o) => ({ id: o.id, name: o.name, owner: o.owner, plan: o.plan, status: o.status, trialEndsAt: o.trialEndsAt, currentPeriodEnd: o.currentPeriodEnd, cancelAtPeriodEnd: o.cancelAtPeriodEnd, subscribed: Boolean(o.stripeSubscriptionId), writable: writable(o), createdAt: o.createdAt, usage: await this.usage(o.id) })));
  }

  async extendTrial(organizationId: string, days: number, actorId: string, ip: string | null) {
    this.need();
    const o = await this.prisma.organization.findUnique({ where: { id: organizationId } });
    if (!o) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Organization not found' });
    if (o.stripeSubscriptionId) throw new BadRequestException({ code: 'SUBSCRIBED', message: 'This organization has a Stripe subscription; manage its trial in Stripe' });
    const from = o.trialEndsAt && o.trialEndsAt > new Date() ? o.trialEndsAt : new Date();
    const u = await this.prisma.organization.update({ where: { id: organizationId }, data: { trialEndsAt: new Date(from.getTime() + days * DAY), status: 'trialing' } });
    await this.audit.record({ action: 'saas.trial_extended', actorId, entityType: 'Organization', entityId: organizationId, metadata: { days }, ip });
    return { trialEndsAt: u.trialEndsAt };
  }
}

