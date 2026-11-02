import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@ca/database';
import type { Report } from '@ca/reporting';
import { PASSWORD, agent, bootApp, resetDb, setupAdmin } from './helpers';

let app: INestApplication;
let prisma: PrismaClient;
beforeAll(async () => ({ app, prisma } = await bootApp()));
afterAll(async () => { await prisma.$disconnect(); await app.close(); });
beforeEach(() => resetDb(prisma));

type A = ReturnType<typeof agent>;
interface FY { id: string; label: string; startDate: string; status: 'OPEN' | 'CLOSED'; closingEntryId: string | null }

async function company(root: A) {
  const c = (await root.post('/admin/companies', { legalName: 'Closing Co', province: 'ON', ownerEmail: 'root@example.test' }).expect(201)).body;
  for (const startDate of ['2025-01-01', '2026-01-01', '2027-01-01']) await root.post(`/companies/${c.id}/fiscal-years`, { startDate });
  const accts = (await root.get(`/companies/${c.id}/accounts`).expect(200)).body as { id: string; code: string }[];
  const acct = Object.fromEntries(accts.map((a) => [a.code, a.id])) as Record<string, string>;
  return { id: c.id as string, acct };
}
type Co = Awaited<ReturnType<typeof company>>;
const years = async (a: A, co: Co) => (await a.get(`/companies/${co.id}/fiscal-years`).expect(200)).body as FY[];
const fy = async (a: A, co: Co, label: string) => (await years(a, co)).find((y) => y.label.includes(label))!;
const journal = (a: A, co: Co, date: string, dr: string, cr: string, amount: string, post = true) =>
  a.post(`/companies/${co.id}/journals`, { date, post, lines: [{ accountId: co.acct[dr], debit: amount }, { accountId: co.acct[cr], credit: amount }] });
const report = async (a: A, co: Co, key: string, q: string) => (await a.get(`/companies/${co.id}/report/${key}?${q}`).expect(200)).body as Report;
const cell = (r: Report, title: string, label: string, key = 'cur') => {
  const s = r.sections.find((x) => x.title === title)!;
  const row = [...s.rows, ...(s.totals ?? [])].find((y) => String(y.cells.name ?? '').includes(label));
  return row?.cells[key] ?? null;
};
const okChecks = (r: Report) => expect(r.checks.filter((c) => !c.ok), JSON.stringify(r.checks.filter((c) => !c.ok))).toEqual([]);

/** 2026: revenue 1,000 and expenses 300 (+ 2025: revenue 50) — net income 700 for 2026. */
async function books(a: A, co: Co) {
  await journal(a, co, '2025-06-01', '1010', '4000', '50.00').expect(201);
  await journal(a, co, '2026-03-15', '1010', '4000', '1000.00').expect(201);
  await journal(a, co, '2026-05-20', '5000', '1010', '300.00').expect(201);
}

