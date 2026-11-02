import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@ca/database';
import { PASSWORD, agent, bootApp, resetDb, setupAdmin } from './helpers';
import { company, type Co } from './fixtures';

let app: INestApplication;
let prisma: PrismaClient;
beforeAll(async () => ({ app, prisma } = await bootApp()));
afterAll(async () => { await prisma.$disconnect(); await app.close(); });
beforeEach(() => resetDb(prisma));

type A = ReturnType<typeof agent>;
const balance = async (companyId: string, accountId: string) => {
  const a = await prisma.journalLine.aggregate({ where: { companyId, accountId, entry: { status: 'POSTED' } }, _sum: { debit: true, credit: true } });
  return (Number(a._sum.debit ?? 0) - Number(a._sum.credit ?? 0)).toFixed(2);
};
async function postBill(root: A, co: Co, lines: object[], kind = 'STANDARD') {
  const b = (await root.post(`/companies/${co.id}/bills`, { contactId: co.vendor, issueDate: '2026-10-01', dueDate: '2026-10-31', kind, lines }).expect(201)).body;
  return (await root.post(`/companies/${co.id}/bills/${b.id}/post`).expect(201)).body;
}
async function postInvoice(root: A, co: Co, body: object) {
  const i = (await root.post(`/companies/${co.id}/invoices`, { contactId: co.customer, issueDate: '2026-10-05', dueDate: '2026-11-04', ...body }).expect(201)).body;
  return root.post(`/companies/${co.id}/invoices/${i.id}/post`);
}
async function signIn(email: string) {
  const a = agent(app);
  await a.post('/auth/login', { email, password: PASSWORD }).expect(200);
  await a.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' }).expect(204);
  return a;
}

