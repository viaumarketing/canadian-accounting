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
async function company(root: A) {
  const c = (await root.post('/admin/companies', { legalName: 'Érablière Test Inc.', province: 'ON', ownerEmail: 'root@example.test' }).expect(201)).body;
  await root.post(`/companies/${c.id}/fiscal-years`, { startDate: '2026-01-01' });
  const accts = (await root.get(`/companies/${c.id}/accounts`).expect(200)).body as { id: string; code: string }[];
  const codes = (await root.get(`/companies/${c.id}/tax-codes`).expect(200)).body as { id: string; code: string }[];
  const customer = (await root.post(`/companies/${c.id}/contacts`, { kind: 'CUSTOMER', name: 'Maple Café', email: 'ap@maple.example', billingAddress: '12 Rue Principale\nOttawa ON K1A 0A1', defaultTerms: 'NET_30' }).expect(201)).body.id as string;
  return { id: c.id as string, acct: Object.fromEntries(accts.map((a) => [a.code, a.id])) as Record<string, string>, tax: Object.fromEntries(codes.map((a) => [a.code, a.id])) as Record<string, string>, customer };
}
type Co = Awaited<ReturnType<typeof company>>;
const receipt = (co: Co, o: Partial<{ post: boolean; amount: string; date: string; qty: string }> = {}) => ({
  contactId: co.customer, date: o.date ?? '2026-10-20', paymentMethod: 'E_TRANSFER', referenceNo: 'ET-55', depositAccountId: co.acct['1010'],
  lines: [{ description: 'Maple syrup 1L', quantity: o.qty ?? '2', unitPrice: o.amount ?? '25.00', accountId: co.acct['4000'], taxCodeId: co.tax.HST_ON }],
  message: 'Thank you!', post: o.post ?? true,
});

describe('products & services', () => {
  it('creates, lists, edits and deactivates items; validates the income account and duplicate names', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const it1 = (await root.post(`/companies/${co.id}/items`, { name: 'Maple syrup 1L', sku: 'MS-1L', type: 'NON_INVENTORY', rate: '25.00', incomeAccountId: co.acct['4000'], taxCodeId: co.tax.HST_ON }).expect(201)).body;
    expect((await root.post(`/companies/${co.id}/items`, { name: 'Maple syrup 1L', incomeAccountId: co.acct['4000'] })).body.code).toBe('DUPLICATE');
    expect((await root.post(`/companies/${co.id}/items`, { name: 'Bad', incomeAccountId: co.acct['1010'] })).body.code).toBe('INVALID_ACCOUNT');
    await root.patch(`/companies/${co.id}/items/${it1.id}`, { rate: '27.50' }).expect(200);
    const list = (await root.get(`/companies/${co.id}/items`).expect(200)).body;
    expect(list[0]).toMatchObject({ name: 'Maple syrup 1L', rate: '27.5', incomeAccount: { code: '4000' }, taxCode: { code: 'HST_ON' } });
    await root.patch(`/companies/${co.id}/items/${it1.id}`, { isActive: false }).expect(200);
    expect((await root.get(`/companies/${co.id}/items`).expect(200)).body).toHaveLength(0);
    expect((await root.get(`/companies/${co.id}/items?all=true`).expect(200)).body).toHaveLength(1);
  });
});

