import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Prisma } from '@ca/database';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppConfig, CONFIG } from '../config';
import { decrypt, encrypt } from '../common/crypto';
import { isoOf } from '../accounting/setup';
import { ensureSpecialAccount } from '../accounting/special-accounts';
import { BillingService } from '../billing/billing.service';
import { DocumentsService } from '../documents/documents.service';
import { StripeError, fromCents, stripeRequest, toCents, verifyStripeSignature } from './stripe';

const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
/** Checkout Sessions expire 24 hours after creation by default; reuse an open one only well inside that. */
const REUSE_MS = 20 * 3600_000;

interface CheckoutSession { id: string; url: string | null; payment_status: 'paid' | 'unpaid' | 'no_payment_required'; status: 'open' | 'complete' | 'expired'; amount_total: number | null; currency: string | null; payment_intent: string | null; metadata: Record<string, string> | null }
interface StripeEventBody { id: string; type: string; created: number; livemode: boolean; data: { object: CheckoutSession } }

/**
 * Card payments on invoices through the company's own Stripe account: a Pay now link opens a Stripe Checkout Session; the
 * signed webhook records the payment against the invoice, into the Stripe clearing account. When Stripe pays out, the
 * payout is recorded as a bank deposit from the clearing account (with Stripe's fee as a negative line), the same pattern
 * as Shopify Payments.
 */