describe('inventory at weighted-average cost', () => {
  it('receives stock on bills, posts COGS on sales, keeps the ledger equal to the valuation, and refuses to go negative', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const item = (await root.post(`/companies/${co.id}/items`, { name: 'Maple syrup 1L', sku: 'MS-1', type: 'NON_INVENTORY', trackInventory: true, rate: '25.00', incomeAccountId: co.acct['4000'], taxCodeId: co.tax.HST_ON, reorderPoint: '5' }).expect(201)).body;
    expect(item).toMatchObject({ trackInventory: true, inventoryAccountId: co.acct['1200'], cogsAccountId: co.acct['5000'] });
    const buy = (qty: string, cost: string, accountId = co.acct['1200']) => ({ description: 'Syrup', quantity: qty, unitPrice: cost, accountId, taxCodeId: co.tax.HST_ON, itemId: item.id });
    const sell = (qty: string) => ({ description: 'Syrup', quantity: qty, unitPrice: '25.00', accountId: co.acct['4000'], taxCodeId: co.tax.HST_ON, itemId: item.id });

    expect((await root.post(`/companies/${co.id}/bills`, { contactId: co.vendor, issueDate: '2026-10-01', dueDate: '2026-10-31', lines: [buy('1', '1', co.acct['5000'])] })).body.code).toBe('INVENTORY_ACCOUNT');
    const b1 = await postBill(root, co, [buy('10', '10.00')]); // HST recoverable: cost 100.00
    await postBill(root, co, [buy('10', '13.00')]);            // cost 130.00 → 20 @ 11.50
    expect(await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ qtyOnHand: expect.anything() });
    let it = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect([it.qtyOnHand.toString(), it.avgCost.toString()]).toEqual(['20', '11.5']);

    await postInvoice(root, co, { lines: [sell('4')] }).then((r) => expect(r.status).toBe(201));
    const inv = await prisma.invoice.findFirstOrThrow({ where: { companyId: co.id }, include: { lines: true } });
    expect(inv.lines[0].cogs?.toString()).toBe('46');
    expect(await balance(co.id, co.acct['5000'])).toBe('46.00');
    expect(await balance(co.id, co.acct['1200'])).toBe('184.00');

    expect((await postInvoice(root, co, { lines: [sell('17')] })).body.code).toBe('INSUFFICIENT_STOCK');

    // the last units out take exactly the value that is left
    const r = (await root.post(`/companies/${co.id}/sales-receipts`, { contactId: co.customer, date: '2026-10-06', paymentMethod: 'CASH', depositAccountId: co.acct['1010'], lines: [sell('16')], post: true }).expect(201)).body;
    expect(await balance(co.id, co.acct['1200'])).toBe('0.00');
    expect(await balance(co.id, co.acct['5000'])).toBe('230.00');
    expect((await root.post(`/companies/${co.id}/bills/${b1.id}/void`)).body.code).toBe('INVENTORY_IN_USE'); // its stock is sold
    await root.post(`/companies/${co.id}/sales-receipts/${r.id}/void`).expect(201);
    it = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(it.qtyOnHand.toString()).toBe('16');
    expect(await balance(co.id, co.acct['1200'])).toBe('184.00');

    // shrinkage, then a customer return through a credit note
    const adj = (await root.post(`/companies/${co.id}/inventory/adjustments`, { date: '2026-10-07', itemId: item.id, quantityChange: '-1', accountId: co.acct['6050'], memo: 'Broken bottle' }).expect(201)).body;
    expect(adj).toMatchObject({ qtyOnHand: '15', value: '172.50' });
    expect((await root.post(`/companies/${co.id}/inventory/adjustments`, { date: '2026-10-07', itemId: item.id, quantityChange: '-1', accountId: co.acct['1200'] })).body.code).toBe('INVALID_ACCOUNT');
    const cn = (await root.post(`/companies/${co.id}/invoices`, { contactId: co.customer, issueDate: '2026-10-08', dueDate: '2026-10-08', kind: 'CREDIT', lines: [sell('1')] }).expect(201)).body;
    await root.post(`/companies/${co.id}/invoices/${cn.id}/post`).expect(201);

    const val = (await root.get(`/companies/${co.id}/inventory/valuation?asOf=2026-12-31`).expect(200)).body;
    expect(val).toMatchObject({ total: '184.00', ledgerBalance: '184.00', reconciled: true });
    expect(val.rows[0]).toMatchObject({ name: 'Maple syrup 1L', qtyOnHand: '16', avgCost: '11.5000', low: false });
    const detail = (await root.get(`/companies/${co.id}/inventory/detail?from=2026-10-01&to=2026-10-31&itemId=${item.id}`).expect(200)).body;
    expect(detail.map((d: { sourceType: string; quantity: string }) => `${d.sourceType}:${d.quantity}`)).toEqual(['bill:10', 'bill:10', 'invoice:-4', 'sales_receipt:-16', 'reversal:16', 'adjustment:-1', 'credit_note:1']);

    expect((await root.patch(`/companies/${co.id}/items/${item.id}`, { trackInventory: false })).body.code).toBe('INVENTORY_LOCKED');
    await root.post(`/companies/${co.id}/inventory/adjustments`, { date: '2026-10-09', itemId: item.id, quantityChange: '-12', accountId: co.acct['6050'] }).expect(201);
    expect((await root.get(`/companies/${co.id}/inventory/low-stock`).expect(200)).body).toMatchObject([{ name: 'Maple syrup 1L', qtyOnHand: '4' }]);
  });
});

