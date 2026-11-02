import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@ca/database';
import { PASSWORD, agent, bootApp, resetDb, setupAdmin } from './helpers';
import { company, fakeResend, invoiceBody, postedInvoice, type Co } from './fixtures';
import { AutomationService, advance } from '../src/billing/automation.service';
import { toDate } from '../src/accounting/setup';

let app: INestApplication;
let prisma: PrismaClient;
let mail: ReturnType<typeof fakeResend>;
let automation: AutomationService;
beforeAll(async () => { ({ app, prisma } = await bootApp({ RESEND_API_KEY: 're_test_key', MAIL_FROM: 'billing@mail.example.test' })); automation = app.get(AutomationService); });
afterAll(async () => { await prisma.$disconnect(); await app.close(); });
beforeEach(async () => { await resetDb(prisma); mail = fakeResend(); });

const line = (co: Co, amount = '100.00') => ({ description: 'Consulting', quantity: '1', unitPrice: amount, accountId: co.acct['4000'], taxCodeId: co.tax.HST_ON });
const pay = (root: ReturnType<typeof agent>, co: Co, invoiceId: string, amount: string, date = '2026-10-15') =>
  root.post(`/companies/${co.id}/payments`, { direction: 'RECEIPT', contactId: co.customer, bankAccountId: co.acct['1010'], date, amount, allocations: [{ documentId: invoiceId, amount }] }).expect(201);

describe('estimates', () => {
  it('numbers, accepts and converts an estimate into a draft invoice; deleting that draft reopens it', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const e = (await root.post(`/companies/${co.id}/estimates`, { contactId: co.customer, issueDate: '2026-10-01', expiryDate: '2026-10-31', lines: [line(co, '400.00')], message: 'Valid 30 days' }).expect(201)).body;
    expect(e).toMatchObject({ number: 'EST-0001', status: 'PENDING', total: '452' });
    expect(await prisma.journalEntry.count({ where: { companyId: co.id } })).toBe(0); // no ledger effect
    expect((await root.post(`/companies/${co.id}/estimates`, { contactId: co.customer, issueDate: '2026-10-01', expiryDate: '2026-09-01', lines: [line(co)] })).body.code).toBe('INVALID_EXPIRY');
    await root.post(`/companies/${co.id}/estimates/${e.id}/decision`, { status: 'ACCEPTED', acceptedBy: 'Jeanne' }).expect(201);
    const inv = (await root.post(`/companies/${co.id}/estimates/${e.id}/convert`, { issueDate: '2026-10-05' }).expect(201)).body;
    expect(inv).toMatchObject({ status: 'DRAFT', total: '452', estimateId: e.id, issueDate: '2026-10-05T00:00:00.000Z', dueDate: '2026-11-04T00:00:00.000Z' }); // customer default Net 30
    expect((await root.get(`/companies/${co.id}/estimates/${e.id}`).expect(200)).body).toMatchObject({ status: 'CLOSED', invoiceId: inv.id, acceptedBy: 'Jeanne' });
    expect((await root.post(`/companies/${co.id}/estimates/${e.id}/convert`, {})).body.code).toBe('NOT_CONVERTIBLE');
    expect((await root.post(`/companies/${co.id}/estimates/${e.id}/void`)).body.code).toBe('NOT_EDITABLE');
    await root.post(`/companies/${co.id}/invoices/${inv.id}/void`).expect(201); // draft: deleted
    expect((await root.get(`/companies/${co.id}/estimates/${e.id}`).expect(200)).body).toMatchObject({ status: 'ACCEPTED', invoiceId: null });
    const pdf = await root.get(`/companies/${co.id}/estimates/${e.id}/pdf`).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });
});

