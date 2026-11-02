import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Prisma } from '@ca/database';
import { documentPdf, type DocumentStyle, type SalesDocument } from '@ca/reporting';
import type { DocumentTemplate, EmailKind } from '@ca/shared';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppConfig, CONFIG } from '../config';
import { MailService, escapeHtml } from '../mail/mail.service';
import { isoOf } from '../accounting/setup';
import { randomToken } from '../common/crypto';
import { BrandingService } from './branding.service';

const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());

export type DocType = 'invoice' | 'sales_receipt' | 'estimate' | 'purchase_order';

export const TERMS: Record<string, string> = { DUE_ON_RECEIPT: 'Due on receipt', NET_15: 'Net 15', NET_30: 'Net 30', NET_60: 'Net 60' };
const METHODS: Record<string, string> = { CASH: 'Cash', CHEQUE: 'Cheque', CREDIT_CARD: 'Credit card', DEBIT_CARD: 'Debit card', E_TRANSFER: 'Interac e-Transfer', OTHER: 'Other' };

/** Default e-mail wording per document; companies override it in Settings → Branding. */
export const DEFAULT_EMAILS: Record<EmailKind, { subject: string; body: string }> = {
  invoice: { subject: 'Invoice {{number}} from {{company}}', body: 'Dear {{customer}},\n\nPlease find invoice {{number}} for {{total}} attached. The balance of {{balance}} is due {{dueDate}}.\n\nView it online: {{link}}\n\nThank you for your business,\n{{company}}' },
  sales_receipt: { subject: 'Sales receipt {{number}} from {{company}}', body: 'Dear {{customer}},\n\nThank you for your payment of {{total}}. Your receipt {{number}} is attached.\n\n{{company}}' },
  estimate: { subject: 'Estimate {{number}} from {{company}}', body: 'Dear {{customer}},\n\nPlease find estimate {{number}} for {{total}} attached. Let us know if you would like to go ahead.\n\n{{company}}' },
  statement: { subject: 'Statement from {{company}}', body: 'Dear {{customer}},\n\nYour statement is attached. The amount due is {{balance}}.\n\n{{company}}' },
  reminder: { subject: 'Reminder: invoice {{number}} is overdue', body: 'Dear {{customer}},\n\nThis is a friendly reminder that invoice {{number}} was due {{dueDate}} and has a balance of {{balance}}.\n\nView it online: {{link}}\n\nIf you have already paid, please disregard this message.\n\n{{company}}' },
  purchase_order: { subject: 'Purchase order {{number}} from {{company}}', body: 'Hello {{customer}},\n\nPlease find our purchase order {{number}} attached.\n\n{{company}}' },
};

export type EmailVars = Partial<Record<'customer' | 'company' | 'number' | 'total' | 'balance' | 'dueDate' | 'link', string>>;

/** Replace {{placeholders}}; unknown ones are left as typed so a typo is visible rather than silently blank. */
export const fill = (t: string, v: EmailVars) => t.replace(/\{\{(\w+)\}\}/g, (m, k: keyof EmailVars) => (v[k] !== undefined ? v[k]! : m));

/** Plain-text body → simple, safe HTML (escaped, paragraphs, links clickable, accent-coloured header). */
export function emailHtml(text: string, o: { company: string; accent?: string; link?: string | null }) {
  const accent = /^#[0-9a-fA-F]{6}$/.test(o.accent ?? '') ? o.accent! : '#2f8a2b';
  const linkify = (s: string) => s.replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:${accent}">${u}</a>`);
  const paras = text.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${linkify(escapeHtml(p)).replace(/\n/g, '<br>')}</p>`).join('');
  const button = o.link ? `<p style="margin:22px 0"><a href="${escapeHtml(o.link)}" style="background:${accent};color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">View online</a></p>` : '';
  return `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2937"><div style="max-width:560px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb"><div style="background:${accent};color:#fff;padding:16px 24px;font-size:18px;font-weight:600">${escapeHtml(o.company)}</div><div style="padding:24px;font-size:15px;line-height:1.5">${paras}${button}</div></div></body></html>`;
}

