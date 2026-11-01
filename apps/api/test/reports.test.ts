import { createHmac } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@ca/database';
import type { Report } from '@ca/reporting';
import { btNode, ontarioOrder, payoutNode, refund } from '@ca/shopify-integration/dist/fixtures';
import { ShopifySyncService } from '../src/shopify/sync.service';
import { shopifyFetch } from '../src/shopify/shopify.module';
import { PASSWORD, agent, bootApp, resetDb, setupAdmin } from './helpers';
import { fakeShopifyFetch, newFake } from './fake-shopify';

type A = ReturnType<typeof agent>;
let app: INestApplication;
let prisma: PrismaClient;
beforeAll(async () => { ({ app, prisma } = await bootApp({ SHOPIFY_CLIENT_ID: 'cid', SHOPIFY_CLIENT_SECRET: 'sec', QUEUE_MODE: 'none' })); });
afterAll(async () => { await prisma.$disconnect(); await app.close(); });
beforeEach(() => resetDb(prisma));

const jl = (accountId: string, debit: string, credit = '0') => ({ accountId, debit, credit });
async function company(root: A, province = 'ON', name = 'Maple Goods Inc.') {
  const c = (await root.post('/admin/companies', { legalName: name, province, ownerEmail: 'root@example.test' }).expect(201)).body;
  await root.post(`/companies/${c.id}/fiscal-years`, { startDate: '2026-01-01' });
  const accts = (await root.get(`/companies/${c.id}/accounts`).expect(200)).body as { id: string; code: string }[];
  const codes = (await root.get(`/companies/${c.id}/tax-codes`).expect(200)).body as { id: string; code: string }[];
  const acct = Object.fromEntries(accts.map((a) => [a.code, a.id])) as Record<string, string>;
  const tax = Object.fromEntries(codes.map((a) => [a.code, a.id])) as Record<string, string>;
  const customer = (await root.post(`/companies/${c.id}/contacts`, { kind: 'CUSTOMER', name: 'Acme Customer' }).expect(201)).body.id;
  const vendor = (await root.post(`/companies/${c.id}/contacts`, { kind: 'VENDOR', name: 'Acme Supplier' }).expect(201)).body.id;
  await root.post(`/companies/${c.id}/banking/accounts`, { name: 'Chequing', kind: 'CHEQUING', ledgerAccountId: acct['1010'] }).expect(201);
  await root.post(`/companies/${c.id}/journals`, { date: '2026-01-02', post: true, memo: 'Opening capital', lines: [jl(acct['1010'], '10000.00'), jl(acct['3000'], '0', '10000.00')] }).expect(201);
  return { id: c.id as string, acct, tax, customer, vendor };
}
type Co = Awaited<ReturnType<typeof company>>;
const rep = async (a: A, co: Co, key: string, q = ''): Promise<Report> => (await a.get(`/companies/${co.id}/report/${key}?${q}`).expect(200)).body;
const cell = (r: Report, section: number, label: string, key = 'amount') => { const s = r.sections[section]; const x = [...s.rows, ...(s.totals ?? [])].find((y) => Object.values(y.cells).some((v) => typeof v === 'string' && v.includes(label))); if (!x) throw new Error(`no row "${label}" in section ${section}: ${[...s.rows, ...(s.totals ?? [])].map((y) => y.cells.name).join(' | ')}`); return x.cells[key]; };
const allChecksOk = (r: Report) => expect(r.checks.filter((c) => !c.ok), JSON.stringify(r.checks.filter((c) => !c.ok))).toEqual([]);
async function invoice(a: A, co: Co, o: { amount: string; date: string; due: string; code?: string; account?: string; kind?: string }) {
  const inv = (await a.post(`/companies/${co.id}/invoices`, { kind: o.kind ?? 'STANDARD', contactId: co.customer, issueDate: o.date, dueDate: o.due, lines: [{ description: 'Syrup', quantity: '1', unitPrice: o.amount, accountId: co.acct[o.account ?? '4000'], taxCodeId: co.tax[o.code ?? 'HST_ON'] }] }).expect(201)).body;
  return (await a.post(`/companies/${co.id}/invoices/${inv.id}/post`).expect(201)).body;
}
async function bill(a: A, co: Co, o: { amount: string; date: string; due: string; code?: string; account?: string }) {
  const b = (await a.post(`/companies/${co.id}/bills`, { contactId: co.vendor, issueDate: o.date, dueDate: o.due, lines: [{ description: 'Supplies', quantity: '1', unitPrice: o.amount, accountId: co.acct[o.account ?? '6050'], taxCodeId: co.tax[o.code ?? 'HST_ON'] }] }).expect(201)).body;
  return (await a.post(`/companies/${co.id}/bills/${b.id}/post`).expect(201)).body;
}
const pay = (a: A, co: Co, direction: 'RECEIPT' | 'DISBURSEMENT', doc: string, amount: string, date: string) =>
  a.post(`/companies/${co.id}/payments`, { direction, contactId: direction === 'RECEIPT' ? co.customer : co.vendor, bankAccountId: co.acct['1010'], date, amount, allocations: [{ documentId: doc, amount }] }).expect(201);