describe('recurring transactions', () => {
  it('advances monthly schedules on the same day, clamped to the month end', () => {
    const s = toDate('2026-01-31');
    expect([1, 2, 3, 13].map((n) => advance(s, 'MONTHLY', 1, n).toISOString().slice(0, 10))).toEqual(['2026-02-28', '2026-03-31', '2026-04-30', '2027-02-28']);
    expect(advance(toDate('2026-01-01'), 'WEEKLY', 2, 1).toISOString().slice(0, 10)).toBe('2026-01-15');
    expect(advance(toDate('2028-02-29'), 'YEARLY', 1, 1).toISOString().slice(0, 10)).toBe('2029-02-28');
  });

  it('creates and posts the missed invoices once, sends them in SEND mode, and validates the template', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const payload = { contactId: co.customer, taxInclusive: false, kind: 'STANDARD', terms: 'NET_15', lines: [line(co, '50.00')] };
    expect((await root.post(`/companies/${co.id}/recurring`, { name: 'Bad', kind: 'INVOICE', interval: 'MONTHLY', startDate: '2026-01-31', payload: { contactId: co.customer } }).expect(400)).body.code).toBe('VALIDATION_ERROR');
    const t = (await root.post(`/companies/${co.id}/recurring`, { name: 'Monthly retainer', kind: 'INVOICE', mode: 'POST', interval: 'MONTHLY', startDate: '2026-01-31', daysDue: 15, maxRuns: 5, payload }).expect(201)).body;

    expect(await automation.runRecurring('2026-04-15')).toMatchObject({ created: 3 });
    expect(await automation.runRecurring('2026-04-15')).toMatchObject({ created: 0 }); // idempotent
    const invs = await prisma.invoice.findMany({ where: { companyId: co.id, recurringId: t.id }, orderBy: { issueDate: 'asc' } });
    expect(invs.map((i) => [i.issueDate.toISOString().slice(0, 10), i.dueDate.toISOString().slice(0, 10), i.status, i.number])).toEqual([
      ['2026-01-31', '2026-02-15', 'POSTED', 'INV-0001'], ['2026-02-28', '2026-03-15', 'POSTED', 'INV-0002'], ['2026-03-31', '2026-04-15', 'POSTED', 'INV-0003'],
    ]);
    const after = (await root.get(`/companies/${co.id}/recurring`).expect(200)).body[0];
    expect(after).toMatchObject({ runCount: 3, nextDate: '2026-04-30T00:00:00.000Z', lastError: null });

    // stops after maxRuns
    expect(await automation.runRecurring('2026-12-31')).toMatchObject({ created: 2 });
    expect((await root.get(`/companies/${co.id}/recurring`).expect(200)).body[0]).toMatchObject({ runCount: 5, isActive: false });

    // SEND mode e-mails each invoice to the customer
    await root.post(`/companies/${co.id}/recurring`, { name: 'Weekly', kind: 'INVOICE', mode: 'SEND', interval: 'WEEKLY', startDate: '2026-11-02', payload }).expect(201);
    expect(await automation.runRecurring('2026-11-02')).toMatchObject({ created: 1 });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].body.to).toEqual(['ap@maple.example']);

    // bills and expenses
    await root.post(`/companies/${co.id}/recurring`, { name: 'Rent', kind: 'BILL', mode: 'POST', interval: 'MONTHLY', startDate: '2026-10-01', payload: { contactId: co.vendor, taxInclusive: false, kind: 'STANDARD', lines: [{ description: 'Rent', quantity: '1', unitPrice: '1000', accountId: co.acct['6070'], taxCodeId: co.tax.HST_ON }] } }).expect(201);
    await root.post(`/companies/${co.id}/recurring`, { name: 'Phone', kind: 'EXPENSE', mode: 'POST', interval: 'MONTHLY', startDate: '2026-10-01', payload: { description: 'Phone', paidFromAccountId: co.acct['2100'], taxInclusive: true, lines: [{ description: 'Phone', amount: '56.50', accountId: co.acct['6090'], taxCodeId: co.tax.HST_ON }] } }).expect(201);
    await automation.runRecurring('2026-10-01');
    expect((await prisma.bill.findFirstOrThrow({ where: { companyId: co.id } })).status).toBe('POSTED');
    expect((await prisma.expense.findFirstOrThrow({ where: { companyId: co.id } })).status).toBe('SUBMITTED'); // still needs approval
  });

  it('a bookkeeper cannot schedule posting, and a schedule pauses when its owner loses access', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await root.post(`/companies/${co.id}/members`, { email: 'bk@example.test', name: 'BK', role: 'BOOKKEEPER', temporaryPassword: PASSWORD }).expect(201);
    const bk = agent(app);
    await bk.post('/auth/login', { email: 'bk@example.test', password: PASSWORD }).expect(200);
    await bk.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' }).expect(204);
    const payload = { contactId: co.customer, taxInclusive: false, kind: 'STANDARD', lines: [line(co)] };
    expect((await bk.post(`/companies/${co.id}/recurring`, { name: 'x', kind: 'INVOICE', mode: 'POST', interval: 'MONTHLY', startDate: '2026-10-01', payload }).expect(403)).body.code).toBe('FORBIDDEN');
    const t = (await bk.post(`/companies/${co.id}/recurring`, { name: 'Drafts', kind: 'INVOICE', mode: 'DRAFT', interval: 'MONTHLY', startDate: '2026-10-01', payload }).expect(201)).body;
    const m = await prisma.companyMembership.findFirstOrThrow({ where: { companyId: co.id, user: { email: 'bk@example.test' } } });
    await prisma.companyMembership.update({ where: { id: m.id }, data: { status: 'SUSPENDED' } });
    expect(await automation.runRecurring('2026-10-01')).toMatchObject({ created: 0 });
    const after = await prisma.recurringTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.isActive).toBe(false);
    expect(after.lastError).toContain('no longer a member');
  });
});

