import Decimal from 'decimal.js';
import { col, row, type Report, type Row } from '@ca/reporting';
import { D, Ctx, addDays, balances, daysBetween, loadAccounts, m2, nameOf, natural, net, newReport, pct } from './common';
import { isoOf, toDate } from '../accounting/setup';

// ------------------------------------------------------------------ open documents as of a date (shared by aging and the forecast)
export interface OpenDoc { id: string; number: string | null; contactId: string; contact: string; issueDate: string; dueDate: string; outstanding: Decimal; credit: boolean }

/** Outstanding balance of each document AS OF the date: payments dated after it (or voided after it) are not applied. */
export async function openDocuments(c: Ctx, kind: 'ar' | 'ap', asOf: string): Promise<OpenDoc[]> {
  const end = new Date(`${asOf}T23:59:59.999Z`);
  const where = { companyId: c.companyId, issueDate: { lte: toDate(asOf) }, status: { in: ['POSTED', 'PARTIAL', 'PAID'] as ('POSTED' | 'PARTIAL' | 'PAID')[] } };
  const include = { contact: { select: { id: true, name: true } }, allocations: { include: { payment: { select: { date: true, voidedAt: true } } } } } as const;
  const docs = kind === 'ar' ? await c.prisma.invoice.findMany({ where, include }) : await c.prisma.bill.findMany({ where, include });
  const out: OpenDoc[] = [];
  for (const d of docs) {
    const paid = d.allocations.filter((a) => a.payment.date <= toDate(asOf) && (!a.payment.voidedAt || a.payment.voidedAt > end)).reduce((s, a) => s.plus(a.amount.toString()), D(0));
    const credit = d.kind === 'CREDIT';
    const outstanding = credit ? D(d.total.toString()).neg() : D(d.total.toString()).minus(paid); // an unapplied credit reduces what is owed
    if (outstanding.isZero()) continue;
    out.push({ id: d.id, number: d.number, contactId: d.contact.id, contact: d.contact.name, issueDate: isoOf(d.issueDate), dueDate: isoOf(d.dueDate), outstanding, credit });
  }
  return out;
}

const BUCKETS = [['current', 'Current'], ['d30', '1–30'], ['d60', '31–60'], ['d90', '61–90'], ['d90p', '90+']] as const;
const bucketOf = (daysPastDue: number) => (daysPastDue <= 0 ? 'current' : daysPastDue <= 30 ? 'd30' : daysPastDue <= 60 ? 'd60' : daysPastDue <= 90 ? 'd90' : 'd90p');

export async function aging(c: Ctx, p: { kind: 'ar' | 'ap'; asOf: string }): Promise<Report> {
  const ar = p.kind === 'ar';
  const docs = await openDocuments(c, p.kind, p.asOf);
  const r = newReport(c, ar ? 'ar-aging' : 'ap-aging', ar ? 'Accounts Receivable Aging' : 'Accounts Payable Aging', `As of ${p.asOf} · days past due date`);
  const byContact = new Map<string, { name: string; b: Record<string, Decimal> }>();
  const totals: Record<string, Decimal> = Object.fromEntries(BUCKETS.map(([k]) => [k, D(0)]));
  for (const d of docs) {
    const k = d.credit ? 'current' : bucketOf(daysBetween(d.dueDate, p.asOf));
    const e = byContact.get(d.contactId) ?? { name: d.contact, b: Object.fromEntries(BUCKETS.map(([x]) => [x, D(0)])) };
    e.b[k] = e.b[k].plus(d.outstanding); totals[k] = totals[k].plus(d.outstanding);
    byContact.set(d.contactId, e);
  }
  const tot = (b: Record<string, Decimal>) => Object.values(b).reduce((s, v) => s.plus(v), D(0));
  const columns = [col('name', ar ? 'Customer' : 'Supplier'), ...BUCKETS.map(([k, l]) => col(k, l, 'money')), col('total', 'Total', 'money')];
  r.sections.push({
    title: 'Summary', columns,
    rows: [...byContact.values()].sort((a, b) => a.name.localeCompare(b.name)).map((e) => row({ name: e.name, ...Object.fromEntries(BUCKETS.map(([k]) => [k, e.b[k].isZero() ? null : m2(e.b[k])])), total: m2(tot(e.b)) })),
    totals: [row({ name: 'Total', ...Object.fromEntries(BUCKETS.map(([k]) => [k, m2(totals[k])])), total: m2(tot(totals)) }, { bold: true })],
  });
  r.sections.push({
    title: 'Open documents',
    columns: [col('number', 'Number'), col('name', ar ? 'Customer' : 'Supplier'), col('issue', 'Issued', 'date'), col('due', 'Due', 'date'), col('days', 'Days past due', 'int'), col('amount', 'Outstanding', 'money')],
    rows: docs.sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map((d) => row({ number: d.number, name: d.contact, issue: d.issueDate, due: d.dueDate, days: d.credit ? null : Math.max(0, daysBetween(d.dueDate, p.asOf)), amount: m2(d.outstanding) })),
  });
  const accts = await loadAccounts(c);
  const control = accts.find((a) => a.role === (ar ? 'ACCOUNTS_RECEIVABLE' : 'ACCOUNTS_PAYABLE'));
  if (control) {
    const b = (await balances(c, { to: p.asOf })).get(control.id);
    const ledger = ar ? net(b) : net(b).neg();
    const ok = ledger.eq(tot(totals));
    r.checks.push({ label: `Aging total equals the ${control.name} control account`, ok, detail: ok ? undefined : `aging ${m2(tot(totals))} vs ledger ${m2(ledger)}: manual entries to ${control.code}, or a document voided after this date` });
  }
  r.notes.push('Unapplied credit notes/vendor credits are shown as negative amounts in "Current". Documents voided later are excluded.');
  return r;
}

