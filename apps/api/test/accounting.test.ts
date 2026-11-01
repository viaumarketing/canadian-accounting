import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@ca/database';
import { PASSWORD, agent, bootApp, resetDb, setupAdmin } from './helpers';

let app: INestApplication;
let prisma: PrismaClient;
beforeAll(async () => ({ app, prisma } = await bootApp()));
afterAll(async () => { await prisma.$disconnect(); await app.close(); });
beforeEach(() => resetDb(prisma));

type A = ReturnType<typeof agent>;
interface Co { id: string; root: A; acct: Record<string, string>; tax: Record<string, string>; customer: string; vendor: string }

async function makeCompany(root: A, name = 'Maple Goods Inc.', province = 'ON', ownerEmail = 'root@example.test', extra: object = {}): Promise<Co> {
  const c = (await root.post('/admin/companies', { legalName: name, province, ownerEmail, ...extra }).expect(201)).body;
  await root.post(`/companies/${c.id}/fiscal-years`, { startDate: '2026-01-01' }); // 409 when 2026 is already the current year
  return loadCo(root, c.id);
}
async function loadCo(a: A, id: string): Promise<Co> {
  const accts = (await a.get(`/companies/${id}/accounts`).expect(200)).body as { id: string; code: string }[];
  const codes = (await a.get(`/companies/${id}/tax-codes`).expect(200)).body as { id: string; code: string }[];
  const customer = (await a.post(`/companies/${id}/contacts`, { kind: 'CUSTOMER', name: 'Acme Customer', province: 'ON' }).expect(201)).body.id;
  const vendor = (await a.post(`/companies/${id}/contacts`, { kind: 'VENDOR', name: 'Acme Supplier' }).expect(201)).body.id;
  return { id, root: a, acct: Object.fromEntries(accts.map((x) => [x.code, x.id])), tax: Object.fromEntries(codes.map((x) => [x.code, x.id])), customer, vendor };
}
async function member(root: A, co: Co, role: string, email = `${role.toLowerCase()}@example.test`): Promise<A> {
  await root.post(`/companies/${co.id}/members`, { email, name: role, role, temporaryPassword: PASSWORD }).expect(201);
  const a = agent(app);
  await a.post('/auth/login', { email, password: PASSWORD }).expect(200);
  await a.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' }).expect(204);
  return a;
}
const jl = (accountId: string, debit: string, credit = '0') => ({ accountId, debit, credit });
const tb = async (co: Co, asOf = '2026-12-31') => (await co.root.get(`/companies/${co.id}/reports/trial-balance?asOf=${asOf}`).expect(200)).body;
const bal = (t: { rows: { code: string; debit: string; credit: string }[] }, code: string) => { const r = t.rows.find((x) => x.code === code); return r ? (Number(r.debit) - Number(r.credit)).toFixed(2) : '0.00'; };
const invoiceBody = (co: Co, over: object = {}) => ({ contactId: co.customer, issueDate: '2026-06-15', dueDate: '2026-07-15', lines: [{ description: 'Maple syrup', quantity: '2', unitPrice: '50.00', accountId: co.acct['4000'], taxCodeId: co.tax.HST_ON }], ...over });
async function postedInvoice(co: Co, over: object = {}) {
  const inv = (await co.root.post(`/companies/${co.id}/invoices`, invoiceBody(co, over)).expect(201)).body;
  return (await co.root.post(`/companies/${co.id}/invoices/${inv.id}/post`).expect(201)).body;
}

