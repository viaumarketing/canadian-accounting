import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { statementPdf, type StatementDocument } from '@ca/reporting';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { isoOf, toDate } from '../accounting/setup';
import { DocumentsService, emailHtml } from '../documents/documents.service';
import { MailService } from '../mail/mail.service';

const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const DAY = 86_400_000;

export interface StatementQuery { contactId: string; from: string; to: string; type: 'balance_forward' | 'open_item' }

/**
 * Customer statements, built from the documents that make up A/R: invoices (+), credit notes (−) and customer payments (−).
 * Voided documents are left out entirely (their reversal cancels them). Credits applied to invoices move no money and change
 * neither the balance-forward running balance nor the total; on an open-item statement they reduce the invoice's open amount.
 */
@Injectable()
export class StatementsService {
  constructor(private readonly prisma: PrismaService, private readonly documents: DocumentsService, private readonly mail: MailService, private readonly audit: AuditService) {}

  async build(companyId: string, q: StatementQuery) {
    if (q.to < q.from) throw new BadRequestException({ code: 'INVALID_RANGE', message: 'The end date is before the start date' });
    const contact = await this.prisma.contact.findFirst({ where: { id: q.contactId, companyId } });
    if (!contact || contact.kind === 'VENDOR') throw new NotFoundException({ code: 'NOT_FOUND', message: 'Customer not found' });
    const from = toDate(q.from), to = toDate(q.to);
    const live = { not: 'DRAFT' as const };
    const [invoices, payments, applications] = await Promise.all([
      this.prisma.invoice.findMany({ where: { companyId, contactId: contact.id, status: live, NOT: { status: 'VOID' }, issueDate: { lte: to } }, orderBy: [{ issueDate: 'asc' }, { number: 'asc' }] }),
      this.prisma.payment.findMany({ where: { companyId, contactId: contact.id, direction: 'RECEIPT', voidedAt: null, date: { lte: to } }, include: { allocations: true }, orderBy: { date: 'asc' } }),
      this.prisma.creditApplication.findMany({ where: { companyId, voidedAt: null, date: { lte: to }, invoice: { contactId: contact.id } } }),
    ]);

    // Open amount of each invoice / credit note at the end date.
    const open = new Map<string, Decimal>(invoices.map((i) => [i.id, D(i.total)]));
    for (const p of payments) for (const a of p.allocations) if (a.invoiceId && open.has(a.invoiceId)) open.set(a.invoiceId, open.get(a.invoiceId)!.minus(a.amount));
    for (const a of applications) {
      if (a.invoiceId && open.has(a.invoiceId)) open.set(a.invoiceId, open.get(a.invoiceId)!.minus(a.amount));
      if (a.creditInvoiceId && open.has(a.creditInvoiceId)) open.set(a.creditInvoiceId, open.get(a.creditInvoiceId)!.minus(a.amount));
    }

    const aging = { current: D(0), d1_30: D(0), d31_60: D(0), d61_90: D(0), over90: D(0) };
    for (const i of invoices) {
      const amt = open.get(i.id)!;
      if (amt.isZero()) continue;
      const signed = i.kind === 'CREDIT' ? amt.neg() : amt;
      const days = i.kind === 'CREDIT' ? 0 : Math.round((to.getTime() - i.dueDate.getTime()) / DAY);
      const k = days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'over90';
      aging[k] = aging[k].plus(signed);
    }

    type Row = StatementDocument['rows'][number] & { id: string; kind: 'invoice' | 'credit_note' | 'payment' };
    let rows: Row[] = [];
    let opening: Decimal | undefined;
    let closing: Decimal;
    if (q.type === 'balance_forward') {
      opening = D(0);
      const events: { date: Date; id: string; kind: Row['kind']; type: string; number: string; dueDate: string | null; amount: Decimal }[] = [
        ...invoices.map((i) => ({ date: i.issueDate, id: i.id, kind: (i.kind === 'CREDIT' ? 'credit_note' : 'invoice') as Row['kind'], type: i.kind === 'CREDIT' ? 'Credit note' : 'Invoice', number: i.number ?? '', dueDate: i.kind === 'CREDIT' ? null : isoOf(i.dueDate), amount: i.kind === 'CREDIT' ? D(i.total).neg() : D(i.total) })),
        ...payments.map((p) => ({ date: p.date, id: p.id, kind: 'payment' as const, type: 'Payment', number: p.reference ?? '', dueDate: null, amount: D(p.amount).neg() })),
      ].sort((a, b) => a.date.getTime() - b.date.getTime() || (a.kind === 'payment' ? 1 : 0) - (b.kind === 'payment' ? 1 : 0));
      let bal = D(0);
      for (const e of events) {
        if (e.date < from) { opening = opening.plus(e.amount); bal = opening; continue; }
        bal = bal.plus(e.amount);
        rows.push({ id: e.id, kind: e.kind, date: isoOf(e.date), type: e.type, number: e.number, dueDate: e.dueDate, amount: e.amount.toFixed(2), balance: bal.toFixed(2) });
      }
      closing = bal;
    } else {
      let bal = D(0);
      rows = invoices.filter((i) => !open.get(i.id)!.isZero()).map((i) => {
        const amt = i.kind === 'CREDIT' ? open.get(i.id)!.neg() : open.get(i.id)!;
        bal = bal.plus(amt);
        return { id: i.id, kind: (i.kind === 'CREDIT' ? 'credit_note' : 'invoice') as Row['kind'], date: isoOf(i.issueDate), type: i.kind === 'CREDIT' ? 'Credit note' : 'Invoice', number: i.number ?? '', dueDate: i.kind === 'CREDIT' ? null : isoOf(i.dueDate), amount: (i.kind === 'CREDIT' ? D(i.total).neg() : D(i.total)).toFixed(2), balance: amt.toFixed(2) };
      });
      // Payments not (fully) allocated to an invoice would also be open credit; this app always allocates payments in full.
      closing = bal;
    }
    const agingTotal = Object.values(aging).reduce((a, v) => a.plus(v), D(0));
    return {
      contact: { id: contact.id, name: contact.name, email: contact.email, billingAddress: contact.billingAddress },
      type: q.type, from: q.from, to: q.to,
      opening: opening?.toFixed(2), rows, closing: closing.toFixed(2),
      aging: Object.fromEntries(Object.entries(aging).map(([k, v]) => [k, v.toFixed(2)])) as StatementDocument['aging'],
      /** The aging buckets always add up to the open balance at the end date */
      agingTotal: agingTotal.toFixed(2),
    };
  }