/** A year of varied activity: sales, partial payment, bill + payment, expense, credit note, equipment, loan, remittance. */
async function year(root: A, co: Co) {
  const invA = await invoice(root, co, { amount: '1000.00', date: '2026-03-10', due: '2026-04-09' });
  const invB = await invoice(root, co, { amount: '500.00', date: '2026-05-01', due: '2026-05-31' });
  await pay(root, co, 'RECEIPT', invB.id, '200.00', '2026-06-15');
  const b = await bill(root, co, { amount: '400.00', date: '2026-04-05', due: '2026-05-05' });
  await pay(root, co, 'DISBURSEMENT', b.id, '452.00', '2026-05-10');
  const emp = (await root.post(`/companies/${co.id}/expenses`, { date: '2026-06-01', description: 'Lunch', paidFromAccountId: co.acct['1010'], taxInclusive: true, lines: [{ description: 'Lunch', amount: '113.00', accountId: co.acct['6110'], taxCodeId: co.tax.HST_ON }] }).expect(201)).body;
  const acc = agent(app);
  await root.post(`/companies/${co.id}/members`, { email: 'acc@example.test', name: 'Acc', role: 'ACCOUNTANT', temporaryPassword: PASSWORD }).expect(201);
  await acc.post('/auth/login', { email: 'acc@example.test', password: PASSWORD }).expect(200);
  await acc.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' }).expect(204);
  await acc.post(`/companies/${co.id}/expenses/${emp.id}/approve`, {}).expect(201);
  await acc.post(`/companies/${co.id}/expenses/${emp.id}/post`).expect(201);
  await invoice(root, co, { amount: '100.00', date: '2026-07-01', due: '2026-07-31', kind: 'CREDIT' });
  await root.post(`/companies/${co.id}/journals`, { date: '2026-02-01', post: true, memo: 'Laptop', lines: [jl(co.acct['1500'], '3000.00'), jl(co.acct['1010'], '0', '3000.00')] }).expect(201);
  await root.post(`/companies/${co.id}/journals`, { date: '2026-02-15', post: true, memo: 'Shareholder loan', lines: [jl(co.acct['1010'], '5000.00'), jl(co.acct['2500'], '0', '5000.00')] }).expect(201);
  return { invA, invB, bill: b };
}