/**
 * Customer- and supplier-facing documents: renders them as PDFs with the company's branding, and e-mails them.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branding: BrandingService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async companyHeader(companyId: string, date: Date) {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const regs = await this.prisma.taxRegistration.findMany({ where: { companyId, effectiveFrom: { lte: date }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }] } });
    const template = this.branding.template(company.template);
    const style: DocumentStyle = { accent: template.accent, layout: template.layout, showLogo: template.showLogo, showServiceDate: template.showServiceDate, showTaxColumn: template.showTaxColumn, footer: template.footer };
    return {
      company,
      template,
      style,
      logo: company.logo ? Buffer.from(company.logo) : null,
      header: {
        name: company.operatingName || company.legalName, legalName: company.legalName, address: company.address, phone: company.phone, email: company.email,
        registrations: regs.map((r) => `${r.kind === 'GST_HST' ? 'GST/HST' : r.kind === 'QST' ? 'QST' : 'PST'} registration no. ${r.registrationNumber}`),
      },
    };
  }

  /** The customer link for an invoice (view, download, pay). Created on first use. */
  async invoiceLink(companyId: string, invoiceId: string) {
    const inv = await this.prisma.invoice.findFirst({ where: { id: invoiceId, companyId }, select: { payToken: true } });
    if (!inv) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found' });
    let token = inv.payToken;
    if (!token) {
      token = randomToken(24);
      await this.prisma.invoice.update({ where: { id: invoiceId }, data: { payToken: token } });
    }
    return `${this.config.WEB_ORIGIN.replace(/\/$/, '')}/i/${token}`;
  }

  /** Load a document and build what the PDF and the e-mail need. */
  async load(companyId: string, type: DocType, id: string) {
    const lineInclude = { orderBy: { lineNo: 'asc' as const }, include: { taxCode: { select: { code: true } } } };
    const doc =
      type === 'invoice' ? await this.prisma.invoice.findFirst({ where: { id, companyId }, include: { lines: lineInclude, contact: true } })
      : type === 'sales_receipt' ? await this.prisma.salesReceipt.findFirst({ where: { id, companyId }, include: { lines: lineInclude, contact: true } })
      : type === 'estimate' ? await this.prisma.estimate.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } }, contact: true } })
      : await this.prisma.purchaseOrder.findFirst({ where: { id, companyId }, include: { lines: { orderBy: { lineNo: 'asc' } }, contact: true } });
    const label = { invoice: 'Invoice', sales_receipt: 'Sales receipt', estimate: 'Estimate', purchase_order: 'Purchase order' }[type];
    if (!doc) throw new NotFoundException({ code: 'NOT_FOUND', message: `${label} not found` });
    const date = 'issueDate' in doc ? doc.issueDate : doc.date;
    const h = await this.companyHeader(companyId, date);

    // Estimate and PO lines carry no taxCode relation; look the codes up once.
    const codeIds = [...new Set(doc.lines.map((l) => l.taxCodeId))];
    const codes = new Map((await this.prisma.taxCode.findMany({ where: { companyId, id: { in: codeIds } }, select: { id: true, code: true } })).map((c) => [c.id, c.code]));
    const itemIds = [...new Set(doc.lines.map((l) => l.itemId).filter((x): x is string => !!x))];
    const items = new Map((itemIds.length ? await this.prisma.item.findMany({ where: { companyId, id: { in: itemIds } }, select: { id: true, name: true } }) : []).map((i) => [i.id, i.name]));
    // Tax shown by component and rate (e.g. "HST 13%"), as Canadian invoices are expected to show it.
    const taxes = new Map<string, Decimal>();
    for (const l of doc.lines) for (const t of l.taxDetail as { component: string; rate: string; amount: string }[]) {
      const k = `${t.component} ${D(t.rate).times(100).toDecimalPlaces(3).toString()}%`;
      taxes.set(k, (taxes.get(k) ?? D(0)).plus(t.amount));
    }
    const status = 'status' in doc ? String(doc.status) : '';
    const number = doc.number ?? 'DRAFT';
    const base: Omit<SalesDocument, 'title' | 'details'> = {
      currency: doc.currency,
      watermark: status === 'DRAFT' ? 'DRAFT' : status === 'VOID' ? 'VOID' : undefined,
      company: h.header,
      logo: h.logo,
      style: h.style,
      number,
      billTo: { name: doc.contact.name, address: ('billingAddress' in doc ? doc.billingAddress : null) ?? doc.contact.billingAddress, email: doc.contact.email },
      lines: doc.lines.map((l) => {
        // Prices entered tax-included: lines show the pre-tax amount so subtotal + tax = total on the page.
        const qty = D(l.quantity);
        const amount = doc.taxInclusive ? D(l.net) : qty.times(l.unitPrice);
        const rate = doc.taxInclusive ? D(l.net).div(qty.isZero() ? 1 : qty) : D(l.unitPrice);
        return { serviceDate: 'serviceDate' in l && l.serviceDate ? isoOf(l.serviceDate) : null, product: l.itemId ? items.get(l.itemId) ?? null : null, description: l.description, quantity: qty.toString(), rate: rate.toFixed(2), amount: amount.toFixed(2), taxCode: codes.get(l.taxCodeId) ?? null };
      }),
      subtotal: D(doc.subtotal).toFixed(2),
      taxes: [...taxes].map(([k, amount]) => ({ label: k, amount: amount.toFixed(2) })),
      total: D(doc.total).toFixed(2),
      message: doc.message,
    };
    let pdf: SalesDocument;
    let balance = D(0);
    let dueDate: string | undefined;
    let link: string | undefined;
    let kind: EmailKind;
    if (type === 'invoice' && 'dueDate' in doc && 'kind' in doc) {
      const credit = doc.kind === 'CREDIT';
      balance = doc.status === 'VOID' ? D(0) : D(doc.total).minus(doc.amountPaid);
      dueDate = isoOf(doc.dueDate);
      if (!credit && doc.payToken) link = `${this.config.WEB_ORIGIN.replace(/\/$/, '')}/i/${doc.payToken}`;
      pdf = {
        ...base, title: credit ? 'CREDIT NOTE' : 'INVOICE',
        details: credit ? [['Date', isoOf(doc.issueDate)]] : [['Date', isoOf(doc.issueDate)], ['Due date', dueDate], ...(doc.terms ? [['Terms', TERMS[doc.terms] ?? doc.terms] as [string, string]] : [])],
        ...(credit ? {} : { paid: D(doc.amountPaid).toFixed(2), balanceDue: balance.toFixed(2), paymentInstructions: h.template.paymentInstructions ?? null, payUrl: link && balance.gt(0) ? link : null }),
      };
      kind = 'invoice';
    } else if (type === 'sales_receipt' && 'paymentMethod' in doc) {
      pdf = { ...base, title: 'SALES RECEIPT', details: [['Date', isoOf(doc.date)], ['Payment method', METHODS[doc.paymentMethod]], ...(doc.referenceNo ? [['Reference no.', doc.referenceNo] as [string, string]] : [])], paid: D(doc.total).toFixed(2) };
      kind = 'sales_receipt';
    } else if (type === 'estimate' && 'expiryDate' in doc) {
      pdf = { ...base, title: 'ESTIMATE', details: [['Date', isoOf(doc.issueDate)], ...(doc.expiryDate ? [['Expiry date', isoOf(doc.expiryDate)] as [string, string]] : [])] };
      kind = 'estimate';
    } else if ('expectedDate' in doc) {
      pdf = { ...base, title: 'PURCHASE ORDER', details: [['Date', isoOf(doc.issueDate)], ...(doc.expectedDate ? [['Expected', isoOf(doc.expectedDate)] as [string, string]] : [])], shipTo: { label: 'SHIP TO', text: doc.shipTo ?? [h.header.name, h.header.address].filter(Boolean).join('\n') } };
      kind = 'purchase_order';
    } else throw new Error('unreachable');
    const slug = { INVOICE: 'invoice', 'CREDIT NOTE': 'credit-note', 'SALES RECEIPT': 'sales-receipt', ESTIMATE: 'estimate', 'PURCHASE ORDER': 'purchase-order' }[pdf.title];
    const money = (v: Decimal.Value) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: doc.currency }).format(Number(v));
    return {
      doc, pdf, kind, status, h,
      filename: `${slug}-${number}.pdf`.replace(/[^\w.-]/g, '_'),
      contactEmail: doc.contact.email,
      vars: { customer: doc.contact.name, company: h.header.name, number, total: money(doc.total), balance: money(balance), dueDate: dueDate ?? '', link: link ?? '' } as EmailVars,
    };
  }

  async render(companyId: string, type: DocType, id: string) {
    const l = await this.load(companyId, type, id);
    return { filename: l.filename, pdf: await documentPdf(l.pdf) };
  }

  /** Wording for an e-mail: the company's template for this kind, or the default. */
  emailText(template: DocumentTemplate, kind: EmailKind, vars: EmailVars, override?: { subject?: string; body?: string }, opts: { keepLinkPlaceholder?: boolean } = {}) {
    const t = template.emails?.[kind] ?? DEFAULT_EMAILS[kind];
    const v = { ...vars, link: vars.link || undefined };
    const subject = fill(override?.subject || t.subject || DEFAULT_EMAILS[kind].subject, v);
    let body = fill(override?.body || t.body || DEFAULT_EMAILS[kind].body, v);
    // With no link to give (receipts, statements), the line that would carry it is dropped rather than printed with an empty URL.
    if (!opts.keepLinkPlaceholder) body = body.replace(/^.*\{\{link\}\}.*$\n?/gm, '').replace(/\n{3,}/g, '\n\n');
    return { subject, body };
  }

  /** E-mail a document with its PDF attached. Drafts and voided documents are not sent. */
  async send(companyId: string, type: DocType, id: string, i: { to: string[]; cc?: string[]; subject?: string; body?: string }, actorId: string, ip: string | null, opts: { kind?: EmailKind } = {}) {
    if (type === 'invoice') {
      const inv = await this.prisma.invoice.findFirst({ where: { id, companyId }, select: { status: true, kind: true } });
      if (inv && inv.kind === 'STANDARD' && inv.status !== 'DRAFT' && inv.status !== 'VOID') await this.invoiceLink(companyId, id);
    }
    const l = await this.load(companyId, type, id);
    if (l.status === 'DRAFT' || l.status === 'VOID') throw new ConflictException({ code: 'NOT_SENDABLE', message: l.status === 'DRAFT' ? 'Post the document before sending it' : 'A voided document cannot be sent' });
    const kind = opts.kind ?? l.kind;
    if (kind === 'reminder' && (type !== 'invoice' || D(l.pdf.balanceDue ?? '0').lte(0))) throw new ConflictException({ code: 'NOTHING_DUE', message: 'Only invoices with a balance can be reminded' });
    const { subject, body } = this.emailText(l.h.template, kind, l.vars, i);
    const pdf = await documentPdf(l.pdf);
    const row = await this.mail.send({
      companyId, kind, documentId: id, to: i.to, cc: i.cc, subject, text: body,
      html: emailHtml(body, { company: l.vars.company!, accent: l.h.template.accent, link: l.vars.link || null }),
      fromName: l.h.company.emailFromName || l.vars.company, replyTo: l.h.company.emailReplyTo || l.h.company.email,
      attachments: [{ filename: l.filename, content: pdf }], sentById: actorId,
    });
    const now = new Date();
    if (type === 'invoice') await this.prisma.invoice.update({ where: { id }, data: { lastSentAt: now } });
    else if (type === 'sales_receipt') await this.prisma.salesReceipt.update({ where: { id }, data: { lastSentAt: now } });
    else if (type === 'estimate') await this.prisma.estimate.update({ where: { id }, data: { lastSentAt: now } });
    else await this.prisma.purchaseOrder.update({ where: { id }, data: { lastSentAt: now } });
    await this.audit.record({ action: `${type}.sent`, companyId, actorId, entityType: type, entityId: id, metadata: { to: row.to, emailId: row.id } as Prisma.InputJsonObject, ip });
    return row;
  }

  /** What the Send dialog shows before sending: recipient, subject and body with placeholders filled in. */
  async preview(companyId: string, type: DocType, id: string) {
    const l = await this.load(companyId, type, id);
    // Before the first send an invoice has no customer link yet: the placeholder stays, and is filled in when it is sent.
    const text = this.emailText(l.h.template, l.kind, l.vars, undefined, { keepLinkPlaceholder: type === 'invoice' });
    return { to: l.contactEmail ? [l.contactEmail] : [], ...text, mailConfigured: this.mail.configured };
  }

  assertMail() {
    if (!this.mail.configured) throw new UnprocessableEntityException({ code: 'MAIL_NOT_CONFIGURED', message: 'E-mail is not set up on this server: set RESEND_API_KEY and MAIL_FROM' });
  }
}