describe('statements, reminders and late fees', () => {
  it('builds balance-forward and open-item statements with aging that adds up', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const a = await postedInvoice(root, co, { issueDate: '2026-08-01', dueDate: '2026-08-31' }); // 113.00
    await pay(root, co, a.id, '50.00', '2026-08-20');
    const b = await postedInvoice(root, co, { issueDate: '2026-10-05', dueDate: '2026-11-04', amount: '200.00' }); // 226.00
    const cn = (await root.post(`/companies/${co.id}/invoices`, { ...invoiceBody(co, { issueDate: '2026-10-10', dueDate: '2026-10-10', amount: '10.00' }), kind: 'CREDIT' }).expect(201)).body;
    await root.post(`/companies/${co.id}/invoices/${cn.id}/post`).expect(201); // credit note 11.30

    const bf = (await root.get(`/companies/${co.id}/statements?contactId=${co.customer}&from=2026-10-01&to=2026-10-31&type=balance_forward`).expect(200)).body;
    expect(bf.opening).toBe('63.00');
    expect(bf.rows.map((r: { type: string; amount: string; balance: string }) => [r.type, r.amount, r.balance])).toEqual([['Invoice', '226.00', '289.00'], ['Credit note', '-11.30', '277.70']]);
    expect(bf.closing).toBe('277.70');
    expect(bf.aging).toEqual({ current: '214.70', d1_30: '0.00', d31_60: '0.00', d61_90: '63.00', over90: '0.00' }); // due Aug 31: 61 days at Oct 31
    expect(bf.agingTotal).toBe(bf.closing);

    // applying the credit changes nothing in total, but the open items shrink
    await root.post(`/companies/${co.id}/invoices/${b.id}/apply-credit`, { creditId: cn.id, amount: '11.30', date: '2026-10-12' }).expect(201);
    const oi = (await root.get(`/companies/${co.id}/statements?contactId=${co.customer}&from=2026-10-01&to=2026-10-31&type=open_item`).expect(200)).body;
    expect(oi.rows.map((r: { number: string; balance: string }) => [r.number, r.balance])).toEqual([['INV-0001', '63.00'], ['INV-0002', '214.70']]);
    expect(oi.closing).toBe('277.70');

    const pdf = await root.get(`/companies/${co.id}/statements/pdf?contactId=${co.customer}&from=2026-10-01&to=2026-10-31`).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    await root.post(`/companies/${co.id}/statements/send`, { contactId: co.customer, from: '2026-10-01', to: '2026-10-31' }).expect(201);
    expect(mail.sent[0].body).toMatchObject({ to: ['ap@maple.example'], subject: 'Statement from Érablière Test Inc.' });
    expect(mail.sent[0].body.text).toContain('$277.70');
  });

  it('sends each reminder stage once, skips paid invoices, and charges one late fee per invoice', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await root.put(`/companies/${co.id}/collections/settings`, { reminders: { enabled: true, stages: [1, 7] }, lateFees: { enabled: true, type: 'PERCENT', amount: '2', graceDays: 30, accountId: co.acct['4900'], taxCodeId: co.tax.EXEMPT } }).expect(200);
    const overdue = await postedInvoice(root, co, { issueDate: '2026-09-01', dueDate: '2026-10-01' });
    const paid = await postedInvoice(root, co, { issueDate: '2026-09-01', dueDate: '2026-10-01' });
    await pay(root, co, paid.id, '113.00', '2026-09-10');

    expect(await automation.runReminders('2026-10-03')).toEqual({ sent: 1 });
    expect(await automation.runReminders('2026-10-05')).toEqual({ sent: 0 });
    expect(await automation.runReminders('2026-10-09')).toEqual({ sent: 1 }); // stage 7
    expect(mail.sent.map((m) => m.body.subject)).toEqual([`Reminder: invoice ${overdue.number} is overdue`, `Reminder: invoice ${overdue.number} is overdue`]);
    expect(mail.sent[0].headers['idempotency-key']).toBe(`reminder-${overdue.id}-1`);
    expect(mail.sent[0].body.text).toMatch(/View it online: http:\/\/localhost:3000\/i\/[\w-]{32}/);

    expect(await automation.runLateFees('2026-10-31')).toEqual({ charged: 0 }); // grace period not over
    expect(await automation.runLateFees('2026-11-01')).toEqual({ charged: 1 });
    expect(await automation.runLateFees('2026-11-02')).toEqual({ charged: 0 }); // once per invoice
    const fee = await prisma.invoice.findUniqueOrThrow({ where: { lateFeeForId: overdue.id } });
    expect(fee).toMatchObject({ status: 'POSTED', number: 'INV-0003' });
    expect(fee.total.toString()).toBe('2.26'); // 2 % of 113.00, exempt
    expect(await prisma.auditEvent.count({ where: { action: 'invoice.late_fee' } })).toBe(1);
  });
});