describe('purchase orders', () => {
  it('creates, converts into a draft bill, and reopens if that draft is deleted', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const po = (await root.post(`/companies/${co.id}/purchase-orders`, { contactId: co.vendor, issueDate: '2026-10-01', expectedDate: '2026-10-15', shipTo: 'Warehouse\n1 Dock Rd', lines: [{ description: 'Bottles', quantity: '100', unitPrice: '0.80', accountId: co.acct['6050'], taxCodeId: co.tax.HST_ON }] }).expect(201)).body;
    expect(po).toMatchObject({ number: 'PO-0001', status: 'OPEN', total: '90.4' });
    expect(await prisma.journalEntry.count({ where: { companyId: co.id } })).toBe(0);
    expect((await root.get(`/companies/${co.id}/purchase-orders/${po.id}/pdf`).expect(200)).headers['content-type']).toBe('application/pdf');
    const bill = (await root.post(`/companies/${co.id}/purchase-orders/${po.id}/convert`, { issueDate: '2026-10-16', supplierRef: 'INV-778' }).expect(201)).body;
    expect(bill).toMatchObject({ status: 'DRAFT', total: '90.4', purchaseOrderId: po.id, supplierRef: 'INV-778' });
    expect((await root.get(`/companies/${co.id}/purchase-orders/${po.id}`).expect(200)).body).toMatchObject({ status: 'CLOSED', billId: bill.id });
    expect((await root.put(`/companies/${co.id}/purchase-orders/${po.id}`, { contactId: co.vendor, issueDate: '2026-10-01', lines: [{ description: 'x', quantity: '1', unitPrice: '1', accountId: co.acct['6050'], taxCodeId: co.tax.HST_ON }] })).body.code).toBe('NOT_EDITABLE');
    // editing the draft bill keeps its link to the order; a posted bill cannot be edited
    const edited = (await root.put(`/companies/${co.id}/bills/${bill.id}`, { contactId: co.vendor, issueDate: '2026-10-16', dueDate: '2026-11-15', supplierRef: 'INV-778', lines: [{ description: 'Bottles (90 received)', quantity: '90', unitPrice: '0.80', accountId: co.acct['6050'], taxCodeId: co.tax.HST_ON }] }).expect(200)).body;
    expect(edited).toMatchObject({ id: bill.id, purchaseOrderId: po.id, total: '81.36' });
    await root.post(`/companies/${co.id}/bills/${bill.id}/void`).expect(201);
    expect((await root.get(`/companies/${co.id}/purchase-orders/${po.id}`).expect(200)).body).toMatchObject({ status: 'OPEN', billId: null });
  });
});

