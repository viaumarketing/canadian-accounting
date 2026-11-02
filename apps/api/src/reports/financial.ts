import Decimal from 'decimal.js';
import { col, row, type Report, type Row } from '@ca/reporting';
import { D, Ctx, accountTree, addDays, addYears, balances, comparisonRange, fiscalYearBounds, loadAccounts, m2, nameOf, natural, net, newReport, pct, type Compare, type Acct } from './common';
import { isoOf, toDate } from '../accounting/setup';

// ------------------------------------------------------------------ Profit & Loss
export async function profitAndLoss(c: Ctx, p: { from: string; to: string; compare: Compare }): Promise<Report> {
  const cmp = comparisonRange(p.from, p.to, p.compare);
  const accts = await loadAccounts(c);
  const [cur, prev] = await Promise.all([balances(c, { from: p.from, to: p.to, excludeClosing: true }), cmp ? balances(c, { ...cmp, excludeClosing: true }) : Promise.resolve(null)]);
  const bal = (a: Acct, i: number) => natural(a, (i === 0 ? cur : prev!).get(a.id));
  const cols = cmp ? 2 : 1;
  const r = newReport(c, 'profit-loss', 'Profit and Loss', `${p.from} to ${p.to}${cmp ? ` · compared with ${cmp.from} to ${cmp.to}` : ''} · accrual basis`);
  const columns = cmp
    ? [col('name', 'Account'), col('cur', 'Current', 'money'), col('prev', 'Comparison', 'money'), col('chg', 'Change', 'money'), col('chgPct', 'Change %', 'pct')]
    : [col('name', 'Account'), col('cur', 'Amount', 'money'), col('pctRev', '% of revenue', 'pct')];

  const rev = accountTree(accts, 'REVENUE', [], bal, cols);
  const exp = accountTree(accts, 'EXPENSE', [], bal, cols);
  const sum = (nodes: typeof rev, i: number) => nodes.filter((n) => n.level === 0).reduce((s, n) => s.plus(n.total[i]), D(0));
  const revTot = [sum(rev, 0), cmp ? sum(rev, 1) : D(0)];
  const expTot = [sum(exp, 0), cmp ? sum(exp, 1) : D(0)];
  const niTot = [revTot[0].minus(expTot[0]), revTot[1].minus(expTot[1])];

  const rowFor = (label: string, v: Decimal[], o: { level?: number; bold?: boolean } = {}): Row => {
    const cells: Row['cells'] = { name: label, cur: m2(v[0]) };
    if (cmp) { cells.prev = m2(v[1]); cells.chg = m2(v[0].minus(v[1])); cells.chgPct = v[1].isZero() ? null : pct(v[0].minus(v[1]), v[1].abs()); }
    else cells.pctRev = pct(v[0], revTot[0]);
    return row(cells, o);
  };
  r.sections.push({ title: 'Revenue', columns, rows: rev.map((n) => rowFor(nameOf(n.acct), n.total, { level: n.level })), totals: [rowFor('Total revenue', revTot, { bold: true })] });
  r.sections.push({ title: 'Expenses', columns, rows: exp.map((n) => rowFor(nameOf(n.acct), n.total, { level: n.level })), totals: [rowFor('Total expenses', expTot, { bold: true })] });
  r.sections.push({ title: 'Result', columns, rows: [], totals: [rowFor('Net income', niTot, { bold: true })] });

  // Tie-out: independent computation straight from the trial-balance totals of REVENUE/EXPENSE accounts.
  const tbNet = accts.filter((a) => a.type === 'REVENUE').reduce((s, a) => s.plus(natural(a, cur.get(a.id))), D(0)).minus(accts.filter((a) => a.type === 'EXPENSE').reduce((s, a) => s.plus(natural(a, cur.get(a.id))), D(0)));
  r.checks.push({ label: 'Net income equals total revenue minus total expenses, recomputed straight from the ledger', ok: tbNet.eq(niTot[0]), detail: tbNet.eq(niTot[0]) ? undefined : `report ${m2(niTot[0])} vs ledger ${m2(tbNet)}` });
  r.notes.push('Prepared on the accrual basis from posted journal entries; year-end closing entries are left out so a closed year still shows its results. Cash-basis reporting and gross profit (cost-of-sales flag) are not available yet.');
  return r;
}

