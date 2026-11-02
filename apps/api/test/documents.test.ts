import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@ca/database';
import { ORIGIN, bootApp, resetDb, setupAdmin } from './helpers';
import { PNG, company, fakeResend, postedInvoice } from './fixtures';

let app: INestApplication;
let prisma: PrismaClient;
let mail: ReturnType<typeof fakeResend>;
beforeAll(async () => ({ app, prisma } = await bootApp({ RESEND_API_KEY: 're_test_key', MAIL_FROM: 'billing@mail.example.test' })));
afterAll(async () => { await prisma.$disconnect(); await app.close(); });
beforeEach(async () => { await resetDb(prisma); mail = fakeResend(); });

describe('branding', () => {
  it('saves the template and sender details, accepts PNG/JPEG logos only (by content), and renders a preview', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const b = (await root.put(`/companies/${co.id}/branding`, { template: { accent: '#1d4ed8', layout: 'classic', footer: 'Merci!', paymentInstructions: 'Interac e-Transfer to pay@example.test', emails: { invoice: { subject: 'Your invoice {{number}}', body: 'Hi {{customer}}, {{balance}} due {{dueDate}}. {{link}}' } } }, emailFromName: 'Érablière Billing', emailReplyTo: 'Books@Example.test' }).expect(200)).body;
    expect(b).toMatchObject({ template: { accent: '#1d4ed8', layout: 'classic' }, emailFromName: 'Érablière Billing', emailReplyTo: 'books@example.test', hasLogo: false });
    expect((await root.put(`/companies/${co.id}/branding`, { template: { accent: 'blue' } })).body.code).toBe('VALIDATION_ERROR');

    const up = (path: string, bytes: Buffer) => root.raw.post(path).set('Origin', ORIGIN).set('Content-Type', 'application/octet-stream').send(bytes);
    expect((await up(`/companies/${co.id}/branding/logo`, Buffer.from('GIF89a......')).expect(400)).body.code).toBe('UNSUPPORTED_IMAGE');
    expect((await up(`/companies/${co.id}/branding/logo`, Buffer.concat([PNG, Buffer.alloc(1024 * 1024)])).expect(400)).body.code).toBe('TOO_LARGE');
    await up(`/companies/${co.id}/branding/logo`, PNG).expect(201);
    const logo = await root.get(`/companies/${co.id}/branding/logo`).expect(200);
    expect(logo.headers['content-type']).toBe('image/png');
    const pdf = await root.raw.get(`/companies/${co.id}/branding/preview.pdf`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    await root.delete(`/companies/${co.id}/branding/logo`).expect(204);
    await root.get(`/companies/${co.id}/branding/logo`).expect(404);
  });
});

describe('e-mailing documents (Resend)', () => {
  it('sends a posted invoice with its PDF, the company template, a customer link, and logs the delivery', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await root.put(`/companies/${co.id}/branding`, { emailFromName: 'Érablière <Billing>', emailReplyTo: 'books@example.test', template: { emails: { invoice: { subject: 'Invoice {{number}} — {{total}}', body: 'Hi {{customer}},\n\n{{balance}} is due {{dueDate}}.\n\nPay here: {{link}}' } } } });
    const draft = (await root.post(`/companies/${co.id}/invoices`, { contactId: co.customer, issueDate: '2026-10-01', dueDate: '2026-10-31', lines: [{ description: 'x', quantity: '1', unitPrice: '10', accountId: co.acct['4000'], taxCodeId: co.tax.HST_ON }] }).expect(201)).body;
    expect((await root.post(`/companies/${co.id}/invoices/${draft.id}/send`, { to: ['ap@maple.example'] }).expect(409)).body.code).toBe('NOT_SENDABLE');

    const inv = await postedInvoice(root, co);
    const pre = (await root.get(`/companies/${co.id}/invoices/${inv.id}/email`).expect(200)).body;
    expect(pre).toMatchObject({ to: ['ap@maple.example'], subject: 'Invoice INV-0001 — $113.00', mailConfigured: true });

    const row = (await root.post(`/companies/${co.id}/invoices/${inv.id}/send`, { to: ['AP@maple.example'], cc: ['owner@maple.example', 'ap@maple.example'] }).expect(201)).body;
    expect(row).toMatchObject({ status: 'SENT', providerId: 'email_1', kind: 'invoice', to: ['ap@maple.example'], cc: ['owner@maple.example'] });
    const req = mail.sent[0];
    expect(req.headers.authorization).toBe('Bearer re_test_key');
    expect(req.body.from).toBe('Érablière Billing <billing@mail.example.test>'); // < > stripped from the display name
    expect(req.body).toMatchObject({ to: ['ap@maple.example'], cc: ['owner@maple.example'], reply_to: 'books@example.test', subject: 'Invoice INV-0001 — $113.00', tags: [{ name: 'kind', value: 'invoice' }] });
    expect(req.body.attachments![0].filename).toBe('invoice-INV-0001.pdf');
    expect(Buffer.from(req.body.attachments![0].content, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(stored.payToken).toMatch(/^[\w-]{32}$/);
    expect(stored.lastSentAt).not.toBeNull();
    expect(req.body.text).toContain(`Pay here: ${ORIGIN}/i/${stored.payToken}`);
    expect(req.body.text).toContain('$113.00 is due 2026-10-31');
    expect(req.body.html).toContain(`href="${ORIGIN}/i/${stored.payToken}"`);
    expect(req.body.html).not.toContain('<Billing>');

    // the provider refuses: nothing pretends it was sent
    mail.failNext(422, 'The domain is not verified');
    const bad = (await root.post(`/companies/${co.id}/invoices/${inv.id}/send`, { to: ['ap@maple.example'] }).expect(502)).body;
    expect(bad).toMatchObject({ code: 'MAIL_FAILED' });
    expect(bad.message).toContain('The domain is not verified');
    const log = (await root.get(`/companies/${co.id}/emails?documentId=${inv.id}`).expect(200)).body;
    expect(log.map((l: { status: string }) => l.status)).toEqual(['FAILED', 'SENT']);
  });

  it('sends a sales receipt, and another company cannot send or read this company\'s documents', async () => {
    const root = await setupAdmin(app); const co = await company(root); const other = await company(root, { legalName: 'Other Co' });
    const r = (await root.post(`/companies/${co.id}/sales-receipts`, { contactId: co.customer, date: '2026-10-20', paymentMethod: 'CASH', depositAccountId: co.acct['1010'], lines: [{ description: 'Tour', quantity: '1', unitPrice: '20', accountId: co.acct['4000'], taxCodeId: co.tax.HST_ON }], post: true }).expect(201)).body;
    await root.post(`/companies/${co.id}/sales-receipts/${r.id}/send`, { to: ['ap@maple.example'] }).expect(201);
    expect(mail.sent[0].body.subject).toBe('Sales receipt SR-0001 from Érablière Test Inc.');
    await root.post(`/companies/${other.id}/sales-receipts/${r.id}/send`, { to: ['ap@maple.example'] }).expect(404);
    expect(mail.sent).toHaveLength(1);
  });
});