describe('year-end close', () => {
  it('previews, refuses out-of-order and draft-blocked closes, then closes: P&L unchanged, profit moved to retained earnings', async () => {
    const root = await setupAdmin(app);
    const co = await company(root);
    await books(root, co);
    const y25 = await fy(root, co, '2025'), y26 = await fy(root, co, '2026');

    const before = await report(root, co, 'balance-sheet', 'asOf=2026-12-31');
    expect(cell(before, 'Equity', 'Net income not yet closed')).toBe('750.00');

    // Years close in order.
    const early = await root.post(`/companies/${co.id}/fiscal-years/${y26.id}/close`);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('EARLIER_YEAR_OPEN');
    await root.post(`/companies/${co.id}/fiscal-years/${y25.id}/close`).expect(201);

    // A draft dated in the year blocks the close.
    const draft = (await journal(root, co, '2026-07-01', '5000', '1010', '10.00', false).expect(201)).body;
    const pv = (await root.get(`/companies/${co.id}/fiscal-years/${y26.id}/close-preview`).expect(200)).body;
    expect(pv.blockers.map((b: { code: string }) => b.code)).toEqual(['DRAFTS_IN_YEAR']);
    expect(pv.netIncome).toBe('700.00');
    expect(pv.lines.map((l: { account: { code: string }; debit: string; credit: string }) => [l.account.code, l.debit, l.credit])).toEqual([
      ['4000', '1000.00', '0'],
      ['5000', '0', '300.00'],
      ['3100', '0', '700.00'],
    ]);
    expect((await root.post(`/companies/${co.id}/fiscal-years/${y26.id}/close`)).body.code).toBe('DRAFTS_IN_YEAR');
    await root.delete(`/companies/${co.id}/journals/${draft.id}`).expect(204);

    const closed = (await root.post(`/companies/${co.id}/fiscal-years/${y26.id}/close`).expect(201)).body;
    expect(closed.netIncome).toBe('700.00');
    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: closed.closingEntry.id }, include: { lines: true } });
    expect(entry).toMatchObject({ status: 'POSTED', sourceType: 'year_end_close', sourceId: y26.id });
    expect(entry.date.toISOString().slice(0, 10)).toBe('2026-12-31');
    expect((await fy(root, co, '2026')).status).toBe('CLOSED');
    expect(await prisma.accountingPeriod.count({ where: { fiscalYearId: y26.id, status: 'OPEN' } })).toBe(0);

    // The P&L of a closed year still shows its results; the balance sheet totals are unchanged.
    const pl = await report(root, co, 'profit-loss', 'from=2026-01-01&to=2026-12-31');
    expect(cell(pl, 'Result', 'Net income')).toBe('700.00');
    okChecks(pl);
    const after = await report(root, co, 'balance-sheet', 'asOf=2026-12-31');
    expect(cell(after, 'Equity', 'Retained Earnings')).toBe('750.00');
    expect(cell(after, 'Equity', 'Net income not yet closed')).toBe('0.00');
    expect(cell(after, 'Equity', 'Total liabilities and equity')).toBe(cell(before, 'Equity', 'Total liabilities and equity'));
    okChecks(after);
    okChecks(await report(root, co, 'trial-balance', 'to=2026-12-31&asOf=2026-12-31'));
    okChecks(await report(root, co, 'cash-flow', 'from=2026-01-01&to=2026-12-31'));
    const tb = (await root.get(`/companies/${co.id}/reports/trial-balance?asOf=2026-12-31`).expect(200)).body;
    expect(JSON.stringify(tb)).toBeTruthy();
    // Revenue and expense accounts are back to zero once the year is closed.
    const sums = await prisma.journalLine.groupBy({ by: ['accountId'], where: { companyId: co.id, accountId: { in: [co.acct['4000'], co.acct['5000']] } }, _sum: { debit: true, credit: true } });
    for (const s of sums) expect(s._sum.debit!.toString()).toBe(s._sum.credit!.toString());
  });

  it('a closed year is frozen: no postings, no unlocking periods, no reversing the closing entry, no second close', async () => {
    const root = await setupAdmin(app);
    const co = await company(root);
    await books(root, co);
    const y25 = await fy(root, co, '2025'), y26 = await fy(root, co, '2026');
    await root.post(`/companies/${co.id}/fiscal-years/${y25.id}/close`).expect(201);
    const closed = (await root.post(`/companies/${co.id}/fiscal-years/${y26.id}/close`).expect(201)).body;

    const late = await journal(root, co, '2026-11-30', '5000', '1010', '5.00');
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('YEAR_CLOSED');
    const period = await prisma.accountingPeriod.findFirstOrThrow({ where: { fiscalYearId: y26.id } });
    expect((await root.patch(`/companies/${co.id}/periods/${period.id}`, { locked: false })).body.code).toBe('YEAR_CLOSED');
    expect((await root.post(`/companies/${co.id}/journals/${closed.closingEntry.id}/reverse`, {})).body.code).toBe('SOURCED');
    expect((await root.post(`/companies/${co.id}/fiscal-years/${y26.id}/close`)).body.code).toBe('ALREADY_CLOSED');
    // The next year is unaffected.
    await journal(root, co, '2027-01-05', '1010', '4000', '20.00').expect(201);
  });

  it('reopen reverses the close (newest year first), keeps the P&L, and leaves periods locked until unlocked', async () => {
    const root = await setupAdmin(app);
    const co = await company(root);
    await books(root, co);
    const y25 = await fy(root, co, '2025'), y26 = await fy(root, co, '2026');
    await root.post(`/companies/${co.id}/fiscal-years/${y25.id}/close`).expect(201);
    const closed = (await root.post(`/companies/${co.id}/fiscal-years/${y26.id}/close`).expect(201)).body;

    expect((await root.post(`/companies/${co.id}/fiscal-years/${y25.id}/reopen`)).body.code).toBe('LATER_YEAR_CLOSED');
    const reopened = (await root.post(`/companies/${co.id}/fiscal-years/${y26.id}/reopen`).expect(201)).body;
    const rev = await prisma.journalEntry.findUniqueOrThrow({ where: { id: reopened.reopenEntry.id } });
    expect(rev).toMatchObject({ sourceType: 'year_end_reopen', reversalOfId: closed.closingEntry.id });
    expect((await fy(root, co, '2026'))).toMatchObject({ status: 'OPEN', closingEntryId: null });

    const bs = await report(root, co, 'balance-sheet', 'asOf=2026-12-31');
    expect(cell(bs, 'Equity', 'Retained Earnings')).toBe('50.00'); // 2025 is still closed
    expect(cell(bs, 'Equity', 'Net income not yet closed')).toBe('700.00');
    expect(cell(await report(root, co, 'profit-loss', 'from=2026-01-01&to=2026-12-31'), 'Result', 'Net income')).toBe('700.00');

    // Periods stay locked after a reopen; unlocking one lets an adjustment in, and the year can be closed again.
    expect((await journal(root, co, '2026-12-15', '5000', '1010', '100.00')).body.code).toBe('PERIOD_LOCKED');
    const dec = await prisma.accountingPeriod.findFirstOrThrow({ where: { fiscalYearId: y26.id, label: { endsWith: '-12' } } });
    await root.patch(`/companies/${co.id}/periods/${dec.id}`, { locked: false }).expect(200);
    await journal(root, co, '2026-12-15', '5000', '1010', '100.00').expect(201);
    expect((await root.post(`/companies/${co.id}/fiscal-years/${y26.id}/close`).expect(201)).body.netIncome).toBe('600.00');
    expect(cell(await report(root, co, 'balance-sheet', 'asOf=2026-12-31'), 'Equity', 'Retained Earnings')).toBe('650.00');

    const actions = (await prisma.auditEvent.findMany({ where: { companyId: co.id, action: { startsWith: 'fiscal_year.' } } })).map((e) => e.action);
    expect(actions.filter((a) => a === 'fiscal_year.closed')).toHaveLength(3);
    expect(actions).toContain('fiscal_year.reopened');
  });

  it('a year with no revenue or expenses closes without a journal', async () => {
    const root = await setupAdmin(app);
    const co = await company(root);
    const y25 = await fy(root, co, '2025');
    const r = (await root.post(`/companies/${co.id}/fiscal-years/${y25.id}/close`).expect(201)).body;
    expect(r.closingEntry).toBeNull();
    expect((await fy(root, co, '2025')).status).toBe('CLOSED');
    await root.post(`/companies/${co.id}/fiscal-years/${y25.id}/reopen`).expect(201);
  });

  it('permissions: finance managers can close but not reopen; bookkeepers can do neither', async () => {
    const root = await setupAdmin(app);
    const co = await company(root);
    const y25 = await fy(root, co, '2025');
    const as = async (role: string) => {
      const email = `${role.toLowerCase()}@example.test`;
      await root.post(`/companies/${co.id}/members`, { email, name: role, role, temporaryPassword: PASSWORD }).expect(201);
      const a = agent(app);
      await a.post('/auth/login', { email, password: PASSWORD }).expect(200);
      await a.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' }).expect(204);
      return a;
    };
    const bk = await as('BOOKKEEPER');
    const fm = await as('FINANCE_MANAGER');
    await bk.post(`/companies/${co.id}/fiscal-years/${y25.id}/close`).expect(403);
    await fm.post(`/companies/${co.id}/fiscal-years/${y25.id}/close`).expect(201);
    await fm.post(`/companies/${co.id}/fiscal-years/${y25.id}/reopen`).expect(403);
    await root.post(`/companies/${co.id}/fiscal-years/${y25.id}/reopen`).expect(201);
  });
});