describe('financial statements', () => {
  it('profit and loss, balance sheet and trial balance agree; every check passes', async () => {
    const root = await setupAdmin(app); const co = await company(root); await year(root, co);
    const childRes = await root.post(`/companies/${co.id}/accounts`, { code: '4010', name: 'Wholesale', type: 'REVENUE', parentId: co.acct['4000'] });
    expect(childRes.status, JSON.stringify(childRes.body)).toBe(201);
    const child = childRes.body;
    co.acct['4010'] = child.id;
    await invoice(root, co, { amount: '50.00', date: '2026-08-01', due: '2026-08-31', account: '4010' });
    const pl = await rep(root, co, 'profit-loss', 'from=2026-01-01&to=2026-12-31');
    expect(cell(pl, 0, 'Total revenue', 'cur')).toBe('1450.00'); // 1000 + 500 − 100 + 50
    expect(cell(pl, 1, 'Total expenses', 'cur')).toBe('500.00'); // 400 supplies + 100 lunch
    expect(cell(pl, 2, 'Net income', 'cur')).toBe('950.00');
    const rows = pl.sections[0].rows;
    const parent = rows.find((r) => String(r.cells.name).includes('4000'))!;
    expect(parent.cells.cur).toBe('1450.00'); // 1,400 of its own plus the 50 child, rolled up
    expect(rows.find((r) => String(r.cells.name).includes('4010'))).toMatchObject({ level: 1, cells: { cur: '50.00' } });
    allChecksOk(pl);
    const bs = await rep(root, co, 'balance-sheet', 'asOf=2026-12-31');
    expect(cell(bs, 2, 'Net income not yet closed', 'cur')).toBe('950.00');
    allChecksOk(bs);
    const tbr = await rep(root, co, 'trial-balance', 'asOf=2026-12-31');
    expect(cell(tbr, 0, 'Totals', 'debit')).toBe(cell(tbr, 0, 'Totals', 'credit'));
    allChecksOk(tbr);
    expect(child.id).toBeTruthy();
  });
  it('comparisons: prior year and prior period', async () => {
    const root = await setupAdmin(app); const co = await company(root); await year(root, co);
    const py = await rep(root, co, 'profit-loss', 'from=2026-01-01&to=2026-12-31&compare=prior_year');
    expect(py.sections[0].columns.map((c) => c.key)).toEqual(['name', 'cur', 'prev', 'chg', 'chgPct']);
    expect(cell(py, 0, 'Total revenue', 'prev')).toBe('0.00');
    expect(cell(py, 0, 'Total revenue', 'chg')).toBe('1400.00');
    expect(cell(py, 0, 'Total revenue', 'chgPct')).toBeNull(); // no divide by zero
    const pp = await rep(root, co, 'profit-loss', 'from=2026-07-01&to=2026-12-31&compare=prior_period');
    expect(pp.subtitle).toContain('2025-12-29 to 2026-06-30'); // the same 184-day length immediately before
    expect(cell(pp, 0, 'Total revenue', 'prev')).toBe('1500.00');
    const bsy = await rep(root, co, 'balance-sheet', 'asOf=2026-12-31&compare=prior_year');
    expect(bsy.sections[0].columns.map((c) => c.key)).toEqual(['name', 'cur', 'prev', 'chg']);
    allChecksOk(bsy);
  });
  it('cash flow: classified sections and the net change equals the bank-account movement', async () => {
    const root = await setupAdmin(app); const co = await company(root); await year(root, co);
    const cf = await rep(root, co, 'cash-flow', 'from=2026-01-01&to=2026-12-31');
    allChecksOk(cf);
    expect(cell(cf, 1, 'Net cash from investing', 'amount')).toBe('-3000.00');
    expect(cell(cf, 2, 'Net cash from financing', 'amount')).toBe('4000.00'.replace('4000', '15000')); // capital 10,000 + loan 5,000
    const tb = (await root.get(`/companies/${co.id}/reports/trial-balance?asOf=2026-12-31`).expect(200)).body;
    const cash = tb.rows.find((r: { code: string }) => r.code === '1010');
    expect(cell(cf, 3, 'Cash at end', 'amount')).toBe(Number(cash.debit).toFixed(2));
    expect(cell(cf, 3, 'Cash at start', 'amount')).toBe('0.00');
    const mid = await rep(root, co, 'cash-flow', 'from=2026-04-01&to=2026-06-30');
    allChecksOk(mid);
    expect(cell(mid, 3, 'Cash at start', 'amount')).not.toBe('0.00');
  });
  it('cash flow explains itself when no bank account exists; general ledger and journal reports tie out', async () => {
    const root = await setupAdmin(app);
    const c = (await root.post('/admin/companies', { legalName: 'No Bank Co', province: 'ON', ownerEmail: 'root@example.test' }).expect(201)).body;
    const cf = (await root.get(`/companies/${c.id}/report/cash-flow?from=2026-01-01&to=2026-12-31`).expect(200)).body as Report;
    expect(cf.notes.join()).toMatch(/No chequing or savings/);
    const co = await company(root); await year(root, co);
    const gl = await rep(root, co, 'general-ledger', `accountId=${co.acct['1100']}&from=2026-01-01&to=2026-12-31`);
    allChecksOk(gl);
    const jr = await rep(root, co, 'journal', 'from=2026-01-01&to=2026-12-31');
    allChecksOk(jr);
    expect(jr.sections[0].rows.length).toBeGreaterThan(20);
  });
});

