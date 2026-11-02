import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@ca/database';
import type { Report } from '@ca/reporting';
import { LedgerService } from '../src/accounting/ledger.service';
import { PASSWORD, agent, bootApp, resetDb, setupAdmin } from './helpers';

/**
 * GST/HST Quick Method, checked against the worked example in CRA guide RC4058 (Rev. 25), "Al and Bob's Lumber Yard":
 * Q1 2025 eligible sales $9,000 (GST, Manitoba, 0% rate with a 2.8% credit) and $36,000 (HST, Ontario, 4.4% rate)
 *   line 103 = $1,584   line 106 = $252   line 107 = $300 (1% of the first $30,000)   remittance = $1,032
 */
let app: INestApplication;
let prisma: PrismaClient;
beforeAll(async () => ({ app, prisma } = await bootApp()));
afterAll(async () => { await prisma.$disconnect(); await app.close(); });
beforeEach(() => resetDb(prisma));

type A = ReturnType<typeof agent>;
async function company(root: A) {
  const c = (await root.post('/admin/companies', { legalName: 'Al and Bob Lumber', province: 'ON', ownerEmail: 'root@example.test' }).expect(201)).body;
  for (const startDate of ['2025-01-01', '2026-01-01']) await root.post(`/companies/${c.id}/fiscal-years`, { startDate });
  const accts = (await root.get(`/companies/${c.id}/accounts`).expect(200)).body as { id: string; code: string }[];
  const codes = (await root.get(`/companies/${c.id}/tax-codes`).expect(200)).body as { id: string; code: string }[];
  const customer = (await root.post(`/companies/${c.id}/contacts`, { kind: 'CUSTOMER', name: 'Customer' }).expect(201)).body.id;
  const reg = (await root.post(`/companies/${c.id}/tax-registrations`, { kind: 'GST_HST', registrationNumber: '123456789RT0001', filingFrequency: 'QUARTERLY', effectiveFrom: '2020-01-01' }).expect(201)).body;
  return { id: c.id as string, acct: Object.fromEntries(accts.map((a) => [a.code, a.id])) as Record<string, string>, tax: Object.fromEntries(codes.map((a) => [a.code, a.id])) as Record<string, string>, customer, reg: reg.id as string };
}
type Co = Awaited<ReturnType<typeof company>>;
/** A tax-inclusive invoice: `incl` is the amount the customer pays, GST/HST included. */
async function sale(a: A, co: Co, date: string, incl: string, code: string) {
  const inv = (await a.post(`/companies/${co.id}/invoices`, { contactId: co.customer, issueDate: date, dueDate: date, taxInclusive: true, lines: [{ description: 'Lumber', quantity: '1', unitPrice: incl, accountId: co.acct['4000'], taxCodeId: co.tax[code] }] }).expect(201)).body;
  await a.post(`/companies/${co.id}/invoices/${inv.id}/post`).expect(201);
}
const gst = async (a: A, co: Co, from: string, to: string, extra = '') => (await a.get(`/companies/${co.id}/report/tax-gst-hst?from=${from}&to=${to}${extra}`).expect(200)).body as Report;
const line = (r: Report, n: string) => r.sections.find((s) => s.title?.startsWith('Return preparation'))!.rows.find((x) => x.cells.line === n)!.cells.amount;
const RATES = { GST: { rate: '0', credit: '0.028' }, HST_ON: { rate: '0.044' } };