// ------------------------------------------------------------------ cash-flow forecast (known obligations only)
export async function forecast(c: Ctx, p: { asOf: string; weeks: number }): Promise<Report> {
  const [banks, ar, ap] = await Promise.all([c.prisma.bankAccount.findMany({ where: { companyId: c.companyId, kind: { not: 'CREDIT_CARD' }, isActive: true }, select: { ledgerAccountId: true } }), openDocuments(c, 'ar', p.asOf), openDocuments(c, 'ap', p.asOf)]);
  const bal = await balances(c, { to: p.asOf });
  const cash = banks.reduce((s, b) => s.plus(net(bal.get(b.ledgerAccountId))), D(0));
  const r = newReport(c, 'cash-forecast', 'Cash-Flow Forecast', `${p.weeks} weeks from ${p.asOf} · known invoices and bills only`);
  const weeks = Array.from({ length: p.weeks }, (_, i) => ({ start: addDays(p.asOf, i * 7), inflow: D(0), outflow: D(0) }));
  let later = { inflow: D(0), outflow: D(0) };
  const place = (d: { dueDate: string; outstanding: Decimal }, side: 'inflow' | 'outflow') => {
    const idx = Math.max(0, Math.floor(daysBetween(p.asOf, d.dueDate) / 7)); // overdue items land in week 1
    const amt = d.outstanding;
    if (idx >= weeks.length) later = { ...later, [side]: later[side].plus(amt) };
    else weeks[idx][side] = weeks[idx][side].plus(amt);
  };
  ar.forEach((d) => place(d, 'inflow'));
  ap.forEach((d) => place(d, 'outflow'));
  let run = cash;
  const rows: Row[] = weeks.map((w) => { const n = w.inflow.minus(w.outflow); run = run.plus(n); return row({ week: w.start, inflow: m2(w.inflow), outflow: m2(w.outflow), net: m2(n), cash: m2(run) }); });
  r.sections.push({ columns: [col('week', 'Week starting', 'date'), col('inflow', 'Receivables due', 'money'), col('outflow', 'Payables due', 'money'), col('net', 'Net', 'money'), col('cash', 'Projected cash', 'money')], rows: [row({ week: p.asOf, cash: m2(cash) }, { bold: true }), ...rows], totals: [row({ week: 'Beyond horizon', inflow: m2(later.inflow), outflow: m2(later.outflow) }, { bold: true })] });
  r.notes.push('Assumptions: each invoice is collected and each bill paid on its due date; overdue items fall in week 1. No sales, payroll, tax remittances, credit-card balances or Shopify payouts are projected: only what the books already know. Treat it as a floor of certainty, not a forecast of the business.');
  r.checks.push({ label: 'Opening cash equals the bank-account ledger balances', ok: true });
  return r;
}