describe('receivables, payables and forecast', () => {
  it('A/R aging as of a date ignores later payments and later documents, and ties to the control account', async () => {
    const root = await setupAdmin(app); const co = await company(root); await year(root, co);
    const jul = await rep(root, co, 'ar-aging', 'asOf=2026-07-31');
    expect(cell(jul, 0, 'Total', 'total')).toBe('1382.00'); // 1130 + (565 − 200) − 113 unapplied credit
    expect(cell(jul, 0, 'Acme Customer', 'd90p')).toBe('1130.00'); // 113 days past due
    expect(cell(jul, 0, 'Acme Customer', 'current')).toBe('-113.00');
    allChecksOk(jul);
    const early = await rep(root, co, 'ar-aging', 'asOf=2026-06-01'); // before the $200 payment and the credit note
    expect(cell(early, 0, 'Total', 'total')).toBe('1695.00');
    allChecksOk(early);
    const none = await rep(root, co, 'ar-aging', 'asOf=2026-03-01');
    expect(cell(none, 0, 'Total', 'total')).toBe('0.00');
  });
  it('A/P aging and its control-account check; a manual entry to the control account makes the check fail visibly', async () => {
    const root = await setupAdmin(app); const co = await company(root); const { bill: b } = await year(root, co);
    expect(cell(await rep(root, co, 'ap-aging', 'asOf=2026-05-01'), 0, 'Total', 'total')).toBe('452.00');
    expect(cell(await rep(root, co, 'ap-aging', 'asOf=2026-05-31'), 0, 'Total', 'total')).toBe('0.00');
    allChecksOk(await rep(root, co, 'ap-aging', 'asOf=2026-05-01'));
    await root.post(`/companies/${co.id}/journals`, { date: '2026-05-02', post: true, memo: 'Manual A/P entry', lines: [jl(co.acct['6070'], '75.00'), jl(co.acct['2000'], '0', '75.00')] }).expect(201);
    const bad = await rep(root, co, 'ap-aging', 'asOf=2026-05-31');
    const failed = bad.checks.find((c) => !c.ok);
    expect(failed?.label).toMatch(/control account/);
    expect(failed?.detail).toMatch(/aging 0\.00 vs ledger 75\.00/);
    expect(b.id).toBeTruthy();
  });
  it('forecast places known items by due date; overdue items fall in week 1; cash rolls forward', async () => {
    const root = await setupAdmin(app); const co = await company(root); await year(root, co);
    await invoice(root, co, { amount: '1000.00', date: '2026-07-20', due: '2026-08-14' });
    const f = await rep(root, co, 'cash-forecast', 'asOf=2026-07-31&weeks=4');
    const rows = f.sections[0].rows;
    expect(rows).toHaveLength(5);
    const opening = Number(rows[0].cells.cash);
    expect(rows[1].cells.inflow).toBe('1382.00'); // overdue A + B balance − credit note, all in week 1
    expect(Number(rows[1].cells.cash)).toBeCloseTo(opening + 1382, 2);
    expect(rows[3].cells.inflow).toBe('1130.00'); // due 2026-08-14 → third week
    expect(f.notes.join()).toMatch(/No sales, payroll/);
    await root.get(`/companies/${co.id}/report/cash-forecast?asOf=2026-07-31&weeks=99`).expect(400);
  });
  it('expense report ties by account and by supplier; revenue by channel ties to revenue', async () => {
    const root = await setupAdmin(app); const co = await company(root); await year(root, co);
    const ex = await rep(root, co, 'expenses', 'from=2026-01-01&to=2026-12-31');
    allChecksOk(ex);
    expect(cell(ex, 0, 'Total expenses', 'amount')).toBe('500.00');
    expect(ex.sections[1].rows.map((r) => r.cells.name)).toContain('Acme Supplier');
    const ch = await rep(root, co, 'revenue-by-channel', 'from=2026-01-01&to=2026-12-31');
    allChecksOk(ch);
    expect(cell(ch, 0, 'Invoices (direct sales)', 'amount')).toBe('1400.00');
  });
});

