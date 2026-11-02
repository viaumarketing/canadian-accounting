import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Prisma } from '@ca/database';
import { lateFeeSettingsSchema, recurringPayloads, reminderSettingsSchema, roleHasPermission, type CompanyRole, type Permission } from '@ca/shared';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { isoOf, toDate } from '../accounting/setup';
import { BillingService } from './billing.service';
import { DocumentsService, emailHtml } from '../documents/documents.service';
import { MailService } from '../mail/mail.service';

const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const DAY = 86_400_000;
/** At most this many missed runs are caught up per template per tick (a schedule paused for years does not flood). */
const MAX_CATCH_UP = 12;

export interface RecurringInput {
  name: string; kind: 'INVOICE' | 'BILL' | 'EXPENSE'; mode: 'DRAFT' | 'POST' | 'SEND'; interval: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'; every: number;
  startDate: string; endDate?: string; maxRuns?: number; daysDue: number; sendTo?: string[]; payload: Record<string, unknown>; isActive: boolean;
}

/** Next date of a schedule. Monthly and yearly keep the start date's day, clamped to the month's last day (Jan 31 → Feb 28 → Mar 31). */
export function advance(start: Date, interval: RecurringInput['interval'], every: number, n: number): Date {
  if (interval === 'DAILY') return new Date(start.getTime() + n * every * DAY);
  if (interval === 'WEEKLY') return new Date(start.getTime() + n * every * 7 * DAY);
  const months = interval === 'MONTHLY' ? n * every : n * every * 12;
  const y = start.getUTCFullYear(), m = start.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(start.getUTCDate(), last)));
}

/**
 * Work the worker does on a schedule: recurring transactions, overdue reminders and late fees. Each piece is idempotent:
 * a schedule's next date moves forward in the same transaction as the document it creates, a reminder stage is recorded
 * (unique per invoice) before it is sent, and a late fee is linked to its invoice by a unique column.
 */
@Injectable()
export class AutomationService {
  private readonly log = new Logger('Automation');
  constructor(private readonly prisma: PrismaService, private readonly billing: BillingService, private readonly documents: DocumentsService, private readonly mail: MailService, private readonly audit: AuditService) {}

  // ================================================================ recurring templates