describe('cash-flow classification of accounts', () => {
  it('moves a balance-sheet account between sections, refuses revenue/expense accounts, and is audited', async () => {
    const root = await setupAdmin(app);
    const co = await company(root);
    await root.post(`/companies/${co.id}/banking/accounts`, { name: 'Chequing', kind: 'CHEQUING', mask: '0001', ledgerAccountId: co.acct['1010'] }).expect(201);
    // Buy equipment (1500 is investing by default in the template) and take a loan (2xxx liability).
    await journal(root, co, '2026-02-01', '1010', '3000', '5000.00').expect(201);
    await journal(root, co, '2026-03-01', '1500', '1010', '1200.00').expect(201);
    const loan = (await root.get(`/companies/${co.id}/accounts`).expect(200)).body.find((a: { type: string; role: string | null; code: string }) => a.type === 'LIABILITY' && !a.role && a.code.startsWith('2'));
    await journal(root, co, '2026-04-01', '1010', loan.code, '800.00').expect(201);
    const section = async (title: string) => (await report(root, co, 'cash-flow', 'from=2026-01-01&to=2026-12-31')).sections.find((s) => s.title?.toLowerCase().includes(title));
    const has = (s: Awaited<ReturnType<typeof section>>, label: string) => [...(s?.rows ?? [])].some((r) => String(r.cells.name ?? r.cells.item ?? '').includes(label));

    expect(has(await section('operating'), loan.name)).toBe(true);
    await root.patch(`/companies/${co.id}/accounts/${loan.id}`, { cashFlow: 'FINANCING' }).expect(200);
    expect(has(await section('financing'), loan.name)).toBe(true);
    expect(has(await section('operating'), loan.name)).toBe(false);
    okChecks(await report(root, co, 'cash-flow', 'from=2026-01-01&to=2026-12-31'));

    const bad = await root.patch(`/companies/${co.id}/accounts/${co.acct['4000']}`, { cashFlow: 'INVESTING' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_CASH_FLOW');
    await root.patch(`/companies/${co.id}/accounts/${loan.id}`, { cashFlow: null }).expect(200);
    const ev = await prisma.auditEvent.findMany({ where: { companyId: co.id, action: 'account.updated', entityId: loan.id }, orderBy: { createdAt: 'asc' } });
    expect(ev.map((e) => e.metadata)).toEqual([{ cashFlow: 'FINANCING', cashFlowFrom: null }, { cashFlow: null, cashFlowFrom: 'FINANCING' }]);
  });
});

describe('general ledger paging', () => {
  it('the screen gets pages of 500 lines with balances carried between pages; exports contain every line', async () => {
    const { LedgerService } = await import('../src/accounting/ledger.service');
    const root = await setupAdmin(app);
    const co = await company(root);
    const actorId = (await prisma.user.findFirstOrThrow()).id;
    const ledger = app.get(LedgerService);
    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < 1100; i++) {
        const amt = (1 + (i % 97)).toFixed(2);
        await ledger.post(tx, { companyId: co.id, date: `2026-0${1 + (i % 9)}-15`, sourceType: 'manual', lines: [{ accountId: co.acct['1010'], debit: amt, credit: '0' }, { accountId: co.acct['4000'], debit: '0', credit: amt }], actorId });
      }
    }, { timeout: 120_000 });
    const q = `accountId=${co.acct['1010']}&from=2026-01-01&to=2026-12-31`;
    const p1 = await report(root, co, 'general-ledger', q);
    const p2 = await report(root, co, 'general-ledger', `${q}&page=2`);
    const p3 = await report(root, co, 'general-ledger', `${q}&page=3`);
    expect(p1.paging).toEqual({ page: 1, pages: 3, pageSize: 500, total: 1100 });
    expect(p1.sections[0].rows).toHaveLength(501); // opening + 500
    expect(p3.sections[0].rows).toHaveLength(101); // brought forward + 100
    const carried = (r: Report) => r.sections[0].totals!.find((t) => t.cells.memo === 'Balance carried forward')!.cells.balance;
    const brought = (r: Report) => r.sections[0].rows[0].cells.balance;
    expect(brought(p2)).toBe(carried(p1));
    expect(brought(p3)).toBe(carried(p2));
    expect(p3.sections[0].rows.at(-1)!.cells.balance).toBe(p3.sections[0].totals!.at(-1)!.cells.balance);
    for (const r of [p1, p2, p3]) okChecks(r);
    const csv = (await root.raw.get(`/companies/${co.id}/report/general-ledger?${q}&format=csv`).expect(200)).text;
    expect(csv.split('\n').filter((l) => /^2026-\d\d-\d\d,\d/.test(l))).toHaveLength(1100); // data rows: date, then the journal number
  }, 180_000);
});