@Injectable()
export class StripePaymentsService {
  private readonly log = new Logger('StripePayments');
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly billing: BillingService, private readonly documents: DocumentsService, @Inject(CONFIG) private readonly config: AppConfig) {}

  private webhookUrl(accountId: string) { return `${this.config.WEB_ORIGIN.replace(/\/$/, '')}/api/webhooks/stripe/${accountId}`; }

  async status(companyId: string) {
    const a = await this.prisma.stripeAccount.findUnique({ where: { companyId } });
    if (!a) return { connected: false };
    const clearing = await this.prisma.account.findUnique({ where: { id: a.clearingAccountId }, select: { id: true, code: true, name: true } });
    return { connected: a.isActive, mode: a.mode, accountName: a.accountName, clearingAccount: clearing, webhookUrl: this.webhookUrl(a.id), webhookConfigured: Boolean(a.webhookSecretEnc), events: ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired'] };
  }

  /** Check the key with Stripe (GET /v1/account), then store it encrypted. */
  async connect(companyId: string, i: { secretKey: string; webhookSecret?: string }, actorId: string, ip: string | null) {
    let acct: { id: string; business_profile?: { name?: string | null } | null; settings?: { dashboard?: { display_name?: string | null } } | null };
    try {
      acct = await stripeRequest(i.secretKey, 'GET', '/v1/account');
    } catch (e) {
      if (e instanceof StripeError) throw new BadRequestException({ code: 'STRIPE_KEY_REJECTED', message: `Stripe rejected the key: ${e.message}` });
      throw e;
    }
    const clearing = await ensureSpecialAccount(this.prisma, companyId, 'STRIPE_CLEARING');
    await ensureSpecialAccount(this.prisma, companyId, 'UNDEPOSITED_FUNDS');
    const data = {
      secretKeyEnc: encrypt(i.secretKey, this.config.ENCRYPTION_KEY),
      ...(i.webhookSecret ? { webhookSecretEnc: encrypt(i.webhookSecret, this.config.ENCRYPTION_KEY) } : {}),
      mode: i.secretKey.includes('_live_') ? 'live' : 'test',
      accountName: acct.settings?.dashboard?.display_name || acct.business_profile?.name || acct.id,
      clearingAccountId: clearing.id, isActive: true,
    };
    const row = await this.prisma.stripeAccount.upsert({ where: { companyId }, create: { companyId, ...data }, update: data });
    await this.audit.record({ action: 'stripe.connected', companyId, actorId, entityType: 'StripeAccount', entityId: row.id, metadata: { mode: data.mode, account: acct.id }, ip });
    return this.status(companyId);
  }

  async disconnect(companyId: string, actorId: string, ip: string | null) {
    const a = await this.prisma.stripeAccount.findUnique({ where: { companyId } });
    if (!a) return;
    // Keys are removed; the row stays inactive so webhooks for sessions already open are still recognised and rejected cleanly.
    await this.prisma.stripeAccount.update({ where: { companyId }, data: { isActive: false, secretKeyEnc: '', webhookSecretEnc: null } });
    await this.audit.record({ action: 'stripe.disconnected', companyId, actorId, entityType: 'StripeAccount', entityId: a.id, ip });
  }

  // ---------------------------------------------------------------- customer side (public invoice page)

  private async byToken(token: string) {
    if (!/^[\w-]{20,64}$/.test(token)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'This link is not valid' });
    const inv = await this.prisma.invoice.findUnique({ where: { payToken: token }, include: { contact: { select: { name: true, email: true } }, company: { select: { id: true, legalName: true, operatingName: true, baseCurrency: true, isActive: true } } } });
    if (!inv || !inv.company.isActive || inv.kind !== 'STANDARD' || inv.status === 'DRAFT') throw new NotFoundException({ code: 'NOT_FOUND', message: 'This link is not valid' });
    return inv;
  }

  /** What the customer sees on the invoice link: nothing beyond what is printed on the invoice itself. */
  async publicInvoice(token: string) {
    const inv = await this.byToken(token);
    const stripe = await this.prisma.stripeAccount.findUnique({ where: { companyId: inv.companyId } });
    const balance = inv.status === 'VOID' ? D(0) : D(inv.total).minus(inv.amountPaid);
    const pending = await this.prisma.stripeCheckout.findFirst({ where: { invoiceId: inv.id, status: 'NEEDS_REVIEW' } });
    return {
      company: inv.company.operatingName || inv.company.legalName, customer: inv.contact.name, number: inv.number, issueDate: isoOf(inv.issueDate), dueDate: isoOf(inv.dueDate),
      currency: inv.currency, total: D(inv.total).toFixed(2), amountPaid: D(inv.amountPaid).toFixed(2), balance: balance.toFixed(2),
      status: inv.status === 'VOID' ? 'void' : balance.lte(0) ? 'paid' : 'open',
      canPayOnline: Boolean(stripe?.isActive && stripe.webhookSecretEnc && balance.gt(0) && !pending),
    };
  }

  async publicPdf(token: string) {
    const inv = await this.byToken(token);
    return this.documents.render(inv.companyId, 'invoice', inv.id);
  }

  /** Open (or reuse) a Stripe Checkout Session for the invoice's balance and return its URL. */
  async checkout(token: string) {
    const inv = await this.byToken(token);
    const stripe = await this.prisma.stripeAccount.findUnique({ where: { companyId: inv.companyId } });
    if (!stripe?.isActive || !stripe.webhookSecretEnc) throw new UnprocessableEntityException({ code: 'NO_ONLINE_PAYMENT', message: 'This business does not accept online payments' });
    const balance = D(inv.total).minus(inv.amountPaid);
    if (inv.status === 'VOID' || balance.lte(0)) throw new ConflictException({ code: 'NOTHING_DUE', message: 'This invoice has nothing left to pay' });
    const amount = balance.toFixed(2);
    const open = await this.prisma.stripeCheckout.findFirst({ where: { invoiceId: inv.id, status: 'OPEN', amount, createdAt: { gt: new Date(Date.now() - REUSE_MS) } }, orderBy: { createdAt: 'desc' } });
    if (open) return { url: open.url };
    const base = this.config.WEB_ORIGIN.replace(/\/$/, '');
    const s = await stripeRequest<CheckoutSession>(decrypt(stripe.secretKeyEnc, this.config.ENCRYPTION_KEY), 'POST', '/v1/checkout/sessions', {
      mode: 'payment',
      line_items: [{ price_data: { currency: inv.currency.toLowerCase(), product_data: { name: `Invoice ${inv.number}` }, unit_amount: toCents(amount) }, quantity: 1 }],
      success_url: `${base}/i/${token}?paid=1`,
      cancel_url: `${base}/i/${token}`,
      client_reference_id: inv.id,
      ...(inv.contact.email ? { customer_email: inv.contact.email } : {}),
      metadata: { invoiceId: inv.id, companyId: inv.companyId, invoiceNumber: inv.number ?? '' },
      payment_intent_data: { metadata: { invoiceId: inv.id, invoiceNumber: inv.number ?? '' } },
    }).catch((e) => {
      if (e instanceof StripeError) throw new UnprocessableEntityException({ code: 'STRIPE_ERROR', message: `Stripe could not start the payment: ${e.message}` });
      throw e;
    });
    if (!s.url) throw new UnprocessableEntityException({ code: 'STRIPE_ERROR', message: 'Stripe did not return a payment page' });
    await this.prisma.stripeCheckout.create({ data: { companyId: inv.companyId, invoiceId: inv.id, sessionId: s.id, url: s.url, amount } });
    return { url: s.url };
  }

  // ---------------------------------------------------------------- webhook

  async webhook(accountId: string, raw: Buffer | undefined, signature: string | undefined) {
    if (!/^[0-9a-f-]{36}$/.test(accountId)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Unknown endpoint' });
    const a = await this.prisma.stripeAccount.findUnique({ where: { id: accountId } });
    if (!a?.webhookSecretEnc || !raw) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Unknown endpoint' });
    verifyStripeSignature(raw, signature, decrypt(a.webhookSecretEnc, this.config.ENCRYPTION_KEY));
    const event = JSON.parse(raw.toString('utf8')) as StripeEventBody;
    try {
      await this.prisma.stripeEvent.create({ data: { companyId: a.companyId, eventId: event.id, type: event.type } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { received: true, duplicate: true };
      throw e;
    }
    try {
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') await this.completed(a.companyId, a.clearingAccountId, event);
      else if (event.type === 'checkout.session.expired') await this.prisma.stripeCheckout.updateMany({ where: { companyId: a.companyId, sessionId: event.data.object.id, status: 'OPEN' }, data: { status: 'EXPIRED' } });
    } catch (e) {
      // Let Stripe retry: forget the event so the retry is processed.
      await this.prisma.stripeEvent.deleteMany({ where: { companyId: a.companyId, eventId: event.id } });
      throw e;
    }
    return { received: true };
  }

  /** Record the card payment against the invoice (Dr Stripe clearing, Cr A/R), once per session. */
  private async completed(companyId: string, clearingAccountId: string, event: StripeEventBody) {
    const s = event.data.object;
    if (s.payment_status !== 'paid') return; // delayed methods: wait for async_payment_succeeded
    const co = await this.prisma.stripeCheckout.findUnique({ where: { sessionId: s.id } });
    if (!co || co.companyId !== companyId) { this.log.warn(`unknown checkout session ${s.id}`); return; }
    if (co.status === 'COMPLETED' || co.status === 'NEEDS_REVIEW') return;
    const inv = await this.prisma.invoice.findUniqueOrThrow({ where: { id: co.invoiceId } });
    const paid = fromCents(s.amount_total ?? 0);
    const outstanding = D(inv.total).minus(inv.amountPaid);
    const owner = await this.prisma.companyMembership.findFirst({ where: { companyId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } }, orderBy: { role: 'asc' } });
    if (!owner || inv.status === 'VOID' || D(paid).gt(outstanding) || (s.currency ?? '').toUpperCase() !== inv.currency) {
      // Paid twice, paid after the invoice was settled another way, or a currency mismatch: nothing is guessed; a person decides.
      await this.prisma.stripeCheckout.update({ where: { id: co.id }, data: { status: 'NEEDS_REVIEW', paymentIntentId: s.payment_intent, completedAt: new Date() } });
      await this.audit.record({ action: 'stripe.payment_needs_review', companyId, entityType: 'Invoice', entityId: inv.id, metadata: { session: s.id, amount: paid, outstanding: outstanding.toFixed(2) } });
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      const pay = await this.billing.createPayment(companyId, { direction: 'RECEIPT', contactId: inv.contactId, bankAccountId: clearingAccountId, date: isoOf(new Date(event.created * 1000)), amount: paid, reference: `Stripe ${s.payment_intent ?? s.id}`.slice(0, 100), method: 'CREDIT_CARD', allocations: [{ documentId: inv.id, amount: paid }] }, owner.userId, null, tx);
      await tx.stripeCheckout.update({ where: { id: co.id }, data: { status: 'COMPLETED', paymentId: pay.id, paymentIntentId: s.payment_intent, completedAt: new Date() } });
      await this.audit.record({ action: 'stripe.payment_received', companyId, actorId: owner.userId, entityType: 'Invoice', entityId: inv.id, metadata: { automatic: true, amount: paid, session: s.id, livemode: event.livemode } }, tx);
    });
  }

  listCheckouts(companyId: string) {
    return this.prisma.stripeCheckout.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' }, take: 200, include: { invoice: { select: { number: true } } } });
  }
}