describe('projects, time and billable costs', () => {
  it('bills time and costs once, tracks project profit from the ledger, and keeps employees to their own time', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const p = (await root.post(`/companies/${co.id}/projects`, { name: 'Sugar shack renovation', customerId: co.customer, budget: '5000' }).expect(201)).body;
    expect((await root.post(`/companies/${co.id}/projects`, { name: 'Sugar shack renovation', customerId: co.customer })).body.code).toBe('DUPLICATE');
    const t1 = (await root.post(`/companies/${co.id}/time`, { date: '2026-10-02', hours: '2.5', projectId: p.id, billable: true, rate: '80.00', description: 'Site visit' }).expect(201)).body;
    expect(t1.customerId).toBe(co.customer); // taken from the project
    expect((await root.post(`/companies/${co.id}/time`, { date: '2026-10-02', hours: '1', billable: true })).body.code).toBe('INVALID_BILLABLE');

    await root.post(`/companies/${co.id}/members`, { email: 'emp@example.test', name: 'Emp', role: 'EMPLOYEE', temporaryPassword: PASSWORD }).expect(201);
    const emp = await signIn('emp@example.test');
    await emp.post(`/companies/${co.id}/time`, { date: '2026-10-03', hours: '3', projectId: p.id, billable: false }).expect(201);
    expect((await emp.get(`/companies/${co.id}/time`).expect(200)).body).toHaveLength(1); // only their own
    expect((await root.get(`/companies/${co.id}/time`).expect(200)).body).toHaveLength(2);
    expect((await emp.put(`/companies/${co.id}/time/${t1.id}`, { date: '2026-10-02', hours: '9', billable: false })).status).toBe(403);
    const empId = (await prisma.user.findUniqueOrThrow({ where: { email: 'emp@example.test' } })).id;
    expect((await emp.post(`/companies/${co.id}/time`, { date: '2026-10-03', hours: '1', billable: false, userId: (await prisma.user.findFirstOrThrow({ where: { email: 'root@example.test' } })).id })).status).toBe(403);
    await root.post(`/companies/${co.id}/time`, { date: '2026-10-04', hours: '1', billable: false, userId: empId }).expect(201);

    // a cost billable to the customer, on the project
    const bill = await postBill(root, co, [{ description: 'Lumber', quantity: '1', unitPrice: '300.00', accountId: co.acct['6050'], taxCodeId: co.tax.HST_ON, projectId: p.id, billable: true, billableToId: co.customer }]);
    const billLine = (await prisma.billLine.findFirstOrThrow({ where: { billId: bill.id } })).id;
    const billables = (await root.get(`/companies/${co.id}/customers/${co.customer}/billables`).expect(200)).body;
    expect(billables.map((b: { type: string; quantity: string; rate: string }) => [b.type, b.quantity, b.rate])).toEqual([['bill_line', '1', '300.00'], ['time', '2.5', '80.00']]); // by date

    const lines = [
      { description: 'Site visit', quantity: '2.5', unitPrice: '80.00', accountId: co.acct['4000'], taxCodeId: co.tax.HST_ON, projectId: p.id, sourceRef: { type: 'time', id: t1.id } },
      { description: 'Lumber (re-billed)', quantity: '1', unitPrice: '360.00', accountId: co.acct['4000'], taxCodeId: co.tax.HST_ON, projectId: p.id, sourceRef: { type: 'bill_line', id: billLine } },
    ];
    const inv = (await root.post(`/companies/${co.id}/invoices`, { contactId: co.customer, issueDate: '2026-10-10', dueDate: '2026-11-09', lines }).expect(201)).body;
    expect((await root.get(`/companies/${co.id}/customers/${co.customer}/billables`).expect(200)).body).toHaveLength(0);
    expect((await root.post(`/companies/${co.id}/invoices`, { contactId: co.customer, issueDate: '2026-10-10', dueDate: '2026-11-09', lines: [lines[0]] }).expect(409)).body.code).toBe('ALREADY_BILLED');
    expect((await root.put(`/companies/${co.id}/time/${t1.id}`, { date: '2026-10-02', hours: '3', billable: true, projectId: p.id })).body.code).toBe('ALREADY_BILLED');
    await root.post(`/companies/${co.id}/invoices/${inv.id}/post`).expect(201);
    expect((await root.post(`/companies/${co.id}/bills/${bill.id}/void`)).body.code).toBe('BILLED_TO_CUSTOMER');

    const prof = (await root.get(`/companies/${co.id}/projects/profitability`).expect(200)).body[0];
    expect(prof).toMatchObject({ name: 'Sugar shack renovation', income: '560.00', costs: '300.00', profit: '260.00', margin: '46.4', hours: { billable: '2.5', nonBillable: '3', unbilled: '0' }, labourCostIncluded: false });

    await root.post(`/companies/${co.id}/invoices/${inv.id}/void`).expect(201);
    expect((await root.get(`/companies/${co.id}/customers/${co.customer}/billables`).expect(200)).body).toHaveLength(2); // billable again
  });
});