describe('tax reports', () => {
  it('GST/HST return lines are computed from the ledger and the schedules reconcile', async () => {
    const root = await setupAdmin(app); const co = await company(root); await year(root, co);
    await root.post(`/companies/${co.id}/tax-registrations`, { kind: 'GST_HST', registrationNumber: '123456789RT0001', filingFrequency: 'QUARTERLY', effectiveFrom: '2026-01-01' }).expect(201);
    const r = await rep(root, co, 'tax-gst-hst', 'from=2026-01-01&to=2026-12-31');
    const line = (n: string) => cell(r, 0, n, 'amount');
    const byLine = (n: string) => r.sections[0].rows.find((x) => x.cells.line === n)!.cells.amount;
    expect(byLine('101')).toBe('1400.00');
    expect(byLine('103')).toBe('182.00'); // 130 + 65 − 13 credit note
    expect(byLine('105')).toBe('182.00');
    expect(byLine('106')).toBe('65.00'); // 52 bill + 13 expense
    expect(byLine('108')).toBe('65.00');
    expect(byLine('109')).toBe('117.00');
    expect(line('Net tax')).toBe('117.00');
    allChecksOk(r);
    expect(r.notes.join()).toMatch(/Registration: 123456789RT0001/);
    const withInputs = await rep(root, co, 'tax-gst-hst', 'from=2026-01-01&to=2026-12-31&adj104=5.00&adj107=2.00&instalments110=20.00&rebates111=1.00');
    const L = (n: string) => withInputs.sections[0].rows.find((x) => x.cells.line === n)!.cells.amount;
    expect([L('105'), L('108'), L('109')]).toEqual(['187.00', '67.00', '120.00']);
    expect(L('114/115')).toBe('99.00'); // 120 − 20 − 1
    await root.get(`/companies/${co.id}/report/tax-gst-hst?from=2026-01-01&to=2026-12-31&adj104=abc`).expect(400);
  });
  it('movements outside documents (a remittance) are listed, not guessed, and the roll-forward still closes', async () => {
    const root = await setupAdmin(app); const co = await company(root); await year(root, co);
    await root.post(`/companies/${co.id}/journals`, { date: '2026-09-30', post: true, memo: 'Q2 GST/HST remittance', lines: [jl(co.acct['2200'], '60.00'), jl(co.acct['1010'], '0', '60.00')] }).expect(201);
    const r = await rep(root, co, 'tax-gst-hst', 'from=2026-01-01&to=2026-12-31');
    const other = r.sections.find((s) => s.title?.startsWith('Other movements'))!;
    expect(other.rows).toHaveLength(1);
    expect(other.rows[0].cells).toMatchObject({ memo: 'Q2 GST/HST remittance', amount: '-60.00' });
    allChecksOk(r);
    const roll = r.sections.find((s) => s.title?.includes('roll-forward'))!;
    expect(roll.totals![0].cells.amount).toBe('57.00'); // 117 payable − 60 remitted
    expect(roll.totals![1].cells.amount).toBe('57.00');
    const q4 = await rep(root, co, 'tax-gst-hst', 'from=2026-10-01&to=2026-12-31'); // later period starts from the earlier closing balance
    expect(q4.sections.find((s) => s.title?.includes('roll-forward'))!.rows[0].cells.amount).toBe('57.00');
    allChecksOk(q4);
  });
  it('Quebec: GST and QST are separate; British Columbia: PST collected is reported and PST on purchases is not an input credit', async () => {
    const root = await setupAdmin(app); const qc = await company(root, 'QC', 'Érablière Inc.');
    await invoice(root, qc, { amount: '100.00', date: '2026-03-01', due: '2026-03-31', code: 'GST_QST' });
    await bill(root, qc, { amount: '200.00', date: '2026-03-05', due: '2026-04-05', code: 'GST_QST' });
    const gst = await rep(root, qc, 'tax-gst-hst', 'from=2026-01-01&to=2026-12-31');
    expect(gst.sections[0].rows.find((x) => x.cells.line === '103')!.cells.amount).toBe('5.00');
    expect(gst.sections[0].rows.find((x) => x.cells.line === '106')!.cells.amount).toBe('10.00');
    const qst = await rep(root, qc, 'tax-qst', 'from=2026-01-01&to=2026-12-31');
    expect(cell(qst, 0, 'QST collected', 'amount')).toBe('9.98');
    expect(cell(qst, 0, 'QST recoverable', 'amount')).toBe('19.95');
    expect(qst.notes.join()).toMatch(/not verified/);
    allChecksOk(qst);
    const bc = await company(root, 'BC', 'Vancouver Co');
    await invoice(root, bc, { amount: '100.00', date: '2026-03-01', due: '2026-03-31', code: 'GST_PST_BC' });
    await bill(root, bc, { amount: '200.00', date: '2026-03-05', due: '2026-04-05', code: 'GST_PST_BC' });
    const pst = await rep(root, bc, 'tax-pst', 'from=2026-01-01&to=2026-12-31');
    expect(cell(pst, 0, 'PST collected', 'amount')).toBe('7.00');
    expect(JSON.stringify(pst.sections[0])).not.toMatch(/recoverable/);
    allChecksOk(pst);
    const gstBc = await rep(root, bc, 'tax-gst-hst', 'from=2026-01-01&to=2026-12-31');
    expect(gstBc.sections[0].rows.find((x) => x.cells.line === '106')!.cells.amount).toBe('10.00'); // GST only; PST is expense
  });
  it('filing periods follow the registration frequency and fiscal year', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await root.post(`/companies/${co.id}/tax-registrations`, { kind: 'GST_HST', registrationNumber: '123456789RT0001', filingFrequency: 'QUARTERLY', effectiveFrom: '2025-01-01' }).expect(201);
    const p = (await root.get(`/companies/${co.id}/tax-periods?date=2026-06-15`).expect(200)).body[0];
    expect(p.frequency).toBe('QUARTERLY');
    expect(p.periods.map((x: { from: string }) => x.from)).toContain('2026-04-01');
    expect(p.periods.find((x: { from: string }) => x.from === '2026-04-01').to).toBe('2026-06-30');
  });
});