// ------------------------------------------------------------------ Balance sheet
export async function balanceSheet(c: Ctx, p: { asOf: string; compare: Compare }): Promise<Report> {
  const prevDate = p.compare === 'prior_year' ? addYears(p.asOf, -1) : p.compare === 'prior_period' ? null : null;
  const accts = await loadAccounts(c);
  const [cur, prev] = await Promise.all([balances(c, { to: p.asOf }), prevDate ? balances(c, { to: prevDate }) : Promise.resolve(null)]);
  const cols = prev ? 2 : 1;
  const bal = (a: Acct, i: number) => natural(a, (i === 0 ? cur : prev!).get(a.id));
  const r = newReport(c, 'balance-sheet', 'Balance Sheet', `As of ${p.asOf}${prevDate ? ` · compared with ${prevDate}` : ''}`);
  const columns = prev ? [col('name', 'Account'), col('cur', p.asOf, 'money'), col('prev', prevDate!, 'money'), col('chg', 'Change', 'money')] : [col('name', 'Account'), col('cur', 'Balance', 'money')];
  const rowFor = (label: string, v: Decimal[], o: { level?: number; bold?: boolean } = {}): Row => row({ name: label, cur: m2(v[0]), ...(prev ? { prev: m2(v[1]), chg: m2(v[0].minus(v[1])) } : {}) }, o);

  const assets = accountTree(accts, 'ASSET', [], bal, cols);
  const liabs = accountTree(accts, 'LIABILITY', [], bal, cols);
  const equity = accountTree(accts, 'EQUITY', [], bal, cols);
  const tot = (nodes: typeof assets) => Array.from({ length: cols }, (_, i) => nodes.filter((n) => n.level === 0).reduce((s, n) => s.plus(n.total[i]), D(0)));
  const A = tot(assets), L = tot(liabs), E = tot(equity);
  // Revenue/expense balances to date are the earnings of years not yet closed (closing entries move closed years to Retained Earnings).
  const earnings = Array.from({ length: cols }, (_, i) => {
    const b = i === 0 ? cur : prev!;
    return accts.filter((a) => a.type === 'REVENUE').reduce((s, a) => s.plus(natural(a, b.get(a.id))), D(0)).minus(accts.filter((a) => a.type === 'EXPENSE').reduce((s, a) => s.plus(natural(a, b.get(a.id))), D(0)));
  });
  const equityTotal = E.map((v, i) => v.plus(earnings[i]));
  r.sections.push({ title: 'Assets', columns, rows: assets.map((n) => rowFor(nameOf(n.acct), n.total, { level: n.level })), totals: [rowFor('Total assets', A, { bold: true })] });
  r.sections.push({ title: 'Liabilities', columns, rows: liabs.map((n) => rowFor(nameOf(n.acct), n.total, { level: n.level })), totals: [rowFor('Total liabilities', L, { bold: true })] });
  r.sections.push({ title: 'Equity', columns, rows: [...equity.map((n) => rowFor(nameOf(n.acct), n.total, { level: n.level })), rowFor('Net income not yet closed to retained earnings', earnings)], totals: [rowFor('Total equity', equityTotal, { bold: true }), rowFor('Total liabilities and equity', L.map((v, i) => v.plus(equityTotal[i])), { bold: true })] });
  for (let i = 0; i < cols; i++) {
    const ok = A[i].eq(L[i].plus(equityTotal[i]));
    r.checks.push({ label: `Assets = liabilities + equity${i ? ' (comparison)' : ''}`, ok, detail: ok ? undefined : `assets ${m2(A[i])} vs ${m2(L[i].plus(equityTotal[i]))}` });
  }
  r.notes.push('Profit of fiscal years that have been closed is in Retained Earnings; "net income not yet closed" is the profit of years still open.');
  return r;
}