describe('GST/HST Quick Method', () => {
  it("reproduces CRA's worked example (RC4058): 103 = 1,584, 106 = 252, 107 = 300, net tax 1,032", async () => {
    const root = await setupAdmin(app);
    const co = await company(root);
    await root.patch(`/companies/${co.id}/tax-registrations/${co.reg}/quick-method`, { from: '2024-01-01', rates: RATES }).expect(200);
    await sale(root, co, '2025-02-10', '9000.00', 'GST');
    await sale(root, co, '2025-03-05', '36000.00', 'HST_ON');
    await sale(root, co, '2025-03-20', '500.00', 'ZERO'); // zero-rated: not part of the calculation

    const r = await gst(root, co, '2025-01-01', '2025-03-31');
    expect(line(r, '101')).toBe('45000.00');
    expect(line(r, '103')).toBe('1584.00');
    expect(line(r, '106')).toBe('252.00');
    expect(line(r, '107')).toBe('300.00');
    expect(line(r, '109')).toBe('1032.00');
    expect(r.sections.find((s) => s.title?.startsWith('Quick Method calculation'))).toBeTruthy();
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    // Books: all GST/HST collected (428.57 + 4,141.59) stays payable until this entry is posted; the difference is income.
    const entry = r.sections.find((s) => s.title?.startsWith('Suggested entry'))!;
    expect(entry.rows.map((x) => [x.cells.debit ?? null, x.cells.credit ?? null])).toEqual([['4570.16', null], [null, '0.00'], [null, '1032.00'], [null, '3538.16']]);
  });

  it('the 1% credit covers only the first $30,000 of a fiscal year, and only if the election was in effect at its start', async () => {
    const root = await setupAdmin(app);
    const co = await company(root);
    await root.patch(`/companies/${co.id}/tax-registrations/${co.reg}/quick-method`, { from: '2025-01-01', rates: { HST_ON: { rate: '0.044' } } }).expect(200);
    await sale(root, co, '2025-02-01', '20000.00', 'HST_ON');
    await sale(root, co, '2025-05-01', '20000.00', 'HST_ON');
    await sale(root, co, '2025-08-01', '20000.00', 'HST_ON');
    expect(line(await gst(root, co, '2025-01-01', '2025-03-31'), '107')).toBe('200.00');
    expect(line(await gst(root, co, '2025-04-01', '2025-06-30'), '107')).toBe('100.00');
    expect(line(await gst(root, co, '2025-07-01', '2025-09-30'), '107')).toBe('0.00');

    // An election that starts mid-year gets no 1% credit that year (not a new registrant).
    await root.patch(`/companies/${co.id}/tax-registrations/${co.reg}/quick-method`, { from: '2025-04-01', rates: { HST_ON: { rate: '0.044' } } }).expect(200);
    expect(line(await gst(root, co, '2025-04-01', '2025-06-30'), '107')).toBe('0.00');
    // A period that straddles the start of the election is flagged.
    expect((await gst(root, co, '2025-01-01', '2025-06-30')).checks.some((c) => !c.ok && /starts inside this period/.test(c.label))).toBe(true);
  });

  it('codes without a rate are reported in full; capital ITCs and user adjustments flow to 106/107; other sales need their rate', async () => {
    const root = await setupAdmin(app);
    const co = await company(root);
    await root.patch(`/companies/${co.id}/tax-registrations/${co.reg}/quick-method`, { from: '2024-01-01', rates: { HST_ON: { rate: '0.044' } } }).expect(200);
    await sale(root, co, '2025-02-01', '11300.00', 'HST_ON');
    await sale(root, co, '2025-02-15', '1050.00', 'GST'); // no rate recorded for GST: treated as not eligible, tax 50.00 in full
    // GST/HST collected from a bank receipt (not an invoice): cannot be split by rate automatically.
    const payable = (await prisma.account.findFirstOrThrow({ where: { companyId: co.id, role: 'GST_HST_PAYABLE' } })).id;
    const actorId = (await prisma.user.findFirstOrThrow()).id;
    await prisma.$transaction((tx) => app.get(LedgerService).post(tx, { companyId: co.id, date: '2025-03-01', sourceType: 'bank_txn', lines: [{ accountId: co.acct['1010'], debit: '113.00', credit: '0' }, { accountId: co.acct['4000'], debit: '0', credit: '100.00' }, { accountId: payable, debit: '0', credit: '13.00' }], actorId }));

    const r1 = await gst(root, co, '2025-01-01', '2025-03-31', '&itcCapital=65.00&adj107=10.00');
    expect(line(r1, '101')).toBe('11300.00');
    expect(line(r1, '103')).toBe(String((497.2 + 50).toFixed(2))); // 11,300 × 4.4% + 50.00
    expect(line(r1, '106')).toBe('65.00');
    expect(line(r1, '107')).toBe('123.00'); // 1% of 11,300 + 10.00
    const bad = r1.checks.find((c) => !c.ok)!;
    expect(bad.detail).toMatch(/13\.00 of GST\/HST was collected outside invoices/);

    const r2 = await gst(root, co, '2025-01-01', '2025-03-31', '&qmOtherSales=113.00&qmOtherRate=0.044');
    expect(line(r2, '101')).toBe('11413.00');
    expect(line(r2, '103')).toBe('552.17'); // (11,300 + 113) × 4.4% = 502.17, + 50.00 not eligible
    expect(r2.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('the election is validated, audited and needs the taxes:create permission; turning it off restores the regular method', async () => {
    const root = await setupAdmin(app);
    const co = await company(root);
    const url = `/companies/${co.id}/tax-registrations/${co.reg}/quick-method`;
    expect((await root.patch(url, { from: '2024-01-01', rates: { NOPE: { rate: '0.01' } } })).body.code).toBe('UNKNOWN_TAX_CODE');
    expect((await root.patch(url, { from: '2019-01-01', rates: {} })).body.code).toBe('BEFORE_REGISTRATION');
    await root.patch(url, { from: '2024-01-01', rates: { HST_ON: { rate: '0.25' } } }).expect(400);
    const qst = (await root.post(`/companies/${co.id}/tax-registrations`, { kind: 'QST', registrationNumber: '1234567890TQ0001', filingFrequency: 'QUARTERLY', effectiveFrom: '2020-01-01' })).body;
    if (qst.id) expect((await root.patch(`/companies/${co.id}/tax-registrations/${qst.id}/quick-method`, { from: '2024-01-01', rates: {} })).body.code).toBe('NOT_GST_HST');

    await root.post(`/companies/${co.id}/members`, { email: 'bk@example.test', name: 'BK', role: 'BOOKKEEPER', temporaryPassword: PASSWORD }).expect(201);
    const bk = agent(app);
    await bk.post('/auth/login', { email: 'bk@example.test', password: PASSWORD }).expect(200);
    await bk.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' }).expect(204);
    await bk.patch(url, { from: '2024-01-01', rates: RATES }).expect(403);

    await root.patch(url, { from: '2024-01-01', rates: RATES }).expect(200);
    await sale(root, co, '2025-02-10', '11300.00', 'HST_ON');
    expect(line(await gst(root, co, '2025-01-01', '2025-03-31'), '103')).toBe('497.20');
    await root.patch(url, { from: null, rates: {} }).expect(200);
    const regular = await gst(root, co, '2025-01-01', '2025-03-31');
    expect(line(regular, '101')).toBe('10000.00');
    expect(line(regular, '103')).toBe('1300.00');
    const ev = await prisma.auditEvent.findMany({ where: { companyId: co.id, action: 'tax_registration.quick_method' }, orderBy: { createdAt: 'asc' } });
    expect(ev).toHaveLength(2);
    expect((ev[1].metadata as { before: { from: string } }).before.from).toBe('2024-01-01');
  });
});
