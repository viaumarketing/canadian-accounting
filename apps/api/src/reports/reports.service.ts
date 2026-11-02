import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { isoDate, uuid } from '@ca/shared';
import { col, row, toCsv, toPdf, toXlsx, type Report } from '@ca/reporting';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { ReconciliationService } from '../banking/reconciliation.service';
import { Ctx, fiscalYearBounds, newReport } from './common';
import { aging, expenseReport, forecast, revenueByChannel } from './operations';
import { balanceSheet, cashFlow, generalLedgerReport, journalReport, profitAndLoss, trialBalanceReport } from './financial';
import { filingPeriods, taxReport } from './tax';
import { shopifyFees, shopifyPayouts, shopifySales } from './shopify';

const today = () => new Date().toISOString().slice(0, 10);
const money = z.string().regex(/^-?\d{1,13}(\.\d{1,2})?$/);
const compare = z.enum(['none', 'prior_period', 'prior_year']).default('none');

export interface CatalogEntry { key: string; title: string; group: 'Financial statements' | 'Receivables & payables' | 'Sales & expenses' | 'Taxes' | 'Shopify' | 'Banking'; description: string; params: ('from' | 'to' | 'asOf' | 'compare' | 'accountId' | 'weeks' | 'reconciliationId')[] }
export const CATALOG: CatalogEntry[] = [
  { key: 'profit-loss', title: 'Profit and Loss', group: 'Financial statements', description: 'Revenue, expenses and net income for a period, with prior-period or prior-year comparison.', params: ['from', 'to', 'compare'] },
  { key: 'balance-sheet', title: 'Balance Sheet', group: 'Financial statements', description: 'Assets, liabilities and equity at a date, with prior-year comparison.', params: ['asOf', 'compare'] },
  { key: 'cash-flow', title: 'Statement of Cash Flows', group: 'Financial statements', description: 'Indirect method, reconciled to your bank-account balances.', params: ['from', 'to'] },
  { key: 'trial-balance', title: 'Trial Balance', group: 'Financial statements', description: 'Every account with a balance; debits equal credits.', params: ['asOf'] },
  { key: 'general-ledger', title: 'General Ledger', group: 'Financial statements', description: 'Account detail with running balance.', params: ['accountId', 'from', 'to'] },
  { key: 'journal', title: 'Journal Report', group: 'Financial statements', description: 'All posted entries in a date range.', params: ['from', 'to'] },
  { key: 'ar-aging', title: 'Accounts Receivable Aging', group: 'Receivables & payables', description: 'What customers owe, by age, tied to the A/R control account.', params: ['asOf'] },
  { key: 'ap-aging', title: 'Accounts Payable Aging', group: 'Receivables & payables', description: 'What you owe suppliers, by age, tied to the A/P control account.', params: ['asOf'] },
  { key: 'cash-forecast', title: 'Cash-Flow Forecast', group: 'Receivables & payables', description: 'Known invoices and bills by due date against current cash (no sales projection).', params: ['asOf', 'weeks'] },
  { key: 'expenses', title: 'Expense Report', group: 'Sales & expenses', description: 'Expenses by account and by supplier.', params: ['from', 'to'] },
  { key: 'revenue-by-channel', title: 'Revenue by Sales Channel', group: 'Sales & expenses', description: 'Shopify stores, direct invoices, bank deposits and manual entries.', params: ['from', 'to'] },
  { key: 'tax-gst-hst', title: 'GST/HST Report', group: 'Taxes', description: 'CRA return lines 101–109 from the ledger, supporting schedules and roll-forward.', params: ['from', 'to'] },
  { key: 'tax-qst', title: 'QST Report', group: 'Taxes', description: 'QST collected and recoverable, schedules and roll-forward.', params: ['from', 'to'] },
  { key: 'tax-pst', title: 'PST Report', group: 'Taxes', description: 'PST collected, schedules and roll-forward.', params: ['from', 'to'] },
  { key: 'shopify-sales', title: 'Shopify Sales Summary', group: 'Shopify', description: 'Orders, sales, shipping, tax and refunds per store.', params: ['from', 'to'] },
  { key: 'shopify-fees', title: 'Shopify Processing Fees', group: 'Shopify', description: 'Fees by month, tied to the fee journals.', params: ['from', 'to'] },
  { key: 'shopify-payouts', title: 'Shopify Payout Reconciliation', group: 'Shopify', description: 'Each payout with its components and tie-out.', params: ['from', 'to'] },
  { key: 'bank-reconciliation', title: 'Bank Reconciliation', group: 'Banking', description: 'A completed reconciliation: cleared and outstanding items.', params: ['reconciliationId'] },
];

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly recon: ReconciliationService) {}

  private async ctx(companyId: string): Promise<Ctx> {
    const co = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    return { prisma: this.prisma, companyId, companyName: co.operatingName ? `${co.legalName} (${co.operatingName})` : co.legalName, baseCurrency: co.baseCurrency };
  }

  /** Validates query params with defaults; unknown params are ignored; bad ones return a 400 naming the problem. */
  private parse<T extends z.ZodRawShape>(shape: T, q: Record<string, unknown>) {
    const r = z.object(shape).safeParse(q);
    if (!r.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Invalid report parameters', issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    return r.data;
  }

  async build(companyId: string, key: string, q: Record<string, unknown>): Promise<Report> {
    const c = await this.ctx(companyId);
    const defFrom = async (to: string) => (await fiscalYearBounds(c, isoDate.safeParse(to).success ? to : today())).start;
    const range = async () => { const to = this.parse({ to: isoDate.default(today()) }, { to: q.to ?? today() }).to; return this.parse({ from: isoDate, to: isoDate }, { from: q.from ?? (await defFrom(to)), to }); };
    const asOf = () => this.parse({ asOf: isoDate.default(today()) }, q).asOf;
    switch (key) {
      case 'profit-loss': { const r = await range(); return profitAndLoss(c, { ...r, compare: this.parse({ compare }, q).compare }); }
      case 'balance-sheet': return balanceSheet(c, { asOf: asOf(), compare: this.parse({ compare }, q).compare });
      case 'cash-flow': return cashFlow(c, await range());
      case 'trial-balance': return trialBalanceReport(c, { asOf: asOf() });
      case 'general-ledger': { const r = await range(); return generalLedgerReport(c, { ...r, accountId: this.parse({ accountId: uuid }, q).accountId, ...((q.format ?? 'json') === 'json' ? { page: this.parse({ page: z.coerce.number().int().min(1).default(1) }, q).page } : {}) }).catch((e) => { throw e.message === 'Account not found' ? new NotFoundException({ code: 'NOT_FOUND', message: 'Account not found' }) : e; }); }
      case 'journal': return journalReport(c, await range());
      case 'ar-aging': return aging(c, { kind: 'ar', asOf: asOf() });
      case 'ap-aging': return aging(c, { kind: 'ap', asOf: asOf() });
      case 'cash-forecast': return forecast(c, { asOf: asOf(), weeks: this.parse({ weeks: z.coerce.number().int().min(1).max(52).default(13) }, q).weeks });
      case 'expenses': return expenseReport(c, await range());
      case 'revenue-by-channel': return revenueByChannel(c, await range());
      case 'tax-gst-hst': case 'tax-qst': case 'tax-pst': {
        const r = await range();
        const inputs = this.parse({ adj104: money.optional(), adj107: money.optional(), instalments110: money.optional(), rebates111: money.optional(), selfAssess: money.optional(), itcCapital: money.optional(), qmOtherSales: money.optional(), qmOtherRate: z.string().regex(/^0(\.\d{1,4})?$/).optional() }, q);
        return taxReport(c, key.slice(4) as 'gst-hst', { ...r, ...inputs });
      }
      case 'shopify-sales': return shopifySales(c, await range());
      case 'shopify-fees': return shopifyFees(c, await range());
      case 'shopify-payouts': return shopifyPayouts(c, await range());
      case 'bank-reconciliation': {
        const d = await this.recon.report(companyId, this.parse({ reconciliationId: uuid }, q).reconciliationId);
        const r = newReport(c, key, `Bank Reconciliation: ${d.account.name}`, `Statement date ${d.reconciliation.statementDate.toISOString().slice(0, 10)} · ${d.reconciliation.status.toLowerCase()}`);
        r.sections.push({ title: 'Summary', columns: [col('name', 'Item'), col('amount', 'Amount', 'money')], rows: [row({ name: 'Opening balance', amount: d.summary.opening }), row({ name: 'Cleared transactions', amount: d.summary.cleared })], totals: [row({ name: 'Computed ending balance', amount: d.summary.computedEnding }, { bold: true }), row({ name: 'Statement ending balance', amount: d.summary.statementEnding }, { bold: true })] });
        r.sections.push({ title: 'Cleared transactions', columns: [col('date', 'Date', 'date'), col('desc', 'Description'), col('amount', 'Amount', 'money')], rows: d.cleared.map((t) => row({ date: t.date.toISOString().slice(0, 10), desc: t.description, amount: t.amount })) });
        r.sections.push({ title: 'Outstanding in the books at that date', columns: [col('date', 'Date', 'date'), col('memo', 'Memo'), col('amount', 'Amount', 'money')], rows: d.outstandingLedgerItems.map((t) => row({ date: t.date.toISOString().slice(0, 10), memo: t.memo, amount: t.amount })), totals: [row({ memo: 'Net outstanding', amount: d.outstandingNet }, { bold: true })] });
        r.checks.push({ label: 'Opening + cleared equals the statement balance', ok: d.summary.balanced, detail: d.summary.balanced ? undefined : `difference ${d.summary.difference}` });
        if (d.note) r.notes.push(d.note);
        return r;
      }
      default: throw new NotFoundException({ code: 'UNKNOWN_REPORT', message: `Unknown report "${key}"` });
    }
  }

  async render(report: Report, format: 'csv' | 'xlsx' | 'pdf'): Promise<{ body: Buffer | string; type: string; ext: string }> {
    if (format === 'csv') return { body: toCsv(report), type: 'text/csv; charset=utf-8', ext: 'csv' };
    if (format === 'xlsx') return { body: await toXlsx(report), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
    return { body: await toPdf(report), type: 'application/pdf', ext: 'pdf' };
  }

  taxPeriods(companyId: string, date: string) { return this.ctx(companyId).then((c) => filingPeriods(c, date)); }

  async audited(companyId: string, actorId: string, key: string, format: string, q: Record<string, unknown>, ip: string | null) {
    await this.audit.record({ action: 'report.exported', companyId, actorId, entityType: 'Report', entityId: key, metadata: { format, params: Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'format').map(([k, v]) => [k, String(v).slice(0, 60)])) }, ip });
  }
}