// ------------------------------------------------------------------ Cash flow (indirect)
export async function cashFlow(c: Ctx, p: { from: string; to: string }): Promise<Report> {
  const [accts, banks] = await Promise.all([loadAccounts(c), c.prisma.bankAccount.findMany({ where: { companyId: c.companyId, kind: { not: 'CREDIT_CARD' } }, select: { ledgerAccountId: true } })]);
  const cashIds = new Set(banks.map((b) => b.ledgerAccountId));
  const r = newReport(c, 'cash-flow', 'Statement of Cash Flows', `${p.from} to ${p.to} · indirect method`);
  const columns = [col('name', 'Item'), col('amount', 'Amount', 'money')];
  if (!cashIds.size) { r.notes.push('No chequing or savings accounts are defined under Banking, so there is no cash to report on.'); r.sections.push({ columns, rows: [] }); return r; }

  const before = addDays(p.from, -1);
  // Closing entries are left out everywhere here: they only move profit into Retained Earnings and involve no cash.
  const [open, close, period] = await Promise.all([balances(c, { to: before, excludeClosing: true }), balances(c, { to: p.to, excludeClosing: true }), balances(c, { from: p.from, to: p.to, excludeClosing: true })]);
  const ni = accts.filter((a) => a.type === 'REVENUE').reduce((s, a) => s.plus(natural(a, period.get(a.id))), D(0)).minus(accts.filter((a) => a.type === 'EXPENSE').reduce((s, a) => s.plus(natural(a, period.get(a.id))), D(0)));

  const classOf = (a: Acct) => a.cashFlow ?? (a.type === 'EQUITY' ? 'FINANCING' : 'OPERATING');
  const groups: Record<'OPERATING' | 'INVESTING' | 'FINANCING', { label: string; effect: Decimal }[]> = { OPERATING: [], INVESTING: [], FINANCING: [] };
  for (const a of accts) {
    if (cashIds.has(a.id) || a.type === 'REVENUE' || a.type === 'EXPENSE') continue;
    const change = net(close.get(a.id)).minus(net(open.get(a.id))); // Δ(debit − credit)
    if (change.isZero()) continue;
    groups[classOf(a)].push({ label: `${a.type === 'ASSET' ? (change.isPositive() ? 'Increase' : 'Decrease') : change.isNegative() ? 'Increase' : 'Decrease'} in ${a.name}`, effect: change.neg() });
  }
  const section = (key: 'OPERATING' | 'INVESTING' | 'FINANCING', title: string, lead?: Row) => {
    const items = groups[key];
    const total = items.reduce((s, x) => s.plus(x.effect), key === 'OPERATING' ? ni : D(0));
    r.sections.push({ title, columns, rows: [...(lead ? [lead] : []), ...items.map((x) => row({ name: x.label, amount: m2(x.effect) }, { level: 1 }))], totals: [row({ name: `Net cash from ${title.toLowerCase()}`, amount: m2(total) }, { bold: true })] });
    return total;
  };
  const op = section('OPERATING', 'Operating activities', row({ name: 'Net income', amount: m2(ni) }));
  const inv = section('INVESTING', 'Investing activities');
  const fin = section('FINANCING', 'Financing activities');
  const change = op.plus(inv).plus(fin);
  const cashBal = (b: typeof open) => [...cashIds].reduce((s, id) => s.plus(net(b.get(id))), D(0));
  const openCash = cashBal(open), closeCash = cashBal(close);
  r.sections.push({ title: 'Cash', columns, rows: [row({ name: 'Cash at start of period', amount: m2(openCash) }), row({ name: 'Net change in cash', amount: m2(change) })], totals: [row({ name: 'Cash at end of period', amount: m2(openCash.plus(change)) }, { bold: true })] });
  const ok = openCash.plus(change).eq(closeCash);
  r.checks.push({ label: 'Net change in cash equals the change in your bank-account balances', ok, detail: ok ? undefined : `statement says ${m2(change)}, ledger moved ${m2(closeCash.minus(openCash))}` });
  r.notes.push('Cash means your chequing and savings accounts (Banking → Accounts). Credit cards count as operating liabilities unless an account is classified otherwise. Accounts are classified by their cash-flow class (default: assets and liabilities operating, equity financing).');
  return r;
}