describe('exports', () => {
  it('CSV, XLSX and PDF come from the same report; CSV injection is neutralised; exports are audited', async () => {
    const root = await setupAdmin(app); const co = await company(root); await year(root, co);
    await root.post(`/companies/${co.id}/contacts`, { kind: 'VENDOR', name: '=HYPERLINK("http://evil.example","x")' }).expect(201);
    const csv = await root.get(`/companies/${co.id}/report/profit-loss?from=2026-01-01&to=2026-12-31&format=csv`).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/profit-loss-2026-01-01_2026-12-31\.csv/);
    expect(csv.headers['cache-control']).toBe('no-store');
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    expect(csv.text).toContain('Total revenue,1400.00');
    const x = await root.raw.get(`/companies/${co.id}/report/balance-sheet?asOf=2026-12-31&format=xlsx`).expect(200).buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body as ArrayBuffer);
    expect(wb.worksheets[0].name).toBe('Balance Sheet');
    let found = false;
    wb.worksheets[0].eachRow((r: ExcelJS.Row) => { if (String(r.getCell(1).value).includes('Total assets')) { found = true; expect(typeof r.getCell(2).value).toBe('number'); } });
    expect(found).toBe(true);
    const pdf = await root.raw.get(`/companies/${co.id}/report/trial-balance?asOf=2026-12-31&format=pdf`).expect(200).buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(pdf.body).subarray(0, 5).toString()).toBe('%PDF-');
    // injection through a real report: supplier names appear in the expense report
    await root.post(`/companies/${co.id}/journals`, { date: '2026-09-01', post: true, lines: [{ ...jl(co.acct['6050'], '10.00'), contactId: (await prisma.contact.findFirstOrThrow({ where: { name: { startsWith: '=HYPER' } } })).id }, jl(co.acct['1010'], '0', '10.00')] }).expect(201);
    const ex = await root.get(`/companies/${co.id}/report/expenses?from=2026-01-01&to=2026-12-31&format=csv`).expect(200);
    expect(ex.text).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    const actions = await prisma.auditEvent.findMany({ where: { companyId: co.id, action: 'report.exported' } });
    expect(actions.map((a) => (a.metadata as { format: string }).format).sort()).toEqual(['csv', 'csv', 'pdf', 'xlsx']);
    expect(await prisma.auditEvent.count({ where: { companyId: co.id, action: 'report.exported', entityId: 'profit-loss' } })).toBe(1);
  });
  it('validates input, hides nothing behind 500s, and isolates companies', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await root.get(`/companies/${co.id}/report/profit-loss?from=2026-02-31&to=2026-12-31`).expect(400);
    await root.get(`/companies/${co.id}/report/nope`).expect(404);
    await root.get(`/companies/${co.id}/report/profit-loss?format=exe`).expect(400);
    await root.get(`/companies/${co.id}/report/general-ledger?accountId=00000000-0000-4000-8000-000000000000&from=2026-01-01&to=2026-12-31`).expect(404);
    await root.get(`/companies/${co.id}/report/general-ledger`).expect(400);
    expect((await root.get(`/companies/${co.id}/report`).expect(200)).body.map((c: { key: string }) => c.key)).toEqual(expect.arrayContaining(['profit-loss', 'tax-gst-hst', 'shopify-payouts']));
    await root.post('/admin/companies', { legalName: 'B Co', province: 'ON', ownerEmail: 'b@example.test', ownerName: 'B', ownerTemporaryPassword: PASSWORD }).expect(201);
    const b = agent(app);
    await b.post('/auth/login', { email: 'b@example.test', password: PASSWORD }).expect(200);
    await b.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' }).expect(204);
    await b.get(`/companies/${co.id}/report/profit-loss`).expect(404);
    await b.get(`/companies/${co.id}/report/profit-loss?format=csv`).expect(404);
    await b.get(`/companies/${co.id}/tax-periods`).expect(404);
    // employees have no report access at all
    await root.post(`/companies/${co.id}/members`, { email: 'emp@example.test', name: 'E', role: 'EMPLOYEE', temporaryPassword: PASSWORD }).expect(201);
    const e = agent(app);
    await e.post('/auth/login', { email: 'emp@example.test', password: PASSWORD }).expect(200);
    await e.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' }).expect(204);
    await e.get(`/companies/${co.id}/report/profit-loss`).expect(403);
    await e.get(`/companies/${co.id}/report/profit-loss?format=csv`).expect(403);
  });
});