describe('company accounting setup', () => {
  it('provisioning seeds chart of accounts, tax codes with rates, and monthly periods', async () => {
    const root = await setupAdmin(app);
    const co = await makeCompany(root);
    expect(Object.keys(co.acct)).toEqual(expect.arrayContaining(['1100', '2000', '2200', '3100', '4000']));
    expect(Object.keys(co.tax)).toEqual(expect.arrayContaining(['HST_ON', 'GST_QST', 'ZERO', 'EXEMPT']));
    const periods = (await root.get(`/companies/${co.id}/periods`).expect(200)).body;
    expect(periods).toHaveLength(12);
    const codes = (await root.get(`/companies/${co.id}/tax-codes`).expect(200)).body;
    expect(codes.find((c: { code: string }) => c.code === 'HST_NS').rates).toHaveLength(2);
    expect(codes.find((c: { code: string }) => c.code === 'GST_QST').rates.some((r: { source: string }) => /UNVERIFIED/.test(r.source))).toBe(true);
  });
  it('setup endpoint is idempotent', async () => {
    const root = await setupAdmin(app);
    const co = await makeCompany(root);
    const before = await prisma.account.count({ where: { companyId: co.id } });
    await root.post(`/companies/${co.id}/accounting/setup`).expect(204);
    expect(await prisma.account.count({ where: { companyId: co.id } })).toBe(before);
  });
});