// ------------------------------------------------------------------ Journal report
export async function journalReport(c: Ctx, p: { from: string; to: string }): Promise<Report> {
  const entries = await c.prisma.journalEntry.findMany({
    where: { companyId: c.companyId, status: 'POSTED', date: { gte: toDate(p.from), lte: toDate(p.to) } }, orderBy: [{ date: 'asc' }, { number: 'asc' }], take: 5000,
    include: { lines: { orderBy: { lineNo: 'asc' }, include: { account: { select: { code: true, name: true } } } } },
  });
  const r = newReport(c, 'journal', 'Journal Report', `${p.from} to ${p.to}`);
  const rows: Row[] = [];
  let dr = D(0), cr = D(0);
  for (const e of entries) {
    e.lines.forEach((l, i) => {
      dr = dr.plus(l.debit.toString()); cr = cr.plus(l.credit.toString());
      rows.push(row({ date: isoOf(e.date), number: i === 0 ? e.number : null, source: i === 0 ? e.sourceType : null, memo: i === 0 ? e.memo : null, account: `${l.account.code} · ${l.account.name}`, debit: D(l.debit).isZero() ? null : m2(D(l.debit)), credit: D(l.credit).isZero() ? null : m2(D(l.credit)) }));
    });
  }
  r.sections.push({ columns: [col('date', 'Date', 'date'), col('number', '#', 'int'), col('source', 'Source'), col('memo', 'Memo'), col('account', 'Account'), col('debit', 'Debit', 'money'), col('credit', 'Credit', 'money')], rows, totals: [row({ memo: 'Totals', debit: m2(dr), credit: m2(cr) }, { bold: true })] });
  r.checks.push({ label: 'Total debits equal total credits', ok: dr.eq(cr), detail: dr.eq(cr) ? undefined : `${m2(dr)} vs ${m2(cr)}` });
  if (entries.length === 5000) r.notes.push('Limited to the first 5,000 entries of the range; narrow the dates.');
  return r;
}

export async function trialBalanceReport(c: Ctx, p: { asOf: string }): Promise<Report> {
  const accts = await loadAccounts(c);
  const b = await balances(c, { to: p.asOf });
  const r = newReport(c, 'trial-balance', 'Trial Balance', `As of ${p.asOf}`);
  let td = D(0), tc = D(0);
  const rows: Row[] = [];
  for (const a of accts) {
    const n = net(b.get(a.id));
    if (n.isZero() && !b.get(a.id)) continue;
    const dr = n.gt(0) ? n : D(0), cr = n.lt(0) ? n.neg() : D(0);
    if (dr.isZero() && cr.isZero()) continue;
    td = td.plus(dr); tc = tc.plus(cr);
    rows.push(row({ code: a.code, name: a.name, type: a.type.toLowerCase(), debit: dr.isZero() ? null : m2(dr), credit: cr.isZero() ? null : m2(cr) }));
  }
  r.sections.push({ columns: [col('code', 'Code'), col('name', 'Account'), col('type', 'Type'), col('debit', 'Debit', 'money'), col('credit', 'Credit', 'money')], rows, totals: [row({ name: 'Totals', debit: m2(td), credit: m2(tc) }, { bold: true })] });
  r.checks.push({ label: 'Debits equal credits', ok: td.eq(tc), detail: td.eq(tc) ? undefined : `${m2(td)} vs ${m2(tc)}` });
  return r;
}

export const GL_PAGE_SIZE = 500;