  private validate(i: RecurringInput) {
    const schema = recurringPayloads[i.kind];
    const r = schema.safeParse(i.payload);
    if (!r.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: `The ${i.kind.toLowerCase()} details are not valid`, issues: r.error.issues.map((x) => ({ path: x.path.join('.'), message: x.message })) });
    if (i.mode === 'SEND' && i.kind !== 'INVOICE') throw new BadRequestException({ code: 'INVALID_MODE', message: 'Only invoices can be sent automatically' });
    if (i.endDate && i.endDate < i.startDate) throw new BadRequestException({ code: 'INVALID_RANGE', message: 'The end date is before the start date' });
    return r.data as Record<string, unknown>;
  }

  /** What each kind needs to be created and, when the mode says so, posted. */
  private needs(kind: RecurringInput['kind'], mode: RecurringInput['mode']): Permission[] {
    const r = kind === 'INVOICE' ? 'sales' : kind === 'BILL' ? 'purchases' : 'expenses';
    return [`${r}:create` as Permission, ...(mode !== 'DRAFT' && kind !== 'EXPENSE' ? [`${r}:post` as Permission] : [])];
  }

  async saveTemplate(companyId: string, id: string | null, i: RecurringInput, actorId: string, role: CompanyRole, ip: string | null) {
    for (const p of this.needs(i.kind, i.mode)) if (!roleHasPermission(role, p)) throw new ForbiddenException({ code: 'FORBIDDEN', message: `Missing permission ${p} for this schedule` });
    const payload = this.validate(i);
    const data = { name: i.name, kind: i.kind, mode: i.mode, interval: i.interval, every: i.every, startDate: toDate(i.startDate), endDate: i.endDate ? toDate(i.endDate) : null, maxRuns: i.maxRuns ?? null, daysDue: i.daysDue, isActive: i.isActive, payload: { ...payload, ...(i.sendTo ? { sendTo: i.sendTo } : {}) } as Prisma.InputJsonObject };
    if (!id) {
      const t = await this.prisma.recurringTemplate.create({ data: { ...data, companyId, nextDate: toDate(i.startDate), createdById: actorId } });
      await this.audit.record({ action: 'recurring.created', companyId, actorId, entityType: 'RecurringTemplate', entityId: t.id, ip });
      return t;
    }
    const cur = await this.prisma.recurringTemplate.findFirst({ where: { id, companyId } });
    if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recurring template not found' });
    // Changing the start date restarts the schedule from it; otherwise the schedule continues where it is.
    const restart = isoOf(cur.startDate) !== i.startDate || cur.interval !== i.interval || cur.every !== i.every;
    const t = await this.prisma.recurringTemplate.update({ where: { id }, data: { ...data, ...(restart ? { nextDate: toDate(i.startDate), runCount: 0 } : {}), createdById: actorId, lastError: null } });
    await this.audit.record({ action: 'recurring.updated', companyId, actorId, entityType: 'RecurringTemplate', entityId: id, ip });
    return t;
  }

  listTemplates(companyId: string) {
    return this.prisma.recurringTemplate.findMany({ where: { companyId }, orderBy: [{ isActive: 'desc' }, { nextDate: 'asc' }] });
  }

  async deleteTemplate(companyId: string, id: string, actorId: string, ip: string | null) {
    const n = await this.prisma.recurringTemplate.deleteMany({ where: { id, companyId } });
    if (!n.count) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recurring template not found' });
    await this.audit.record({ action: 'recurring.deleted', companyId, actorId, entityType: 'RecurringTemplate', entityId: id, ip });
  }

  /** Run every schedule that is due on or before `today`. */
  async runRecurring(today = isoOf(new Date())) {
    const due = await this.prisma.recurringTemplate.findMany({ where: { isActive: true, nextDate: { lte: toDate(today) } }, select: { id: true } });
    let created = 0;
    for (const t of due) created += await this.runTemplate(t.id, today).catch((e) => { this.log.error(`recurring ${t.id}: ${(e as Error).message}`); return 0; });
    return { templates: due.length, created };
  }

  /** Create the documents this template owes up to `today`. Returns how many it created. */
  async runTemplate(id: string, today = isoOf(new Date()), opts: { once?: boolean } = {}): Promise<number> {
    let created = 0;
    for (let n = 0; n < (opts.once ? 1 : MAX_CATCH_UP); n++) {
      const t = await this.prisma.recurringTemplate.findUnique({ where: { id } });
      if (!t || !t.isActive || !t.nextDate || (!opts.once && isoOf(t.nextDate) > today)) break;
      const date = isoOf(t.nextDate);
      const finished = (t.endDate && date > isoOf(t.endDate)) || (t.maxRuns !== null && t.runCount >= t.maxRuns);
      if (finished) { await this.prisma.recurringTemplate.update({ where: { id }, data: { isActive: false, nextDate: null } }); break; }

      // The person who saved the schedule must still be allowed to do what it does; otherwise it stops with a clear error.
      const m = await this.prisma.companyMembership.findFirst({ where: { companyId: t.companyId, userId: t.createdById, status: 'ACTIVE' } });
      const missing = !m ? 'the person who set it up is no longer a member' : this.needs(t.kind as RecurringInput['kind'], t.mode as RecurringInput['mode']).find((p) => !roleHasPermission(m.role as CompanyRole, p));
      if (missing) { await this.prisma.recurringTemplate.update({ where: { id }, data: { lastError: `Paused: ${typeof missing === 'string' && missing.includes(':') ? `missing permission ${missing}` : missing}. Save the schedule again to resume.`, isActive: false } }); break; }

      let docId: string;
      const payload = t.payload as Record<string, unknown>;
      const due = isoOf(new Date(toDate(date).getTime() + t.daysDue * DAY));
      try {
        docId = await this.prisma.$transaction(async (tx) => {
          // Move the schedule first, under a row lock, so two workers can never create the same run twice.
          const locked = await tx.$queryRaw<{ nextDate: Date | null }[]>`SELECT "nextDate" FROM "RecurringTemplate" WHERE id = ${id}::uuid FOR UPDATE`;
          if (!locked[0]?.nextDate || isoOf(locked[0].nextDate) !== date) throw new Error('RACE');
          const next = advance(t.startDate, t.interval as RecurringInput['interval'], t.every, t.runCount + 1);
          await tx.recurringTemplate.update({ where: { id }, data: { nextDate: next, runCount: { increment: 1 }, lastRunAt: new Date(), lastError: null } });
          // Re-validated at every run: a template saved by an older version, or edited by hand, cannot post bad data.
          const { sendTo: _s, ...doc } = payload;
          if (t.kind === 'INVOICE') {
            const inv = await this.billing.createInvoice(t.companyId, { ...recurringPayloads.INVOICE.parse(doc), issueDate: date, dueDate: due }, t.createdById, null, { recurringId: id }, tx);
            if (t.mode !== 'DRAFT') await this.billing.postInvoice(t.companyId, inv.id, t.createdById, null, tx);
            return inv.id;
          }
          if (t.kind === 'BILL') {
            const b = await this.billing.createBill(t.companyId, { ...recurringPayloads.BILL.parse(doc), issueDate: date, dueDate: due }, t.createdById, null, { recurringId: id }, tx);
            if (t.mode !== 'DRAFT') await this.billing.postBill(t.companyId, b.id, t.createdById, null, tx);
            return b.id;
          }
          // Expenses are created as submitted: someone else still approves them (separation of duties).
          return (await this.billing.createExpense(t.companyId, { ...recurringPayloads.EXPENSE.parse(doc), date }, t.createdById, null, { recurringId: id }, tx)).id;
        }, { timeout: 30_000 });
      } catch (e) {
        if ((e as Error).message === 'RACE') break;
        const msg = (e as { getResponse?: () => { message?: string } }).getResponse?.().message ?? (e as Error).message;
        await this.prisma.recurringTemplate.update({ where: { id }, data: { lastError: `${date}: ${msg}`.slice(0, 500) } });
        break;
      }
      created++;
      if (t.kind === 'INVOICE' && t.mode === 'SEND') {
        try {
          const contact = await this.prisma.contact.findUnique({ where: { id: String(payload.contactId) } });
          const to = (payload.sendTo as string[] | undefined)?.length ? (payload.sendTo as string[]) : contact?.email ? [contact.email] : [];
          if (!to.length) throw new Error('the customer has no e-mail address');
          await this.documents.send(t.companyId, 'invoice', docId, { to }, t.createdById, null);
        } catch (e) {
          const msg = (e as { getResponse?: () => { message?: string } }).getResponse?.().message ?? (e as Error).message;
          await this.prisma.recurringTemplate.update({ where: { id }, data: { lastError: `${date}: invoice created and posted but not sent: ${msg}`.slice(0, 500) } });
        }
      }
    }
    return created;
  }

  // ================================================================ reminders and late fees

  async getSettings(companyId: string) {
    const c = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { reminderSettings: true, lateFeeSettings: true } });
    const r = reminderSettingsSchema.safeParse(c.reminderSettings);
    const l = lateFeeSettingsSchema.safeParse(c.lateFeeSettings);
    return { reminders: r.success ? r.data : { enabled: false, stages: [1, 7, 30] }, lateFees: l.success ? l.data : null, mailConfigured: this.mail.configured };
  }

  async saveSettings(companyId: string, i: { reminders?: Prisma.InputJsonObject; lateFees?: Prisma.InputJsonObject | null }, actorId: string, ip: string | null) {
    if (i.lateFees) {
      const l = lateFeeSettingsSchema.parse(i.lateFees);
      await this.billing.checkAccounts(this.prisma, companyId, [l.accountId], ['REVENUE']);
      if (!(await this.prisma.taxCode.findFirst({ where: { id: l.taxCodeId, companyId } }))) throw new BadRequestException({ code: 'INVALID_TAX_CODE', message: 'Unknown tax code' });
    }
    await this.prisma.company.update({ where: { id: companyId }, data: { ...(i.reminders ? { reminderSettings: i.reminders } : {}), ...(i.lateFees !== undefined ? { lateFeeSettings: i.lateFees ?? {} } : {}) } });
    await this.audit.record({ action: 'company.collections_settings_updated', companyId, actorId, entityType: 'Company', entityId: companyId, ip });
    return this.getSettings(companyId);
  }

  /** Open overdue invoices of a company (balance > 0, due before today). */
  private overdue(companyId: string, today: Date) {
    return this.prisma.invoice.findMany({ where: { companyId, kind: 'STANDARD', status: { in: ['POSTED', 'PARTIAL'] }, dueDate: { lt: today } }, include: { contact: true } });
  }

  /** Send the highest reminder stage each overdue invoice has reached and not yet had. */
  async runReminders(today = isoOf(new Date())) {
    if (!this.mail.configured) return { sent: 0, skipped: 'mail not configured' };
    const day = toDate(today);
    let sent = 0;
    const companies = await this.prisma.company.findMany({ where: { isActive: true }, select: { id: true, reminderSettings: true } });
    for (const c of companies) {
      const s = reminderSettingsSchema.safeParse(c.reminderSettings);
      if (!s.success || !s.data.enabled || !s.data.stages.length) continue;
      const stages = [...s.data.stages].sort((a, b) => b - a);
      for (const inv of await this.overdue(c.id, day)) {
        if (!inv.contact.email || D(inv.total).minus(inv.amountPaid).lte(0)) continue;
        const days = Math.round((day.getTime() - inv.dueDate.getTime()) / DAY);
        const stage = stages.find((x) => days >= x);
        if (stage === undefined) continue;
        if (await this.prisma.invoiceReminder.findFirst({ where: { invoiceId: inv.id, stage: { gte: stage } } })) continue;
        let reminder;
        try { reminder = await this.prisma.invoiceReminder.create({ data: { companyId: c.id, invoiceId: inv.id, stage } }); } catch { continue; } // another worker got it
        try {
          await this.documents.invoiceLink(c.id, inv.id);
          const l = await this.documents.load(c.id, 'invoice', inv.id);
          const text = this.documents.emailText(l.h.template, 'reminder', l.vars, { subject: s.data.subject, body: s.data.body });
          const { documentPdf } = await import('@ca/reporting');
          const row = await this.mail.send({ companyId: c.id, kind: 'reminder', documentId: inv.id, to: [inv.contact.email], subject: text.subject, text: text.body, html: emailHtml(text.body, { company: l.vars.company!, accent: l.h.template.accent, link: l.vars.link || null }), fromName: l.h.company.emailFromName || l.vars.company, replyTo: l.h.company.emailReplyTo || l.h.company.email, attachments: [{ filename: l.filename, content: await documentPdf(l.pdf) }], idempotencyKey: `reminder-${inv.id}-${stage}` });
          await this.prisma.invoiceReminder.update({ where: { id: reminder.id }, data: { emailId: row.id } });
          sent++;
        } catch (e) {
          // Not sent: forget the stage so the next run tries again (the failure is in the e-mail log).
          await this.prisma.invoiceReminder.delete({ where: { id: reminder.id } }).catch(() => undefined);
          this.log.warn(`reminder ${inv.id}: ${(e as Error).message}`);
        }
      }
    }
    return { sent };
  }

  /** Charge the late fee once per invoice whose balance is still open `graceDays` after the due date. */
  async runLateFees(today = isoOf(new Date())) {
    const day = toDate(today);
    let charged = 0;
    const companies = await this.prisma.company.findMany({ where: { isActive: true }, select: { id: true, lateFeeSettings: true } });
    for (const c of companies) {
      const s = lateFeeSettingsSchema.safeParse(c.lateFeeSettings);
      if (!s.success || !s.data.enabled) continue;
      // Fees are posted on behalf of the company's owner (the audit log marks them automatic).
      const owner = await this.prisma.companyMembership.findFirst({ where: { companyId: c.id, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } }, orderBy: { role: 'asc' } });
      if (!owner) continue;
      for (const inv of await this.overdue(c.id, new Date(day.getTime() - s.data.graceDays * DAY))) {
        if (inv.lateFeeForId) continue; // no fee on a fee
        const balance = D(inv.total).minus(inv.amountPaid);
        if (balance.lte(0) || (await this.prisma.invoice.findUnique({ where: { lateFeeForId: inv.id } }))) continue;
        const amount = s.data.type === 'FLAT' ? D(s.data.amount) : balance.times(s.data.amount).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        if (amount.lte(0)) continue;
        try {
          await this.prisma.$transaction(async (tx) => {
            const fee = await this.billing.createInvoice(c.id, { contactId: inv.contactId, issueDate: today, dueDate: today, terms: 'DUE_ON_RECEIPT', taxInclusive: false, kind: 'STANDARD', memo: `Late fee on ${inv.number}`, lines: [{ description: `Late fee on invoice ${inv.number} (balance ${balance.toFixed(2)} overdue since ${isoOf(inv.dueDate)})`, quantity: '1', unitPrice: amount.toFixed(2), accountId: s.data.accountId, taxCodeId: s.data.taxCodeId }] }, owner.userId, null, { lateFeeForId: inv.id }, tx);
            await this.billing.postInvoice(c.id, fee.id, owner.userId, null, tx);
            await this.audit.record({ action: 'invoice.late_fee', companyId: c.id, actorId: owner.userId, entityType: 'Invoice', entityId: fee.id, metadata: { automatic: true, forInvoice: inv.number, amount: amount.toFixed(2) } }, tx);
          });
          charged++;
        } catch (e) {
          this.log.warn(`late fee ${inv.id}: ${(e as Error).message}`);
        }
      }
    }
    return { charged };
  }

  /** The worker's hourly job. */
  async runAll(today = isoOf(new Date())) {
    const recurring = await this.runRecurring(today);
    const lateFees = await this.runLateFees(today);
    const reminders = await this.runReminders(today);
    return { recurring, lateFees, reminders };
  }
}