describe('sales receipts', () => {
  it('posts Dr bank / Cr revenue / Cr HST, numbers SR-0001, and void reverses it', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const r = (await root.post(`/companies/${co.id}/sales-receipts`, receipt(co)).expect(201)).body;
    expect(r).toMatchObject({ number: 'SR-0001', status: 'PAID' });
    const full = (await root.get(`/companies/${co.id}/sales-receipts/${r.id}`).expect(200)).body;
    expect(full).toMatchObject({ subtotal: '50', taxTotal: '6.5', total: '56.5', paymentMethod: 'E_TRANSFER', depositAccount: { code: '1010' } });
    const lines = await prisma.journalLine.findMany({ where: { entryId: full.journalEntryId }, include: { account: { select: { code: true, role: true } } } });
    const by = (pred: (l: (typeof lines)[number]) => boolean) => lines.filter(pred).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    expect(by((l) => l.account.code === '1010')).toBeCloseTo(56.5);
    expect(by((l) => l.account.code === '4000')).toBeCloseTo(-50);
    expect(by((l) => l.account.role === 'GST_HST_PAYABLE')).toBeCloseTo(-6.5);
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: full.journalEntryId } })).sourceType).toBe('sales_receipt');

    await root.post(`/companies/${co.id}/sales-receipts/${r.id}/void`).expect(201);
    expect((await root.get(`/companies/${co.id}/sales-receipts/${r.id}`).expect(200)).body.status).toBe('VOID');
    const bank = await prisma.journalLine.aggregate({ where: { companyId: co.id, accountId: co.acct['1010'] }, _sum: { debit: true, credit: true } });
    expect(Number(bank._sum.debit) - Number(bank._sum.credit)).toBe(0);
    expect((await root.post(`/companies/${co.id}/sales-receipts/${r.id}/void`)).body.code).toBe('ALREADY_VOID');
  });

  it('drafts can be edited and deleted; deposit-to must be a bank/cash account; bookkeepers save drafts but cannot post', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const d = (await root.post(`/companies/${co.id}/sales-receipts`, receipt(co, { post: false })).expect(201)).body;
    expect(d).toMatchObject({ status: 'DRAFT', number: null });
    const edited = (await root.put(`/companies/${co.id}/sales-receipts/${d.id}`, receipt(co, { post: false, qty: '3' })).expect(200)).body;
    expect(edited.total).toBe('84.75');
    expect((await root.post(`/companies/${co.id}/sales-receipts`, { ...receipt(co), depositAccountId: co.acct['4000'] })).body.code).toBe('INVALID_DEPOSIT_ACCOUNT');
    await root.post(`/companies/${co.id}/sales-receipts/${d.id}/void`).expect(201); // a draft is simply deleted
    expect(await prisma.salesReceipt.count({ where: { id: d.id } })).toBe(0);

    await root.post(`/companies/${co.id}/members`, { email: 'bk@example.test', name: 'BK', role: 'BOOKKEEPER', temporaryPassword: PASSWORD }).expect(201);
    const bk = agent(app);
    await bk.post('/auth/login', { email: 'bk@example.test', password: PASSWORD }).expect(200);
    await bk.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' }).expect(204);
    expect((await bk.post(`/companies/${co.id}/sales-receipts`, receipt(co))).status).toBe(403);
    await bk.post(`/companies/${co.id}/sales-receipts`, receipt(co, { post: false })).expect(201);
  });

  it('appear in the GST/HST report (collected, schedule) with every check green, and in revenue by channel', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await root.post(`/companies/${co.id}/sales-receipts`, receipt(co)).expect(201);
    const inv = (await root.post(`/companies/${co.id}/invoices`, { contactId: co.customer, issueDate: '2026-10-21', dueDate: '2026-11-20', lines: [{ description: 'Syrup case', quantity: '1', unitPrice: '100.00', accountId: co.acct['4000'], taxCodeId: co.tax.HST_ON }] }).expect(201)).body;
    await root.post(`/companies/${co.id}/invoices/${inv.id}/post`).expect(201);
    const r = (await root.get(`/companies/${co.id}/report/tax-gst-hst?from=2026-10-01&to=2026-10-31`).expect(200)).body as Report;
    const ret = r.sections.find((s) => s.title?.startsWith('Return preparation'))!;
    expect(ret.rows.find((x) => x.cells.line === '103')!.cells.amount).toBe('19.50'); // 6.50 + 13.00
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    const ch = (await root.get(`/companies/${co.id}/report/revenue-by-channel?from=2026-10-01&to=2026-10-31`).expect(200)).body as Report;
    expect(ch.sections[0].rows.map((x) => [x.cells.name, x.cells.amount])).toEqual(expect.arrayContaining([['Invoices (direct sales)', '100.00'], ['Sales receipts (paid at the time of sale)', '50.00']]));
  });
});

describe('invoices (QuickBooks-style fields)', () => {
  it('stores terms, billing address, message, memo, product and service date; drafts are editable; due date cannot precede the invoice date', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const item = (await root.post(`/companies/${co.id}/items`, { name: 'Tapping service', rate: '80.00', incomeAccountId: co.acct['4000'], taxCodeId: co.tax.HST_ON }).expect(201)).body;
    const body = { contactId: co.customer, issueDate: '2026-10-01', dueDate: '2026-10-31', terms: 'NET_30', billingAddress: '12 Rue Principale\nOttawa ON', message: 'Merci!', memo: 'internal', lines: [{ itemId: item.id, serviceDate: '2026-09-28', description: 'Tapping', quantity: '3', unitPrice: '80.00', accountId: co.acct['4000'], taxCodeId: co.tax.HST_ON }] };
    const inv = (await root.post(`/companies/${co.id}/invoices`, body).expect(201)).body;
    const got = (await root.get(`/companies/${co.id}/invoices/${inv.id}`).expect(200)).body;
    expect(got).toMatchObject({ terms: 'NET_30', message: 'Merci!', memo: 'internal', total: '271.2' });
    expect(got.lines[0]).toMatchObject({ itemId: item.id });
    expect(got.lines[0].serviceDate.slice(0, 10)).toBe('2026-09-28');
    await root.put(`/companies/${co.id}/invoices/${inv.id}`, { ...body, lines: [...body.lines, { ...body.lines[0], quantity: '1' }] }).expect(200);
    expect((await root.get(`/companies/${co.id}/invoices/${inv.id}`).expect(200)).body.lines).toHaveLength(2);
    expect((await root.post(`/companies/${co.id}/invoices`, { ...body, dueDate: '2026-09-01' })).body.code).toBe('INVALID_DUE_DATE');
    await root.post(`/companies/${co.id}/invoices/${inv.id}/post`).expect(201);
    expect((await root.put(`/companies/${co.id}/invoices/${inv.id}`, body)).body.code).toBe('NOT_DRAFT');
  });
});