/** General ledger of one account. With `page`, only that page of lines is returned (screen); without it, every line (exports). */
export async function generalLedgerReport(c: Ctx, p: { accountId: string; from: string; to: string; page?: number }): Promise<Report> {
  const acct = await c.prisma.account.findFirst({ where: { id: p.accountId, companyId: c.companyId } });
  if (!acct) throw new Error('Account not found');
  const dateRange = { gte: toDate(p.from), lte: toDate(p.to) };
  const inRange = { companyId: c.companyId, accountId: p.accountId, entry: { status: 'POSTED' as const, date: dateRange } };
  const order = [{ entry: { date: 'asc' as const } }, { entry: { number: 'asc' as const } }, { lineNo: 'asc' as const }];
  const [open, all, total] = await Promise.all([
    c.prisma.journalLine.aggregate({ where: { companyId: c.companyId, accountId: p.accountId, entry: { status: 'POSTED', date: { lt: dateRange.gte } } }, _sum: { debit: true, credit: true } }),
    c.prisma.journalLine.aggregate({ where: inRange, _sum: { debit: true, credit: true } }),
    c.prisma.journalLine.count({ where: inRange }),
  ]);
  const opening = D(open._sum.debit ?? 0).minus(open._sum.credit ?? 0);
  const closing = opening.plus(D(all._sum.debit ?? 0)).minus(D(all._sum.credit ?? 0));
  const pages = Math.max(1, Math.ceil(total / GL_PAGE_SIZE));
  const page = p.page ? Math.min(Math.max(1, p.page), pages) : null;
  const skip = page ? (page - 1) * GL_PAGE_SIZE : 0;
  // Balance brought forward to this page = opening + every line on the earlier pages, in the same order.
  const before = skip ? await c.prisma.journalLine.findMany({ where: inRange, orderBy: order, take: skip, select: { debit: true, credit: true } }) : [];
  let run = before.reduce((s, l) => s.plus(l.debit.toString()).minus(l.credit.toString()), opening);
  const lines = await c.prisma.journalLine.findMany({ where: inRange, include: { entry: { select: { date: true, number: true, memo: true, sourceType: true } } }, orderBy: order, ...(page ? { skip, take: GL_PAGE_SIZE } : {}) });
  const r = newReport(c, 'general-ledger', `General Ledger: ${acct.code} ${acct.name}`, `${p.from} to ${p.to}${page && pages > 1 ? ` · page ${page} of ${pages}` : ''}`);
  const rows: Row[] = [row({ memo: skip ? 'Balance brought forward' : 'Opening balance', balance: m2(run) }, { bold: true })];
  for (const l of lines) { run = run.plus(l.debit.toString()).minus(l.credit.toString()); rows.push(row({ date: isoOf(l.entry.date), number: l.entry.number, source: l.entry.sourceType, memo: l.memo ?? l.entry.memo, debit: D(l.debit).isZero() ? null : m2(D(l.debit)), credit: D(l.credit).isZero() ? null : m2(D(l.credit)), balance: m2(run) })); }
  const last = !page || page === pages;
  r.sections.push({ columns: [col('date', 'Date', 'date'), col('number', '#', 'int'), col('source', 'Source'), col('memo', 'Memo'), col('debit', 'Debit', 'money'), col('credit', 'Credit', 'money'), col('balance', 'Balance (debit +)', 'money')], rows, totals: [...(last ? [] : [row({ memo: 'Balance carried forward', balance: m2(run) }, { bold: true })]), row({ memo: `Closing balance (${p.to})`, balance: m2(closing) }, { bold: true })] });
  if (page) r.paging = { page, pages, pageSize: GL_PAGE_SIZE, total };
  if (last && !run.eq(closing)) r.checks.push({ label: 'Running balance reaches the closing balance', ok: false, detail: `${m2(run)} vs ${m2(closing)}` });
  run = closing;
  const tb = await balances(c, { to: p.to });
  const closeLedger = net(tb.get(p.accountId));
  r.checks.push({ label: 'Closing balance equals the trial-balance balance', ok: closeLedger.eq(run), detail: closeLedger.eq(run) ? undefined : `${m2(run)} vs ${m2(closeLedger)}` });
  return r;
}
export { Decimal, fiscalYearBounds };