describe('credits and paying bills', () => {
  it('applies a supplier credit to a bill, refuses over-application, unapplies it, and pays several suppliers at once', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const v2 = (await root.post(`/companies/${co.id}/contacts`, { kind: 'VENDOR', name: 'Bottle Co' }).expect(201)).body.id;
    const bill = async (contactId: string, amount: string, kind = 'STANDARD') => {
      const b = (await root.post(`/companies/${co.id}/bills`, { contactId, issueDate: '2026-10-01', dueDate: '2026-10-31', kind, lines: [{ description: 'Supplies', quantity: '1', unitPrice: amount, accountId: co.acct['6050'], taxCodeId: co.tax.HST_ON }] }).expect(201)).body;
      return (await root.post(`/companies/${co.id}/bills/${b.id}/post`).expect(201)).body;
    };
    const b1 = await bill(co.vendor, '100.00'); const b2 = await bill(v2, '50.00'); const vc = await bill(co.vendor, '20.00', 'CREDIT');
    expect((await root.post(`/companies/${co.id}/bills/${b1.id}/apply-credit`, { creditId: vc.id, amount: '30.00' })).body.code).toBe('OVER_ALLOCATION');
    expect((await root.post(`/companies/${co.id}/bills/${b2.id}/apply-credit`, { creditId: vc.id, amount: '5.00' })).body.code).toBe('CONTACT_MISMATCH');
    const app1 = (await root.post(`/companies/${co.id}/bills/${b1.id}/apply-credit`, { creditId: vc.id, amount: '22.60' }).expect(201)).body;
    expect((await root.get(`/companies/${co.id}/bills/${b1.id}`).expect(200)).body).toMatchObject({ status: 'PARTIAL', amountPaid: '22.6' });
    expect((await root.get(`/companies/${co.id}/bills/${vc.id}`).expect(200)).body.status).toBe('PAID');
    expect((await root.post(`/companies/${co.id}/bills/${b1.id}/void`)).body.code).toBe('HAS_PAYMENTS');
    await root.post(`/companies/${co.id}/credit-applications/${app1.id}/unapply`).expect(201);
    expect((await root.get(`/companies/${co.id}/bills/${b1.id}`).expect(200)).body).toMatchObject({ status: 'POSTED', amountPaid: '0' });
    await root.post(`/companies/${co.id}/bills/${b1.id}/apply-credit`, { creditId: vc.id, amount: '22.60' }).expect(201);

    const paid = (await root.post(`/companies/${co.id}/bills/pay`, { bankAccountId: co.acct['1010'], date: '2026-10-20', reference: 'Cheque run', bills: [{ billId: b1.id, amount: '90.40' }, { billId: b2.id, amount: '56.50' }] }).expect(201)).body;
    expect(paid).toHaveLength(2);
    expect((await root.get(`/companies/${co.id}/bills/${b1.id}`).expect(200)).body.status).toBe('PAID');
    expect((await root.get(`/companies/${co.id}/bills/${b2.id}`).expect(200)).body.status).toBe('PAID');
    // all or nothing: one bad line and no payment is made
    const b3 = await bill(co.vendor, '10.00');
    await root.post(`/companies/${co.id}/bills/pay`, { bankAccountId: co.acct['1010'], date: '2026-10-21', bills: [{ billId: b3.id, amount: '5.00' }, { billId: b2.id, amount: '1.00' }] }).expect(409);
    expect((await root.get(`/companies/${co.id}/bills/${b3.id}`).expect(200)).body.status).toBe('POSTED');
  });
});