describe('all sales, money bar, customers and printable documents', () => {
  it('lists every sales transaction with a plain-words status and totals the money bar', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const today = new Date().toISOString().slice(0, 10);
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const mk = async (issue: string, due: string, amount: string) => {
      const i = (await root.post(`/companies/${co.id}/invoices`, { contactId: co.customer, issueDate: issue, dueDate: due, lines: [{ description: 'x', quantity: '1', unitPrice: amount, accountId: co.acct['4000'], taxCodeId: co.tax.ZERO }] }).expect(201)).body;
      await root.post(`/companies/${co.id}/invoices/${i.id}/post`).expect(201);
      return i;
    };
    await root.post(`/companies/${co.id}/fiscal-years`, { startDate: '2027-01-01' });
    const overdue = await mk(day(-40), day(-10), '100.00');
    await mk(day(-5), day(25), '200.00');
    const paid = await mk(day(-3), day(27), '50.00');
    await root.post(`/companies/${co.id}/payments`, { direction: 'RECEIPT', contactId: co.customer, bankAccountId: co.acct['1010'], date: today, amount: '50.00', allocations: [{ documentId: paid.id, amount: '50.00' }] }).expect(201);
    await root.post(`/companies/${co.id}/sales-receipts`, receipt(co, { date: today })).expect(201);

    const all = (await root.get(`/companies/${co.id}/sales/transactions`).expect(200)).body as { id: string; type: string; status: string; balance: string }[];
    expect(all.map((r) => r.type).sort()).toEqual(['invoice', 'invoice', 'invoice', 'payment', 'sales_receipt']);
    expect(all.find((r) => r.id === overdue.id)).toMatchObject({ status: 'Overdue 10 days', balance: '100.00' });
    expect(all.find((r) => r.id === paid.id)!.status).toBe('Paid');
    expect((await root.get(`/companies/${co.id}/sales/transactions?status=overdue`).expect(200)).body).toHaveLength(1);
    expect((await root.get(`/companies/${co.id}/sales/transactions?type=sales_receipt`).expect(200)).body).toHaveLength(1);

    const bar = (await root.get(`/companies/${co.id}/sales/summary`).expect(200)).body;
    expect(bar).toEqual({ unpaid: { overdue: '100.00', overdueCount: 1, notDueYet: '200.00', notDueYetCount: 1 }, paidLast30Days: { amount: '106.50', count: 2 } });
    expect((await root.get(`/companies/${co.id}/sales/customer-balances`).expect(200)).body).toEqual({ [co.customer]: '300.00' });
  });

  it('renders invoice and sales-receipt PDFs; customer and company details can be edited', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await root.patch(`/companies/${co.id}`, { address: '1 Sugar Bush Rd\nSt-Jérôme QC', phone: '555-0100', email: 'info@erabliere.example' }).expect(200);
    await root.patch(`/companies/${co.id}/contacts/${co.customer}`, { phone: '555-0199', defaultTerms: 'NET_15' }).expect(200);
    expect((await root.get(`/companies/${co.id}/contacts/${co.customer}`).expect(200)).body).toMatchObject({ phone: '555-0199', defaultTerms: 'NET_15' });
    const r = (await root.post(`/companies/${co.id}/sales-receipts`, receipt(co)).expect(201)).body;
    const inv = (await root.post(`/companies/${co.id}/invoices`, { contactId: co.customer, issueDate: '2026-10-01', dueDate: '2026-10-31', terms: 'NET_30', lines: [{ description: 'Syrup', quantity: '1', unitPrice: '10.00', accountId: co.acct['4000'], taxCodeId: co.tax.HST_ON }] }).expect(201)).body;
    for (const url of [`/companies/${co.id}/sales-receipts/${r.id}/pdf`, `/companies/${co.id}/invoices/${inv.id}/pdf`]) {
      const res = await root.raw.get(url).buffer(true).parse((rs, cb) => { const b: Buffer[] = []; rs.on('data', (c: Buffer) => b.push(c)); rs.on('end', () => cb(null, Buffer.concat(b))); });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toMatch(/^inline; filename="(sales-receipt-SR-0001|invoice-DRAFT)\.pdf"$/);
      expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    }
    // Another company cannot print this company's documents.
    const other = (await root.post('/admin/companies', { legalName: 'Other', province: 'ON', ownerEmail: 'root@example.test' }).expect(201)).body;
    await root.get(`/companies/${other.id}/invoices/${inv.id}/pdf`).expect(404);
  });
});