describe('journals', () => {
  it('posts balanced entries with gap-free numbers and rejects unbalanced ones', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    const post = (lines: object[], date = '2026-03-01') => root.post(`/companies/${co.id}/journals`, { date, lines, post: true });
    const j1 = (await post([jl(co.acct['1010'], '100.00'), jl(co.acct['3000'], '0', '100.00')]).expect(201)).body;
    expect(j1.number).toBe(1);
    const bad = await post([jl(co.acct['1010'], '100.00'), jl(co.acct['3000'], '0', '99.99')]);
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('UNBALANCED');
    const j2 = (await post([jl(co.acct['1010'], '5.00'), jl(co.acct['3000'], '0', '5.00')]).expect(201)).body;
    expect(j2.number).toBe(2); // failed attempt consumed no number
  });
  it('concurrent postings get unique consecutive numbers', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => root.post(`/companies/${co.id}/journals`, { date: '2026-03-01', lines: [jl(co.acct['1010'], `${i + 1}.00`), jl(co.acct['3000'], '0', `${i + 1}.00`)], post: true })));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(rs.map((r) => r.body.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('drafts can be saved, posted later, or deleted; bookkeepers can draft but not post', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    const bk = await member(root, co, 'BOOKKEEPER');
    const lines = [jl(co.acct['1010'], '10.00'), jl(co.acct['3000'], '0', '10.00')];
    await bk.post(`/companies/${co.id}/journals`, { date: '2026-03-01', lines, post: true }).expect(403);
    const draft = (await bk.post(`/companies/${co.id}/journals`, { date: '2026-03-01', lines }).expect(201)).body;
    expect(draft.status).toBe('DRAFT');
    await bk.post(`/companies/${co.id}/journals/${draft.id}/post`).expect(403);
    const posted = (await root.post(`/companies/${co.id}/journals/${draft.id}/post`).expect(201)).body;
    expect(posted.status).toBe('POSTED');
    const d2 = (await bk.post(`/companies/${co.id}/journals`, { date: '2026-03-01', lines }).expect(201)).body;
    await bk.delete(`/companies/${co.id}/journals/${d2.id}`).expect(204);
    await root.delete(`/companies/${co.id}/journals/${posted.id}`).expect(403);
  });
  it('posted entries are immutable in the DATABASE, not just the API', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    const j = (await root.post(`/companies/${co.id}/journals`, { date: '2026-03-01', lines: [jl(co.acct['1010'], '100.00'), jl(co.acct['3000'], '0', '100.00')], post: true }).expect(201)).body;
    await expect(prisma.$executeRawUnsafe(`UPDATE "JournalEntry" SET memo='x' WHERE id='${j.id}'`)).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE id='${j.id}'`)).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "JournalLine" SET debit=999 WHERE "entryId"='${j.id}'`)).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "entryId"='${j.id}'`)).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRawUnsafe(`INSERT INTO "JournalLine"(id,"entryId","companyId","lineNo","accountId",debit,credit) VALUES (gen_random_uuid(),'${j.id}','${co.id}',9,'${co.acct['1010']}',1,0)`)).rejects.toThrow(/immutable/);
  });
  it('the database refuses to post an unbalanced entry or a two-sided line even if the API were bypassed', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    const e = await prisma.journalEntry.create({ data: { companyId: co.id, date: new Date('2026-03-01'), createdById: co.id } });
    await prisma.journalLine.create({ data: { entryId: e.id, companyId: co.id, lineNo: 1, accountId: co.acct['1010'], debit: '10', credit: '0' } });
    await prisma.journalLine.create({ data: { entryId: e.id, companyId: co.id, lineNo: 2, accountId: co.acct['3000'], debit: '0', credit: '9' } });
    await expect(prisma.$executeRawUnsafe(`UPDATE "JournalEntry" SET status='POSTED', number=1, "postedAt"=now() WHERE id='${e.id}'`)).rejects.toThrow(/Unbalanced/);
    await expect(prisma.journalLine.create({ data: { entryId: e.id, companyId: co.id, lineNo: 3, accountId: co.acct['3000'], debit: '5', credit: '5' } })).rejects.toThrow();
    await expect(prisma.journalEntry.create({ data: { companyId: co.id, date: new Date('2026-03-01'), createdById: co.id, status: 'POSTED' } })).rejects.toThrow(/DRAFT/);
  });
  it('reversal mirrors the entry, nets accounts to zero, and cannot be repeated', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    const j = (await root.post(`/companies/${co.id}/journals`, { date: '2026-03-01', lines: [jl(co.acct['6010'], '40.00'), jl(co.acct['1010'], '0', '40.00')], post: true }).expect(201)).body;
    expect(bal(await tb(co), '6010')).toBe('40.00');
    const rev = (await root.post(`/companies/${co.id}/journals/${j.id}/reverse`, {}).expect(201)).body;
    expect(rev.reversalOfId).toBe(j.id);
    const t = await tb(co);
    expect(bal(t, '6010')).toBe('0.00');
    expect(t.totals.balanced).toBe(true);
    await root.post(`/companies/${co.id}/journals/${j.id}/reverse`, {}).expect(409);
    await root.post(`/companies/${co.id}/journals/${rev.id}/reverse`, {}).expect(409);
    const bk = await member(root, co, 'BOOKKEEPER');
    await bk.post(`/companies/${co.id}/journals/${j.id}/reverse`, {}).expect(403);
  });
  it('locked periods and uncovered dates reject postings', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    const periods = (await root.get(`/companies/${co.id}/periods`).expect(200)).body as { id: string; label: string }[];
    const mar = periods.find((p) => p.label === '2026-03')!;
    await root.patch(`/companies/${co.id}/periods/${mar.id}`, { locked: true }).expect(200);
    const lines = [jl(co.acct['1010'], '1.00'), jl(co.acct['3000'], '0', '1.00')];
    expect((await root.post(`/companies/${co.id}/journals`, { date: '2026-03-10', lines, post: true })).body.code).toBe('PERIOD_LOCKED');
    expect((await root.post(`/companies/${co.id}/journals`, { date: '2019-03-10', lines, post: true })).body.code).toBe('NO_PERIOD');
    await root.patch(`/companies/${co.id}/periods/${mar.id}`, { locked: false }).expect(200);
    await root.post(`/companies/${co.id}/journals`, { date: '2026-03-10', lines, post: true }).expect(201);
  });
});

describe('sales: invoices, tax and A/R', () => {
  it('Ontario HST invoice posts A/R, revenue and GST/HST payable; trial balance balances', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    const inv = await postedInvoice(co);
    expect(inv.number).toBe('INV-0001');
    expect([inv.subtotal, inv.taxTotal, inv.total]).toEqual(['100', '13', '113']);
    const t = await tb(co);
    expect(bal(t, '1100')).toBe('113.00');
    expect(bal(t, '4000')).toBe('-100.00');
    expect(bal(t, '2200')).toBe('-13.00');
    expect(t.totals).toMatchObject({ debit: '113.00', credit: '113.00', balanced: true });
  });
  it('Quebec tax-inclusive invoice splits GST and QST correctly', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root, 'Érablière', 'QC');
    await postedInvoice(co, { taxInclusive: true, lines: [{ description: 'Sirop', quantity: '1', unitPrice: '114.98', accountId: co.acct['4000'], taxCodeId: co.tax.GST_QST }] });
    const t = await tb(co);
    expect(bal(t, '4000')).toBe('-100.00');
    expect(bal(t, '2200')).toBe('-5.00');
    expect(bal(t, '2210')).toBe('-9.98');
    expect(bal(t, '1100')).toBe('114.98');
  });
  it('rate is chosen by the transaction date (Nova Scotia 15% → 14% on 2025-04-01)', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root, 'Halifax Co', 'NS');
    await root.post(`/companies/${co.id}/fiscal-years`, { startDate: '2025-01-01' }).expect(201);
    const mk = (d: string) => root.post(`/companies/${co.id}/invoices`, invoiceBody(co, { issueDate: d, dueDate: d, lines: [{ description: 'x', quantity: '1', unitPrice: '100.00', accountId: co.acct['4000'], taxCodeId: co.tax.HST_NS }] })).expect(201);
    expect((await mk('2025-03-31')).body.taxTotal).toBe('15');
    expect((await mk('2025-04-01')).body.taxTotal).toBe('14');
  });
  it('zero-rated and exempt supplies carry no tax; a taxable code with no rate in force is refused, not charged 0%', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    const line = (code: string) => ({ description: 'x', quantity: '1', unitPrice: '10.00', accountId: co.acct['4000'], taxCodeId: co.tax[code] });
    expect((await root.post(`/companies/${co.id}/invoices`, invoiceBody(co, { lines: [line('ZERO')] })).expect(201)).body.taxTotal).toBe('0');
    expect((await root.post(`/companies/${co.id}/invoices`, invoiceBody(co, { lines: [line('EXEMPT')] })).expect(201)).body.taxTotal).toBe('0');
    await root.post(`/companies/${co.id}/fiscal-years`, { startDate: '2007-01-01' }).expect(201);
    const r = await root.post(`/companies/${co.id}/invoices`, invoiceBody(co, { issueDate: '2007-06-01', dueDate: '2007-06-01', lines: [line('GST')] }));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('NO_RATE');
  });
  it('credit notes mirror the invoice; void reverses an unpaid invoice', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    const inv = await postedInvoice(co);
    const cn = await postedInvoice(co, { kind: 'CREDIT', lines: [{ description: 'return', quantity: '1', unitPrice: '10.00', accountId: co.acct['4000'], taxCodeId: co.tax.HST_ON }] });
    expect(cn.number).toBe('CN-0001');
    expect(bal(await tb(co), '1100')).toBe('101.70');
    await root.post(`/companies/${co.id}/invoices/${inv.id}/void`).expect(201);
    expect(bal(await tb(co), '1100')).toBe('-11.30');
  });
  it('line accounts must be revenue and not control accounts; foreign contacts are rejected', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    const line = (acc: string) => [{ description: 'x', quantity: '1', unitPrice: '10.00', accountId: co.acct[acc], taxCodeId: co.tax.ZERO }];
    expect((await root.post(`/companies/${co.id}/invoices`, invoiceBody(co, { lines: line('6010') }))).body.code).toBe('INVALID_ACCOUNT');
    expect((await root.post(`/companies/${co.id}/invoices`, invoiceBody(co, { lines: line('1100') }))).body.code).toBe('INVALID_ACCOUNT');
    expect((await root.post(`/companies/${co.id}/invoices`, invoiceBody(co, { contactId: co.vendor }))).body.code).toBe('INVALID_CONTACT');
  });
});

describe('purchases: bills and input tax credits', () => {
  it('BC bill: GST is an ITC, PST is non-recoverable and capitalised into the expense', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root, 'Vancouver Co', 'BC');
    const bill = (await root.post(`/companies/${co.id}/bills`, { contactId: co.vendor, issueDate: '2026-06-01', dueDate: '2026-07-01', supplierRef: 'V-77', lines: [{ description: 'Laptop', quantity: '1', unitPrice: '200.00', accountId: co.acct['6050'], taxCodeId: co.tax.GST_PST_BC }] }).expect(201)).body;
    const posted = (await root.post(`/companies/${co.id}/bills/${bill.id}/post`).expect(201)).body;
    expect(posted.number).toBe('BILL-0001');
    const t = await tb(co);
    expect(bal(t, '1150')).toBe('10.00');
    expect(bal(t, '6050')).toBe('214.00');
    expect(bal(t, '2000')).toBe('-224.00');
    expect(t.totals.balanced).toBe(true);
  });
  it('vendor credit mirrors a bill', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    const mk = async (kind: string) => { const b = (await root.post(`/companies/${co.id}/bills`, { kind, contactId: co.vendor, issueDate: '2026-06-01', dueDate: '2026-07-01', lines: [{ description: 'x', quantity: '1', unitPrice: '100.00', accountId: co.acct['6050'], taxCodeId: co.tax.HST_ON }] }).expect(201)).body; return (await root.post(`/companies/${co.id}/bills/${b.id}/post`).expect(201)).body; };
    await mk('STANDARD');
    expect((await mk('CREDIT')).number).toBe('VC-0001');
    const t = await tb(co);
    expect(bal(t, '2000')).toBe('0.00');
    expect(bal(t, '6050')).toBe('0.00');
  });
});

describe('payments and allocations', () => {
  it('partial then full payment updates status; over-allocation and mismatches are refused', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    const inv = await postedInvoice(co); // 113.00
    const pay = (amount: string, alloc = amount) => root.post(`/companies/${co.id}/payments`, { direction: 'RECEIPT', contactId: co.customer, bankAccountId: co.acct['1010'], date: '2026-06-20', amount, allocations: [{ documentId: inv.id, amount: alloc }] });
    await pay('50.00').expect(201);
    expect((await root.get(`/companies/${co.id}/invoices/${inv.id}`).expect(200)).body).toMatchObject({ status: 'PARTIAL', amountPaid: '50' });
    expect((await pay('64.00')).body.code).toBe('OVER_ALLOCATION');
    expect((await pay('10.00', '9.00')).body.code).toBe('ALLOCATION_MISMATCH');
    await pay('63.00').expect(201);
    expect((await root.get(`/companies/${co.id}/invoices/${inv.id}`).expect(200)).body.status).toBe('PAID');
    const t = await tb(co);
    expect(bal(t, '1100')).toBe('0.00');
    expect(bal(t, '1010')).toBe('113.00');
  });
  it('two simultaneous payments cannot both consume the same balance', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    const inv = await postedInvoice(co);
    const rs = await Promise.all([1, 2].map(() => root.post(`/companies/${co.id}/payments`, { direction: 'RECEIPT', contactId: co.customer, bankAccountId: co.acct['1010'], date: '2026-06-20', amount: '113.00', allocations: [{ documentId: inv.id, amount: '113.00' }] })));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(Number((await tb(co)).rows.find((r: { code: string }) => r.code === '1010').debit)).toBe(113);
  });
  it('voiding a payment restores the invoice; an invoice with payments cannot be voided', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    const inv = await postedInvoice(co);
    const p = (await root.post(`/companies/${co.id}/payments`, { direction: 'RECEIPT', contactId: co.customer, bankAccountId: co.acct['1010'], date: '2026-06-20', amount: '113.00', allocations: [{ documentId: inv.id, amount: '113.00' }] }).expect(201)).body;
    await root.post(`/companies/${co.id}/invoices/${inv.id}/void`).expect(409);
    await root.post(`/companies/${co.id}/payments/${p.id}/void`, {}).expect(201);
    expect((await root.get(`/companies/${co.id}/invoices/${inv.id}`).expect(200)).body).toMatchObject({ status: 'POSTED', amountPaid: '0' });
    expect(bal(await tb(co), '1010')).toBe('0.00');
    await root.post(`/companies/${co.id}/payments/${p.id}/void`, {}).expect(409);
  });
  it('supplier payment: bill → paid', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    const b = (await root.post(`/companies/${co.id}/bills`, { contactId: co.vendor, issueDate: '2026-06-01', dueDate: '2026-07-01', lines: [{ description: 'x', quantity: '1', unitPrice: '100.00', accountId: co.acct['6050'], taxCodeId: co.tax.HST_ON }] }).expect(201)).body;
    await root.post(`/companies/${co.id}/bills/${b.id}/post`).expect(201);
    await root.post(`/companies/${co.id}/payments`, { direction: 'DISBURSEMENT', contactId: co.vendor, bankAccountId: co.acct['1010'], date: '2026-06-20', amount: '113.00', allocations: [{ documentId: b.id, amount: '113.00' }] }).expect(201);
    expect((await root.get(`/companies/${co.id}/bills/${b.id}`).expect(200)).body.status).toBe('PAID');
    expect(bal(await tb(co), '2000')).toBe('0.00');
  });
});

describe('expenses', () => {
  it('employee submits, a different approver approves, an accountant posts; own expenses cannot be self-approved', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    const emp = await member(root, co, 'EMPLOYEE');
    const acc = await member(root, co, 'ACCOUNTANT');
    const body = { date: '2026-06-10', description: 'Client lunch', paidFromAccountId: co.acct['1010'], taxInclusive: true, lines: [{ description: 'Lunch', amount: '113.00', accountId: co.acct['6110'], taxCodeId: co.tax.HST_ON }] };
    const e = (await emp.post(`/companies/${co.id}/expenses`, body).expect(201)).body;
    expect([e.subtotal, e.taxTotal, e.total]).toEqual(['100', '13', '113']);
    await emp.post(`/companies/${co.id}/expenses/${e.id}/approve`, {}).expect(403);
    await acc.post(`/companies/${co.id}/expenses/${e.id}/post`, {}).expect(409); // not approved yet
    await acc.post(`/companies/${co.id}/expenses/${e.id}/approve`, {}).expect(201);
    await acc.post(`/companies/${co.id}/expenses/${e.id}/post`, {}).expect(201);
    const t = await tb(co);
    expect(bal(t, '6110')).toBe('100.00');
    expect(bal(t, '1150')).toBe('13.00');
    expect(bal(t, '1010')).toBe('-113.00');
    const own = (await acc.post(`/companies/${co.id}/expenses`, body).expect(201)).body;
    expect((await acc.post(`/companies/${co.id}/expenses/${own.id}/approve`, {})).body.code).toBe('SEPARATION_OF_DUTIES');
    // employees see only their own expenses
    await acc.post(`/companies/${co.id}/expenses`, body).expect(201);
    expect((await emp.get(`/companies/${co.id}/expenses`).expect(200)).body).toHaveLength(1);
    expect((await acc.get(`/companies/${co.id}/expenses`).expect(200)).body.length).toBeGreaterThan(1);
  });
});

describe('isolation and permissions (milestone 2 routes)', () => {
  it('another company cannot read or reference this company\'s accounting data', async () => {
    const root = await setupAdmin(app);
    const a = await makeCompany(root, 'A Co');
    const bOwner = { ownerEmail: 'b-owner@example.test', ownerName: 'B Owner', ownerTemporaryPassword: PASSWORD };
    const b = (await root.post('/admin/companies', { legalName: 'B Co', province: 'ON', ...bOwner }).expect(201)).body;
    const bAgent = agent(app);
    await bAgent.post('/auth/login', { email: 'b-owner@example.test', password: PASSWORD }).expect(200);
    await bAgent.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' }).expect(204);
    const inv = await postedInvoice(a);
    for (const path of ['accounts', 'journals', 'invoices', `invoices/${inv.id}`, 'bills', 'payments', 'expenses', 'contacts', 'tax-codes', 'periods', 'reports/trial-balance']) {
      await bAgent.get(`/companies/${a.id}/${path}`).expect(404);
    }
    // B using A's ids inside B's own company is rejected
    const bCo = await loadCo(bAgent, b.id);
    const lines = [{ description: 'x', quantity: '1', unitPrice: '1.00', accountId: a.acct['4000'], taxCodeId: bCo.tax.ZERO }];
    expect((await bAgent.post(`/companies/${b.id}/invoices`, invoiceBody(bCo, { lines })).expect(400)).body.code).toBe('INVALID_ACCOUNT');
    expect((await bAgent.post(`/companies/${b.id}/invoices`, invoiceBody(bCo, { contactId: a.customer })).expect(400)).body.code).toBe('INVALID_CONTACT');
    const taxLines = [{ description: 'x', quantity: '1', unitPrice: '1.00', accountId: bCo.acct['4000'], taxCodeId: a.tax.ZERO }];
    expect((await bAgent.post(`/companies/${b.id}/invoices`, invoiceBody(bCo, { lines: taxLines })).expect(400)).body.code).toBe('INVALID_TAX_CODE');
    expect((await bAgent.post(`/companies/${b.id}/journals`, { date: '2026-03-01', post: true, lines: [jl(a.acct['1010'], '1.00'), jl(bCo.acct['3000'], '0', '1.00')] })).status).toBe(400);
    expect(bal(await tb(bCo), '1100')).toBe('0.00');
  });
  it('roles: auditor reads reports but cannot write; employee cannot see the chart of accounts; bookkeeper drafts invoices but cannot post', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    const aud = await member(root, co, 'AUDITOR');
    const emp = await member(root, co, 'EMPLOYEE');
    const bk = await member(root, co, 'BOOKKEEPER');
    await aud.get(`/companies/${co.id}/reports/trial-balance`).expect(200);
    await aud.post(`/companies/${co.id}/invoices`, invoiceBody(co)).expect(403);
    await aud.post(`/companies/${co.id}/journals`, { date: '2026-03-01', lines: [] }).expect(403);
    await emp.get(`/companies/${co.id}/accounts`).expect(403);
    await emp.get(`/companies/${co.id}/reports/trial-balance`).expect(403);
    const inv = (await bk.post(`/companies/${co.id}/invoices`, invoiceBody(co)).expect(201)).body;
    await bk.post(`/companies/${co.id}/invoices/${inv.id}/post`).expect(403);
    await bk.post(`/companies/${co.id}/payments`, { direction: 'RECEIPT', contactId: co.customer, bankAccountId: co.acct['1010'], date: '2026-06-20', amount: '1.00', allocations: [{ documentId: inv.id, amount: '1.00' }] }).expect(403);
  });
  it('malformed ids and dates give 400/404, never 500', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    await root.get(`/companies/${co.id}/journals/not-a-uuid`).expect(400);
    await root.get(`/companies/${co.id}/reports/trial-balance?asOf=2026-02-31`).expect(400);
    await root.get(`/companies/${co.id}/reports/general-ledger`).expect(400);
  });
});

describe('reports', () => {
  it('general ledger running balance reconciles to the trial balance', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    await postedInvoice(co);
    await postedInvoice(co, { issueDate: '2026-07-01', dueDate: '2026-08-01' });
    const gl = (await root.get(`/companies/${co.id}/reports/general-ledger?accountId=${co.acct['1100']}&from=2026-01-01&to=2026-12-31`).expect(200)).body;
    expect(gl.rows.map((r: { balance: string }) => r.balance)).toEqual(['113.00', '226.00']);
    expect(gl.closingBalance).toBe(bal(await tb(co), '1100'));
    const later = (await root.get(`/companies/${co.id}/reports/general-ledger?accountId=${co.acct['1100']}&from=2026-07-01&to=2026-12-31`).expect(200)).body;
    expect(later.openingBalance).toBe('113.00');
    expect(later.closingBalance).toBe('226.00');
  });
  it('draft entries never appear in reports', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    await root.post(`/companies/${co.id}/journals`, { date: '2026-03-01', lines: [jl(co.acct['1010'], '10.00'), jl(co.acct['3000'], '0', '10.00')] }).expect(201);
    expect((await tb(co)).rows).toHaveLength(0);
  });
});

describe('dashboard figures come from the ledger', () => {
  it('null before posting; afterwards revenue, A/R and sales tax payable match the trial balance', async () => {
    const root = await setupAdmin(app); const co = await makeCompany(root);
    expect((await root.get(`/companies/${co.id}/dashboard`).expect(200)).body.financials).toBeNull();
    await postedInvoice(co);
    const f = (await root.get(`/companies/${co.id}/dashboard`).expect(200)).body.financials;
    expect(f).toMatchObject({ revenue: '100.00', expenses: '0.00', netIncome: '100.00', accountsReceivable: '113.00', salesTaxPayable: '13.00' });
  });
});