describe('classes, locations, budgets and the dashboard', () => {
  it('reports profit and loss by class and by location, budget vs actual, and dashboard figures', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const retail = (await root.post(`/companies/${co.id}/classes`, { name: 'Retail' }).expect(201)).body;
    const mtl = (await root.post(`/companies/${co.id}/locations`, { name: 'Montréal' }).expect(201)).body;
    expect((await root.post(`/companies/${co.id}/classes`, { name: 'Retail' })).body.code).toBe('DUPLICATE');
    await postInvoice(root, co, { locationId: mtl.id, lines: [{ description: 'Retail sale', quantity: '1', unitPrice: '1000.00', accountId: co.acct['4000'], taxCodeId: co.tax.HST_ON, classId: retail.id }, { description: 'Other', quantity: '1', unitPrice: '200.00', accountId: co.acct['4000'], taxCodeId: co.tax.HST_ON }] }).then((r) => expect(r.status).toBe(201));
    await postBill(root, co, [{ description: 'Shelving', quantity: '1', unitPrice: '400.00', accountId: co.acct['6050'], taxCodeId: co.tax.HST_ON, classId: retail.id }]);
    const other = (await root.post(`/companies/${co.id}/classes`, { name: 'Wholesale', isActive: true }).expect(201)).body;
    await root.put(`/companies/${co.id}/classes/${other.id}`, { name: 'Wholesale', isActive: false }).expect(200);
    expect((await root.post(`/companies/${co.id}/invoices`, { contactId: co.customer, issueDate: '2026-10-05', dueDate: '2026-11-04', lines: [{ description: 'x', quantity: '1', unitPrice: '1', accountId: co.acct['4000'], taxCodeId: co.tax.HST_ON, classId: other.id }] }).expect(400)).body.code).toBe('INVALID_CLASS');

    const byClass = (await root.get(`/companies/${co.id}/reports/profit-and-loss-by-class?from=2026-10-01&to=2026-10-31`).expect(200)).body;
    expect(byClass.columns.map((c: { name: string }) => c.name)).toEqual(['Retail', 'Wholesale', 'Not specified']);
    expect(byClass.totals.netIncome).toEqual(['600.00', '0.00', '200.00']);
    expect(byClass.grand.netIncome).toBe('800.00');
    const byLoc = (await root.get(`/companies/${co.id}/reports/profit-and-loss-by-location?from=2026-10-01&to=2026-10-31`).expect(200)).body;
    expect(byLoc.totals.income).toEqual(['1200.00', '0.00']);
    expect(byLoc.totals.expenses).toEqual(['0.00', '400.00']);
    // the location is on every line of the invoice, A/R and tax included
    const lines = await prisma.journalLine.findMany({ where: { companyId: co.id, entry: { sourceType: 'invoice' } } });
    expect(lines.every((l) => l.locationId === mtl.id)).toBe(true);

    const fy = (await prisma.fiscalYear.findFirstOrThrow({ where: { companyId: co.id } })).id;
    expect((await root.post(`/companies/${co.id}/budgets`, { name: 'Plan', fiscalYearId: fy, lines: [{ accountId: co.acct['1010'], month: '2026-10', amount: '1' }] })).body.code).toBe('INVALID_ACCOUNT');
    expect((await root.post(`/companies/${co.id}/budgets`, { name: 'Plan', fiscalYearId: fy, lines: [{ accountId: co.acct['4000'], month: '2027-01', amount: '1' }] })).body.code).toBe('OUTSIDE_YEAR');
    const b = (await root.post(`/companies/${co.id}/budgets`, { name: '2026 plan', fiscalYearId: fy, lines: [{ accountId: co.acct['4000'], month: '2026-10', amount: '1500.00' }, { accountId: co.acct['6050'], month: '2026-10', amount: '300.00' }] }).expect(201)).body;
    const bva = (await root.get(`/companies/${co.id}/budgets/${b.id}/vs-actual`).expect(200)).body;
    expect(bva.months).toHaveLength(12);
    const rev = bva.rows.find((r: { code: string }) => r.code === '4000');
    expect(rev.total).toEqual({ budget: '1500.00', actual: '1200.00', variance: '-300.00', percent: '80.0' });
    expect(rev.months[9]).toEqual({ month: '2026-10', budget: '1500.00', actual: '1200.00', variance: '-300.00' });
    expect(bva.rows.find((r: { code: string }) => r.code === '6050').total.variance).toBe('100.00');

    const dash = (await root.get(`/companies/${co.id}/dashboard/charts`).expect(200)).body;
    expect(dash.months).toHaveLength(12);
    expect(dash.receivables.total).toBe('1356.00');
    expect(dash.payables.total).toBe('452.00');
    expect(dash.bankAccounts.find((b: { name: string }) => b.name === 'Undeposited Funds')).toMatchObject({ kind: 'HOLDING', balance: '0.00' });
  });
});