describe('Shopify reports', () => {
  const SECRET = 'sec';
  const sign = (p: Record<string, string>) => createHmac('sha256', SECRET).update(Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join('&')).digest('hex');
  async function shopifyYear(root: A, co: Co) {
    const fake = newFake();
    shopifyFetch.fn = fakeShopifyFetch(fake);
    fake.orders = [ontarioOrder(), { ...ontarioOrder({ id: 'gid://shopify/Order/1002', name: '#1002', processedAt: '2026-10-06T15:00:00Z', updatedAt: '2026-10-09T00:00:00Z' }), refunds: [refund(1, '56.50', '6.50')] }];
    fake.payouts = [payoutNode(9001, '120.38')];
    fake.balanceTransactions = [btNode(1, 'CHARGE', '124.30', '3.92', '120.38'), btNode(2, 'TRANSFER', '-120.38', '0.00', '-120.38', { sourceType: 'TRANSFER' })];
    const { authorizeUrl } = (await root.post(`/companies/${co.id}/shopify/connect`, { shop: 'maple.myshopify.com' }).expect(201)).body;
    const p: Record<string, string> = { code: 'x', shop: 'maple.myshopify.com', state: new URL(authorizeUrl).searchParams.get('state')!, timestamp: '1' };
    await request(app.getHttpServer()).get('/shopify/callback').query({ ...p, hmac: sign(p) });
    const store = await prisma.shopifyStore.findFirstOrThrow();
    await prisma.shopifySyncJob.deleteMany({ where: { storeId: store.id } });
    const job = await prisma.shopifySyncJob.create({ data: { companyId: co.id, storeId: store.id, kind: 'INCREMENTAL', trigger: 'test' } });
    await app.get(ShopifySyncService).runJob(job.id, { finalAttempt: true });
  }
  it('sales summary, fees and payouts tie to the ledger; revenue by channel and the tax schedule include Shopify', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await shopifyYear(root, co);
    const s = await rep(root, co, 'shopify-sales', 'from=2026-01-01&to=2026-12-31');
    const t = s.sections[0].totals![0].cells;
    expect(t.orders).toBe(2);
    expect(t.sales).toBe('200.00'); // 2 × 100.00 of product sales
    expect(t.ship).toBe('20.00');
    expect(t.tax).toBe('28.60');
    expect(t.refunds).toBe('50.00');
    expect(t.net).toBe('170.00'); // 200 + 20 − 50
    allChecksOk(s);
    const fees = await rep(root, co, 'shopify-fees', 'from=2026-01-01&to=2026-12-31');
    expect(cell(fees, 0, 'Total', 'fees')).toBe('3.92');
    allChecksOk(fees);
    const po = await rep(root, co, 'shopify-payouts', 'from=2026-01-01&to=2026-12-31');
    expect(po.sections[0].rows[0].cells).toMatchObject({ charges: '124.30', fees: '3.92', net: '120.38', diff: '0.00', books: 'posted' });
    allChecksOk(po);
    const ch = await rep(root, co, 'revenue-by-channel', 'from=2026-01-01&to=2026-12-31');
    expect(cell(ch, 0, 'Shopify: maple.myshopify.com', 'amount')).toBe('170.00');
    allChecksOk(ch);
    const tax = await rep(root, co, 'tax-gst-hst', 'from=2026-01-01&to=2026-12-31');
    expect(tax.sections.some((x) => x.title?.includes('Shopify orders by tax name'))).toBe(true);
    allChecksOk(tax);
    const bs = await rep(root, co, 'balance-sheet', 'asOf=2026-12-31');
    allChecksOk(bs);
  });
  it('orders that are not posted are called out instead of silently missing', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const fake = newFake();
    shopifyFetch.fn = fakeShopifyFetch(fake);
    fake.orders = [ontarioOrder({ id: 'gid://shopify/Order/5', name: '#5', taxLines: [{ title: 'Eco fee', ratePercentage: 1, priceSet: { shopMoney: { amount: '14.30', currencyCode: 'CAD' } } }] })];
    const { authorizeUrl } = (await root.post(`/companies/${co.id}/shopify/connect`, { shop: 'maple.myshopify.com' }).expect(201)).body;
    const p: Record<string, string> = { code: 'x', shop: 'maple.myshopify.com', state: new URL(authorizeUrl).searchParams.get('state')!, timestamp: '1' };
    await request(app.getHttpServer()).get('/shopify/callback').query({ ...p, hmac: sign(p) });
    const store = await prisma.shopifyStore.findFirstOrThrow();
    await prisma.shopifySyncJob.deleteMany({ where: { storeId: store.id } });
    const job = await prisma.shopifySyncJob.create({ data: { companyId: co.id, storeId: store.id, kind: 'INCREMENTAL', trigger: 'test' } });
    await app.get(ShopifySyncService).runJob(job.id, { finalAttempt: true });
    const s = await rep(root, co, 'shopify-sales', 'from=2026-01-01&to=2026-12-31');
    const failed = s.checks.find((c) => !c.ok);
    expect(failed?.detail).toMatch(/1 order\(s\) are waiting or need review/);
  });
});