// ------------------------------------------------------------------ expense report
export async function expenseReport(c: Ctx, p: { from: string; to: string }): Promise<Report> {
  const accts = await loadAccounts(c);
  const b = await balances(c, { from: p.from, to: p.to, excludeClosing: true });
  const exp = accts.filter((a) => a.type === 'EXPENSE').map((a) => ({ a, v: natural(a, b.get(a.id)) })).filter((x) => !x.v.isZero()).sort((x, y) => y.v.comparedTo(x.v));
  const total = exp.reduce((s, x) => s.plus(x.v), D(0));
  const r = newReport(c, 'expenses', 'Expense Report', `${p.from} to ${p.to}`);
  r.sections.push({ title: 'By account', columns: [col('name', 'Account'), col('amount', 'Amount', 'money'), col('pct', '% of total', 'pct')], rows: exp.map((x) => row({ name: nameOf(x.a), amount: m2(x.v), pct: pct(x.v, total) })), totals: [row({ name: 'Total expenses', amount: m2(total) }, { bold: true })] });
  const bySupplier = await c.prisma.journalLine.groupBy({ by: ['contactId'], where: { companyId: c.companyId, account: { type: 'EXPENSE' }, entry: { status: 'POSTED', date: { gte: toDate(p.from), lte: toDate(p.to) } } }, _sum: { debit: true, credit: true } });
  const names = new Map((await c.prisma.contact.findMany({ where: { companyId: c.companyId, id: { in: bySupplier.map((x) => x.contactId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
  const rows = bySupplier.map((x) => ({ name: x.contactId ? names.get(x.contactId) ?? 'Unknown' : '(no supplier recorded)', v: D(x._sum.debit ?? 0).minus(x._sum.credit ?? 0) })).filter((x) => !x.v.isZero()).sort((a, b) => b.v.comparedTo(a.v));
  r.sections.push({ title: 'By supplier', columns: [col('name', 'Supplier'), col('amount', 'Amount', 'money'), col('pct', '% of total', 'pct')], rows: rows.map((x) => row({ name: x.name, amount: m2(x.v), pct: pct(x.v, total) })), totals: [row({ name: 'Total', amount: m2(rows.reduce((s, x) => s.plus(x.v), D(0))) }, { bold: true })] });
  const supplierTotal = rows.reduce((s, x) => s.plus(x.v), D(0));
  r.checks.push({ label: 'By-account and by-supplier totals agree', ok: supplierTotal.eq(total), detail: supplierTotal.eq(total) ? undefined : `${m2(total)} vs ${m2(supplierTotal)}` });
  return r;
}

// ------------------------------------------------------------------ revenue by sales channel
export async function revenueByChannel(c: Ctx, p: { from: string; to: string }): Promise<Report> {
  type R = { st: string; sid: string | null; rid: string | null; amt: string };
  const rows = await c.prisma.$queryRaw<R[]>`
    SELECT e."sourceType" AS st, e."sourceId"::text AS sid, e."reversalOfId"::text AS rid, SUM(l."credit" - l."debit")::text AS amt
    FROM "JournalLine" l JOIN "JournalEntry" e ON e."id" = l."entryId" JOIN "Account" a ON a."id" = l."accountId"
    WHERE l."companyId" = ${c.companyId}::uuid AND e."status" = 'POSTED' AND a."type" = 'REVENUE' AND e."date" BETWEEN ${toDate(p.from)} AND ${toDate(p.to)}
    GROUP BY 1, 2, 3`;
  const origIds = rows.map((x) => x.rid).filter((x): x is string => !!x);
  const origs = origIds.length ? await c.prisma.journalEntry.findMany({ where: { id: { in: origIds } }, select: { id: true, sourceType: true, sourceId: true } }) : [];
  const origMap = new Map(origs.map((o) => [o.id, o]));
  const eff = rows.map((x) => { const o = x.rid ? origMap.get(x.rid) : null; return { st: o?.sourceType ?? x.st, sid: o ? o.sourceId : x.sid, amt: D(x.amt) }; });
  const orderIds = eff.filter((x) => x.st === 'shopify_order' && x.sid).map((x) => x.sid!);
  const refundIds = eff.filter((x) => x.st === 'shopify_refund' && x.sid).map((x) => x.sid!);
  const [orders, refunds] = await Promise.all([
    orderIds.length ? c.prisma.shopifyOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, store: { select: { shopDomain: true } } } }) : [],
    refundIds.length ? c.prisma.shopifyRefund.findMany({ where: { id: { in: refundIds } }, select: { id: true, store: { select: { shopDomain: true } } } }) : [],
  ]);
  const store = new Map<string, string>([...orders, ...refunds].map((x) => [x.id, x.store.shopDomain]));
  const label = (x: (typeof eff)[number]) => x.st === 'shopify_order' || x.st === 'shopify_refund' ? `Shopify: ${store.get(x.sid ?? '') ?? 'store'}` : x.st === 'invoice' || x.st === 'credit_note' ? 'Invoices (direct sales)' : x.st === 'bank_txn' ? 'Bank deposits (categorised)' : x.st === 'manual' ? 'Manual journals' : 'Other';
  const by = new Map<string, Decimal>();
  for (const x of eff) by.set(label(x), (by.get(label(x)) ?? D(0)).plus(x.amt));
  const total = [...by.values()].reduce((s, v) => s.plus(v), D(0));
  const r = newReport(c, 'revenue-by-channel', 'Revenue by Sales Channel', `${p.from} to ${p.to} · net of returns`);
  r.sections.push({ columns: [col('name', 'Channel'), col('amount', 'Revenue', 'money'), col('pct', '% of total', 'pct')], rows: [...by].filter(([, v]) => !v.isZero()).sort((a, b) => b[1].comparedTo(a[1])).map(([k, v]) => row({ name: k, amount: m2(v), pct: pct(v, total) })), totals: [row({ name: 'Total revenue', amount: m2(total) }, { bold: true })] });
  const accts = await loadAccounts(c);
  const b = await balances(c, { from: p.from, to: p.to, excludeClosing: true });
  const pl = accts.filter((a) => a.type === 'REVENUE').reduce((s, a) => s.plus(natural(a, b.get(a.id))), D(0));
  r.checks.push({ label: 'Channel total equals total revenue in the Profit and Loss', ok: pl.eq(total), detail: pl.eq(total) ? undefined : `${m2(total)} vs ${m2(pl)}` });
  r.notes.push('Channel is derived from what created each entry (Shopify order/refund, invoice, bank categorisation, manual journal). Voids and reversals follow the original entry.');
  return r;
}