  async pdf(companyId: string, q: StatementQuery) {
    const s = await this.build(companyId, q);
    const h = await this.documents.companyHeader(companyId, toDate(q.to));
    const pdf = await statementPdf({ currency: h.company.baseCurrency, company: h.header, logo: h.logo, style: h.style, type: s.type, from: s.from, to: s.to, customer: { name: s.contact.name, address: s.contact.billingAddress, email: s.contact.email }, opening: s.opening, rows: s.rows, closing: s.closing, aging: s.aging });
    return { statement: s, header: h, pdf, filename: `statement-${s.contact.name}-${q.to}.pdf`.replace(/[^\w.-]/g, '_') };
  }

  async send(companyId: string, q: StatementQuery & { recipients?: string[]; subject?: string; body?: string }, actorId: string, ip: string | null) {
    const { statement: s, header: h, pdf, filename } = await this.pdf(companyId, q);
    const recipients = q.recipients?.length ? q.recipients : s.contact.email ? [s.contact.email] : [];
    if (!recipients.length) throw new BadRequestException({ code: 'NO_EMAIL', message: `${s.contact.name} has no e-mail address; enter one` });
    const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: h.company.baseCurrency }).format(Number(s.closing));
    const vars = { customer: s.contact.name, company: h.header.name, balance: money, total: money, number: '', dueDate: '', link: '' };
    const text = this.documents.emailText(h.template, 'statement', vars, { subject: q.subject, body: q.body });
    const row = await this.mail.send({ companyId, kind: 'statement', documentId: s.contact.id, to: recipients, subject: text.subject, text: text.body, html: emailHtml(text.body, { company: h.header.name, accent: h.template.accent }), fromName: h.company.emailFromName || h.header.name, replyTo: h.company.emailReplyTo || h.company.email, attachments: [{ filename, content: pdf }], sentById: actorId });
    await this.audit.record({ action: 'statement.sent', companyId, actorId, entityType: 'Contact', entityId: s.contact.id, metadata: { to: row.to, through: q.to, type: q.type }, ip });
    return row;
  }
}
