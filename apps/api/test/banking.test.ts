import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@ca/database';
import { PASSWORD, ORIGIN, agent, bootApp, resetDb, setupAdmin } from './helpers';
import { bankingFetch } from '../src/banking/banking.module';

type A = ReturnType<typeof agent>;
let app: INestApplication;
let prisma: PrismaClient;
const plaid = { pages: {} as Record<string, unknown>, fail: null as null | { status: number; body: unknown }, calls: [] as { path: string; body: Record<string, unknown> }[] };

beforeAll(async () => {
  ({ app, prisma } = await bootApp({ PLAID_CLIENT_ID: 'pid', PLAID_SECRET: 'psecret', PLAID_ENV: 'sandbox', QUEUE_MODE: 'none' }));
  bankingFetch.fn = (async (url: string, init: { body: string }) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    plaid.calls.push({ path, body });
    if (plaid.fail) return new Response(JSON.stringify(plaid.fail.body), { status: plaid.fail.status });
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (path === '/link/token/create') return ok({ link_token: 'link-sandbox-1', expiration: '2026-11-01T00:00:00Z', request_id: 'r' });
    if (path === '/item/public_token/exchange') return ok({ access_token: 'access-sandbox-SECRET', item_id: 'item-1', request_id: 'r' });
    if (path === '/accounts/get') return ok({ accounts: PLAID_ACCOUNTS, request_id: 'r' });
    if (path === '/transactions/sync') return ok(plaid.pages[body.cursor ?? ''] ?? { accounts: PLAID_ACCOUNTS, added: [], modified: [], removed: [], next_cursor: body.cursor ?? 'c0', has_more: false, request_id: 'r' });
    if (path === '/item/remove') return ok({ request_id: 'r' });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
});
afterAll(async () => { await prisma.$disconnect(); await app.close(); });
beforeEach(async () => { await resetDb(prisma); plaid.pages = {}; plaid.fail = null; plaid.calls = []; });

const PLAID_ACCOUNTS = [
  { account_id: 'pa-chq', name: 'Everyday Chequing', official_name: null, mask: '0000', type: 'depository', subtype: 'checking', balances: { current: 1000, iso_currency_code: 'CAD' } },
  { account_id: 'pa-visa', name: 'Visa', official_name: null, mask: '4242', type: 'credit', subtype: 'credit card', balances: { current: 80, iso_currency_code: 'CAD' } },
];
const ptx = (id: string, acct: string, amount: number, date: string, name: string, pending = false) => ({ transaction_id: id, account_id: acct, amount, iso_currency_code: 'CAD', date, name, merchant_name: null, pending });

async function company(root: A, name = 'Maple Goods Inc.') {
  const c = (await root.post('/admin/companies', { legalName: name, province: 'ON', ownerEmail: 'root@example.test' }).expect(201)).body;
  await root.post(`/companies/${c.id}/fiscal-years`, { startDate: '2026-01-01' });
  const accts = (await root.get(`/companies/${c.id}/accounts`).expect(200)).body as { id: string; code: string }[];
  const codes = (await root.get(`/companies/${c.id}/tax-codes`).expect(200)).body as { id: string; code: string }[];
  const customer = (await root.post(`/companies/${c.id}/contacts`, { kind: 'CUSTOMER', name: 'Acme Customer' }).expect(201)).body.id;
  const vendor = (await root.post(`/companies/${c.id}/contacts`, { kind: 'VENDOR', name: 'Acme Supplier' }).expect(201)).body.id;
  const acct = Object.fromEntries(accts.map((a) => [a.code, a.id])) as Record<string, string>;
  const tax = Object.fromEntries(codes.map((a) => [a.code, a.id])) as Record<string, string>;
  // Opening balance in the books: $1,000.00 cash for share capital, before any bank activity.
  await root.post(`/companies/${c.id}/journals`, { date: '2026-08-31', post: true, lines: [{ accountId: acct['1010'], debit: '1000.00', credit: '0' }, { accountId: acct['3000'], debit: '0', credit: '1000.00' }] }).expect(201);
  const bank = (await root.post(`/companies/${c.id}/banking/accounts`, { name: 'Everyday Chequing', kind: 'CHEQUING', mask: '0000', ledgerAccountId: acct['1010'] }).expect(201)).body;
  return { id: c.id as string, acct, tax, customer, vendor, bank: bank.id as string };
}
type Co = Awaited<ReturnType<typeof company>>;
const base = (co: Co) => `/companies/${co.id}/banking`;

const CSV_MAPPING = { hasHeader: true, dateColumn: 0, dateFormat: 'YMD', descriptionColumns: [1], amount: { mode: 'split', debitColumn: 2, creditColumn: 3 } };
const CSV = `Date,Description,Withdrawals,Deposits
2026-10-05,SHOPIFY* PAYOUT TRACE1,,120.38
2026-10-06,HYDRO ONE NETWORKS,84.20,
2026-10-06,TIM HORTONS #123,4.15,
2026-10-06,TIM HORTONS #123,4.15,
2026-10-07,E-TRANSFER ACME CUSTOMER,,113.00
`;
const send = (a: A, url: string, body: Buffer | string, extra: Record<string, string> = {}) => a.raw.post(url).set('Origin', ORIGIN).set('Content-Type', 'application/octet-stream').set(extra).send(Buffer.from(body));
const importCsv = (a: A, co: Co, csv = CSV, name = 'oct.csv', accountId = co.bank) => send(a, `${base(co)}/accounts/${accountId}/import/commit?filename=${name}`, csv, { 'X-Import-Mapping': JSON.stringify(CSV_MAPPING) });
const txns = async (a: A, co: Co, q = '') => (await a.get(`${base(co)}/transactions?${q}`).expect(200)).body.items as { id: string; date: string; description: string; amount: string; status: string; suggestions: { id: string; confidence: number; reasons: string[]; journalLineId: string }[]; suggestedAccount: { code: string } | null; matchedEntry: { number: number | null; sourceType: string } | null }[];
const find = (list: Awaited<ReturnType<typeof txns>>, text: string) => list.filter((t) => t.description.includes(text));
const tb = async (a: A, co: Co) => (await a.get(`/companies/${co.id}/reports/trial-balance?asOf=2026-12-31`).expect(200)).body;
const bal = (t: { rows: { code: string; debit: string; credit: string }[] }, code: string) => { const r = t.rows.find((x) => x.code === code); return r ? (Number(r.debit) - Number(r.credit)).toFixed(2) : '0.00'; };
const journalCount = (co: Co) => prisma.journalEntry.count({ where: { companyId: co.id } });
async function member(root: A, co: Co, role: string) {
  const email = `${role.toLowerCase()}@example.test`;
  await root.post(`/companies/${co.id}/members`, { email, name: role, role, temporaryPassword: PASSWORD }).expect(201);
  const a = agent(app);
  await a.post('/auth/login', { email, password: PASSWORD }).expect(200);
  await a.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' }).expect(204);
  return a;
}
async function invoice(root: A, co: Co, amount = '100.00') {
  const inv = (await root.post(`/companies/${co.id}/invoices`, { contactId: co.customer, issueDate: '2026-09-20', dueDate: '2026-10-20', lines: [{ description: 'Syrup', quantity: '1', unitPrice: amount, accountId: co.acct['4000'], taxCodeId: co.tax.HST_ON }] }).expect(201)).body;
  return (await root.post(`/companies/${co.id}/invoices/${inv.id}/post`).expect(201)).body;
}

describe('statement import', () => {
  it('previews without saving, imports, preserves the original bytes, keeps genuine duplicates, and refuses the same file twice', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const hdr = (await send(root, `${base(co)}/accounts/${co.bank}/import/preview?filename=oct.csv`, CSV).expect(200)).body;
    expect(hdr.csv.headers).toEqual(['Date', 'Description', 'Withdrawals', 'Deposits']);
    expect(hdr.csv.suggested).toMatchObject({ confident: true, amount: { mode: 'split' } });
    expect(hdr.summary).toBeUndefined();
    const pv = (await send(root, `${base(co)}/accounts/${co.bank}/import/preview?filename=oct.csv`, CSV, { 'X-Import-Mapping': JSON.stringify(CSV_MAPPING) }).expect(200)).body;
    expect(pv.summary).toMatchObject({ total: 5, newCount: 5, duplicateCount: 0, errorCount: 0 });
    expect(await prisma.bankTransaction.count()).toBe(0); // preview saves nothing
    const c1 = (await importCsv(root, co).expect(201)).body;
    expect(c1).toMatchObject({ imported: 5, skippedDuplicates: 0, failed: 0 });
    const all = await txns(root, co);
    expect(find(all, 'TIM HORTONS')).toHaveLength(2);
    expect(all.find((t) => t.description.includes('SHOPIFY'))!.amount).toBe('120.38');
    expect(all.find((t) => t.description.includes('HYDRO'))!.amount).toBe('-84.2');
    const st = (await root.get(`${base(co)}/statements`).expect(200)).body[0];
    const dl = await root.raw.get(`${base(co)}/statements/${st.id}/download`).expect(200).buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); });
    expect(Buffer.from(dl.body).toString()).toBe(CSV);
    expect(createHash('sha256').update(dl.body).digest('hex')).toBe(st.sha256);
    const again = await importCsv(root, co);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('FILE_ALREADY_IMPORTED');
  });
  it('an overlapping statement imports only the new rows', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await importCsv(root, co).expect(201);
    const longer = CSV + '2026-10-08,GROCERY STORE,52.10,\n2026-10-06,TIM HORTONS #123,4.15,\n';
    const r = (await importCsv(root, co, longer, 'oct-extended.csv').expect(201)).body;
    expect(r).toMatchObject({ imported: 2, skippedDuplicates: 5 }); // a third genuine Tim Hortons + the grocery row
    expect(await prisma.bankTransaction.count()).toBe(7);
  });
  it('row errors need an explicit acknowledgement; PDFs and binaries are refused with a helpful message; oversized uploads are rejected', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const bad = CSV + '2026-13-40,BAD DATE,1.00,\n';
    const r = await importCsv(root, co, bad);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('ROW_ERRORS');
    const ok = await send(root, `${base(co)}/accounts/${co.bank}/import/commit?filename=bad.csv`, bad, { 'X-Import-Mapping': JSON.stringify(CSV_MAPPING), 'X-Import-Accept-Errors': 'true' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ imported: 5, failed: 1 });
    const pdf = await send(root, `${base(co)}/accounts/${co.bank}/import/preview?filename=s.pdf`, '%PDF-1.7 binary');
    expect(pdf.status).toBe(415);
    expect(pdf.body.code).toBe('PDF_NOT_SUPPORTED');
    expect((await send(root, `${base(co)}/accounts/${co.bank}/import/preview?filename=x`, Buffer.from([0x50, 0x4b, 0, 3, 4]))).status).toBe(415);
    expect((await send(root, `${base(co)}/accounts/${co.bank}/import/preview?filename=x`, '')).status).toBe(400);
    expect((await send(root, `${base(co)}/accounts/${co.bank}/import/preview?filename=big.csv`, Buffer.alloc(11 * 1024 * 1024, 97))).status).toBe(413);
    expect((await send(root, `${base(co)}/accounts/${co.bank}/import/preview?filename=x`, CSV, { 'X-Import-Mapping': '{"dateColumn":"zero"}' })).body.code).toBe('VALIDATION_ERROR');
  });
  it('imports OFX 1.x and QFX statements, stores the stated balance and warns about an account mismatch', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const ofx = `OFXHEADER:100\nDATA:OFXSGML\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>CAD\n<BANKACCTFROM><BANKID>1<ACCTID>99991111<ACCTTYPE>CHECKING</BANKACCTFROM>\n<BANKTRANLIST><DTSTART>20261001<DTEND>20261031\n<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261005<TRNAMT>120.38<FITID>A1<NAME>SHOPIFY PAYOUT</STMTTRN>\n<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261006<TRNAMT>-84.20<FITID>A2<NAME>HYDRO ONE</STMTTRN>\n</BANKTRANLIST><LEDGERBAL><BALAMT>1036.18<DTASOF>20261031</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const pv = (await send(root, `${base(co)}/accounts/${co.bank}/import/preview?filename=a.qfx`, ofx).expect(200)).body;
    expect(pv.format).toBe('ofx');
    expect(pv.warnings.join()).toMatch(/ending 1111/);
    expect(pv.summary).toMatchObject({ total: 2, newCount: 2 });
    const r = (await send(root, `${base(co)}/accounts/${co.bank}/import/commit?filename=a.qfx`, ofx).expect(201)).body;
    expect(r.imported).toBe(2);
    expect((await prisma.bankStatement.findFirstOrThrow()).endingBalance?.toString()).toBe('1036.18');
    // re-exporting the same FITIDs under a different file (e.g. extra whitespace) imports nothing new
    const r2 = (await send(root, `${base(co)}/accounts/${co.bank}/import/commit?filename=b.qfx`, ofx + '\n').expect(201)).body;
    expect(r2).toMatchObject({ imported: 0, skippedDuplicates: 2 });
  });
});

describe('matching: suggestions never post; approval links exactly once', () => {
  it('suggests ledger lines by amount/date/text, approval links, rejection is remembered, and no journal is ever created', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const inv = await invoice(root, co); // 113.00
    await root.post(`/companies/${co.id}/payments`, { direction: 'RECEIPT', contactId: co.customer, bankAccountId: co.acct['1010'], date: '2026-10-07', amount: '113.00', reference: 'E-transfer Acme', allocations: [{ documentId: inv.id, amount: '113.00' }] }).expect(201);
    await root.post(`/companies/${co.id}/journals`, { date: '2026-10-05', post: true, memo: 'Shopify payout 9001', lines: [{ accountId: co.acct['1010'], debit: '120.38', credit: '0' }, { accountId: co.acct['4000'], debit: '0', credit: '120.38' }] }).expect(201);
    const before = await journalCount(co);
    await importCsv(root, co).expect(201);
    expect(await journalCount(co)).toBe(before);
    const list = await txns(root, co);
    const deposit = find(list, 'ACME CUSTOMER')[0];
    expect(deposit.suggestions).toHaveLength(1);
    expect(deposit.suggestions[0].confidence).toBeGreaterThan(0.8);
    expect(deposit.status).toBe('UNMATCHED');
    const payout = find(list, 'SHOPIFY')[0];
    expect(payout.suggestions[0].confidence).toBeGreaterThan(0.9);
    expect(find(list, 'HYDRO')[0].suggestions).toHaveLength(0);
    await root.post(`${base(co)}/matches/${deposit.suggestions[0].id}/approve`).expect(201);
    expect(await journalCount(co)).toBe(before);
    const after = await txns(root, co);
    expect(find(after, 'ACME CUSTOMER')[0]).toMatchObject({ status: 'MATCHED', matchedEntry: { sourceType: 'payment' } });
    await root.post(`${base(co)}/matches/${deposit.suggestions[0].id}/approve`).expect(409); // already decided
    await root.post(`${base(co)}/matches/${payout.suggestions[0].id}/reject`).expect(204);
    await root.post(`${base(co)}/accounts/${co.bank}/suggest`).expect(201);
    expect(find(await txns(root, co), 'SHOPIFY')[0].suggestions).toHaveLength(0); // not re-suggested
  });
  it('a ledger line can only match one bank transaction; ambiguous candidates score lower and are not swept up by bulk approval', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    for (let i = 0; i < 2; i++) await root.post(`/companies/${co.id}/journals`, { date: '2026-10-06', post: true, memo: 'Coffee run', lines: [{ accountId: co.acct['6110'], debit: '4.15', credit: '0' }, { accountId: co.acct['1010'], debit: '0', credit: '4.15' }] }).expect(201);
    await root.post(`/companies/${co.id}/journals`, { date: '2026-10-05', post: true, memo: 'Shopify payout', lines: [{ accountId: co.acct['1010'], debit: '120.38', credit: '0' }, { accountId: co.acct['4000'], debit: '0', credit: '120.38' }] }).expect(201);
    await importCsv(root, co).expect(201);
    const list = await txns(root, co);
    const coffee = find(list, 'TIM HORTONS');
    expect(coffee.every((t) => t.suggestions.length === 2 && t.suggestions[0].confidence < 0.8 && t.suggestions[0].reasons.some((r) => /ambiguous/.test(r)))).toBe(true);
    const r = (await root.post(`${base(co)}/matches/approve-bulk`, { bankAccountId: co.bank, minConfidence: 0.9 }).expect(201)).body;
    expect(r.approved).toBe(1); // only the Shopify payout
    const after = await txns(root, co);
    expect(find(after, 'TIM HORTONS').map((t) => t.status)).toEqual(['UNMATCHED', 'UNMATCHED']);
    // manual match the first coffee, then the second transaction cannot take the same line
    const line = coffee[0].suggestions[0].journalLineId;
    await root.post(`${base(co)}/transactions/${coffee[0].id}/match`, { journalLineId: line }).expect(201);
    expect((await root.post(`${base(co)}/transactions/${coffee[1].id}/match`, { journalLineId: line })).body.code).toBe('LINE_TAKEN');
    const wrong = await root.post(`${base(co)}/transactions/${coffee[1].id}/match`, { journalLineId: (await prisma.journalLine.findFirstOrThrow({ where: { accountId: co.acct['4000'] } })).id });
    expect(wrong.body.code).toBe('INVALID_LINE');
    await root.post(`${base(co)}/matches/approve-bulk`, { bankAccountId: co.bank, minConfidence: 0.5 }).expect(400); // floor is 0.9
  });
  it('reversed entries and their reversals are never offered as candidates', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const j = (await root.post(`/companies/${co.id}/journals`, { date: '2026-10-07', post: true, memo: 'Acme', lines: [{ accountId: co.acct['1010'], debit: '113.00', credit: '0' }, { accountId: co.acct['4000'], debit: '0', credit: '113.00' }] }).expect(201)).body;
    await root.post(`/companies/${co.id}/journals/${j.id}/reverse`, {}).expect(201);
    await importCsv(root, co).expect(201);
    expect(find(await txns(root, co), 'ACME CUSTOMER')[0].suggestions).toHaveLength(0);
  });
  it('unmatching releases a transaction, and reconciled ones cannot be touched', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await root.post(`/companies/${co.id}/journals`, { date: '2026-10-07', post: true, memo: 'Acme', lines: [{ accountId: co.acct['1010'], debit: '113.00', credit: '0' }, { accountId: co.acct['4000'], debit: '0', credit: '113.00' }] }).expect(201);
    await importCsv(root, co).expect(201);
    const t = find(await txns(root, co), 'ACME CUSTOMER')[0];
    await root.post(`${base(co)}/matches/${t.suggestions[0].id}/approve`).expect(201);
    await root.post(`${base(co)}/transactions/${t.id}/unmatch`).expect(204);
    expect(find(await txns(root, co), 'ACME CUSTOMER')[0].status).toBe('UNMATCHED');
    await root.post(`${base(co)}/transactions/${t.id}/unmatch`).expect(409);
  });
});

describe('creating entries from bank transactions', () => {
  it('categorises a tax-inclusive withdrawal with an ITC; the entry is balanced and the transaction matched', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await importCsv(root, co, `Date,Description,Withdrawals,Deposits\n2026-10-06,HYDRO ONE,113.00,\n`).expect(201);
    const t = (await txns(root, co))[0];
    const r = (await root.post(`${base(co)}/transactions/${t.id}/categorize`, { lines: [{ accountId: co.acct['6130'], amount: '113.00', taxCodeId: co.tax.HST_ON }], taxInclusive: true }).expect(201)).body;
    expect(r.number).toBeGreaterThan(0);
    const tr = await tb(root, co);
    expect(bal(tr, '6130')).toBe('100.00');
    expect(bal(tr, '1150')).toBe('13.00');
    expect(bal(tr, '1010')).toBe('887.00');
    expect(tr.totals.balanced).toBe(true);
    expect((await txns(root, co))[0]).toMatchObject({ status: 'MATCHED', matchedEntry: { sourceType: 'bank_txn' } });
    expect((await root.post(`${base(co)}/transactions/${t.id}/categorize`, { lines: [{ accountId: co.acct['6130'], amount: '113.00' }], taxInclusive: true })).status).toBe(409);
  });
  it('splits across accounts; refuses splits that do not add up, bank-account targets, and tax on the wrong kind of account', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await importCsv(root, co, `Date,Description,Withdrawals,Deposits\n2026-10-06,OFFICE DEPOT,200.00,\n2026-10-07,CLIENT PAYMENT,,500.00\n`).expect(201);
    const [dep, wd] = await txns(root, co);
    const url = (t: { id: string }) => `${base(co)}/transactions/${t.id}/categorize`;
    expect((await root.post(url(wd), { lines: [{ accountId: co.acct['6050'], amount: '150.00' }, { accountId: co.acct['6070'], amount: '49.99' }], taxInclusive: true })).body.code).toBe('SPLIT_MISMATCH');
    expect((await root.post(url(wd), { lines: [{ accountId: co.acct['1010'], amount: '200.00' }], taxInclusive: true })).body.code).toBe('INVALID_ACCOUNT');
    expect((await root.post(url(wd), { lines: [{ accountId: co.acct['1100'], amount: '200.00' }], taxInclusive: true })).body.code).toBe('INVALID_ACCOUNT');
    expect((await root.post(url(dep), { lines: [{ accountId: co.acct['6050'], amount: '500.00', taxCodeId: co.tax.HST_ON }], taxInclusive: true })).body.code).toBe('TAX_ACCOUNT_TYPE');
    expect((await root.post(url(wd), { lines: [{ accountId: co.acct['4000'], amount: '200.00', taxCodeId: co.tax.HST_ON }], taxInclusive: true })).body.code).toBe('TAX_ACCOUNT_TYPE');
    expect(await journalCount(co)).toBe(1); // only the opening entry: nothing leaked from failed attempts
    await root.post(url(wd), { lines: [{ accountId: co.acct['6050'], amount: '150.00' }, { accountId: co.acct['6070'], amount: '50.00' }], taxInclusive: true }).expect(201);
    const r = await root.post(url(dep), { lines: [{ accountId: co.acct['4000'], amount: '500.00', taxCodeId: co.tax.HST_ON }], taxInclusive: false });
    expect(r.status).toBe(422); // 500 + 13% = 565 ≠ 500
    await root.post(url(dep), { lines: [{ accountId: co.acct['4000'], amount: '500.00', taxCodeId: co.tax.HST_ON }], taxInclusive: true }).expect(201);
    const tr = await tb(root, co);
    expect(bal(tr, '4000')).toBe('-442.48'); // 500 / 1.13
    expect(bal(tr, '2200')).toBe('-57.52');
    expect(bal(tr, '1010')).toBe('1300.00');
  });
  it('a locked period stops the posting and leaves the transaction unmatched', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await importCsv(root, co, `Date,Description,Withdrawals,Deposits\n2026-10-06,RENT,900.00,\n`).expect(201);
    const periods = (await root.get(`/companies/${co.id}/periods`).expect(200)).body as { id: string; label: string }[];
    await root.patch(`/companies/${co.id}/periods/${periods.find((p) => p.label === '2026-10')!.id}`, { locked: true }).expect(200);
    const t = (await txns(root, co))[0];
    expect((await root.post(`${base(co)}/transactions/${t.id}/categorize`, { lines: [{ accountId: co.acct['6070'], amount: '900.00' }], taxInclusive: true })).body.code).toBe('PERIOD_LOCKED');
    expect((await txns(root, co))[0].status).toBe('UNMATCHED');
  });
  it('settles invoices with partial payments through the normal payment code, all-or-nothing', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const inv = await invoice(root, co); // 113.00
    await importCsv(root, co, `Date,Description,Withdrawals,Deposits\n2026-10-07,E-TRANSFER ACME CUSTOMER,,50.00\n2026-10-09,E-TRANSFER ACME CUSTOMER,,63.00\n2026-10-10,E-TRANSFER ACME CUSTOMER,,10.00\n`).expect(201);
    const [t3, t2, t1] = await txns(root, co); // newest first
    const sugg = (await root.get(`${base(co)}/transactions/${t1.id}/documents`).expect(200)).body;
    expect(sugg[0]).toMatchObject({ kind: 'invoice', documentId: inv.id, outstanding: '113.00' });
    expect(sugg[0].reasons).toContain('looks like a partial payment');
    await root.post(`${base(co)}/transactions/${t1.id}/settle`, { contactId: co.customer, allocations: [{ documentId: inv.id, amount: '50.00' }] }).expect(201);
    expect((await root.get(`/companies/${co.id}/invoices/${inv.id}`).expect(200)).body).toMatchObject({ status: 'PARTIAL', amountPaid: '50' });
    await root.post(`${base(co)}/transactions/${t3.id}/settle`, { contactId: co.customer, allocations: [{ documentId: inv.id, amount: '10.00' }] }).expect(201);
    const over = await root.post(`${base(co)}/transactions/${t2.id}/settle`, { contactId: co.customer, allocations: [{ documentId: inv.id, amount: '63.00' }] });
    expect(over.body.code).toBe('OVER_ALLOCATION'); // only 53 outstanding after the 10
    expect((await txns(root, co)).find((t) => t.id === t2.id)!.status).toBe('UNMATCHED');
    expect(await prisma.payment.count()).toBe(2); // the failed attempt left nothing behind
    expect(bal(await tb(root, co), '1100')).toBe('53.00');
  });
  it('transfers between own accounts: one entry, both sides matched, no income or expense; a one-sided transfer leaves a suggestion for the other account', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const savings = (await root.post(`${base(co)}/accounts`, { name: 'Savings', kind: 'SAVINGS', newLedgerAccount: { code: '1015', name: 'Savings Account' } }).expect(201)).body;
    await importCsv(root, co, `Date,Description,Withdrawals,Deposits\n2026-10-01,TRANSFER TO SAVINGS,500.00,\n2026-10-12,TRANSFER TO SAVINGS 2,200.00,\n`).expect(201);
    await importCsv(root, co, `Date,Description,Withdrawals,Deposits\n2026-10-02,TRANSFER FROM CHEQUING,,500.00\n`, 'sav.csv', savings.id).expect(201);
    const cands = (await root.get(`${base(co)}/transfer-candidates`).expect(200)).body;
    expect(cands).toHaveLength(1);
    expect(cands[0].confidence).toBeGreaterThan(0.8);
    await root.post(`${base(co)}/transactions/${cands[0].fromId}/transfer`, { counterpartTxnId: cands[0].toId }).expect(201);
    let tr = await tb(root, co);
    expect(bal(tr, '1015')).toBe('500.00');
    expect(bal(tr, '1010')).toBe('500.00');
    expect(tr.rows.filter((r: { type: string }) => r.type === 'REVENUE' || r.type === 'EXPENSE')).toHaveLength(0);
    expect((await prisma.bankTransaction.findMany({ where: { status: 'MATCHED' } })).length).toBe(2);
    expect((await root.post(`${base(co)}/transactions/${cands[0].fromId}/transfer`, { counterpartTxnId: cands[0].toId })).status).toBe(409);
    const two = (await txns(root, co, `bankAccountId=${co.bank}&status=UNMATCHED`))[0];
    const r = (await root.post(`${base(co)}/transactions/${two.id}/transfer`, { toBankAccountId: savings.id }).expect(201)).body;
    expect(r.matchedBoth).toBe(false);
    tr = await tb(root, co);
    expect(bal(tr, '1015')).toBe('700.00');
    await importCsv(root, co, `Date,Description,Withdrawals,Deposits\n2026-10-13,TRANSFER FROM CHEQUING 2,,200.00\n`, 'sav2.csv', savings.id).expect(201);
    const arrived = find(await txns(root, co, `bankAccountId=${savings.id}`), 'CHEQUING 2')[0];
    expect(arrived.suggestions[0].confidence).toBeGreaterThan(0.7);
    await root.post(`${base(co)}/matches/${arrived.suggestions[0].id}/approve`).expect(201);
    expect(bal(await tb(root, co), '1015')).toBe('700.00'); // matching posted nothing new
    await root.post(`${base(co)}/transactions/${cands[0].fromId}/transfer`, { counterpartTxnId: cands[0].fromId }).expect(409);
    await importCsv(root, co, `Date,Description,Withdrawals,Deposits\n2026-10-20,LONELY,1.00,\n`, 'lonely.csv').expect(201);
    const lonely = find(await txns(root, co), 'LONELY')[0];
    expect((await root.post(`${base(co)}/transactions/${lonely.id}/transfer`, {})).body.code).toBe('COUNTERPART_REQUIRED');
  });
  it('undo reverses what was created from a transaction; a reversed entry is not offered again', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await importCsv(root, co, `Date,Description,Withdrawals,Deposits\n2026-10-06,RENT,900.00,\n`).expect(201);
    const t = (await txns(root, co))[0];
    await root.post(`${base(co)}/transactions/${t.id}/categorize`, { lines: [{ accountId: co.acct['6070'], amount: '900.00' }], taxInclusive: true }).expect(201);
    await root.post(`${base(co)}/transactions/${t.id}/undo`).expect(204);
    expect(bal(await tb(root, co), '6070')).toBe('0.00');
    const again = (await txns(root, co))[0];
    expect(again.status).toBe('UNMATCHED');
    expect(again.suggestions).toHaveLength(0);
    await root.post(`${base(co)}/transactions/${t.id}/categorize`, { lines: [{ accountId: co.acct['6070'], amount: '900.00' }], taxInclusive: true }).expect(201);
  });
  it('ignored transactions are excluded and can be restored', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await importCsv(root, co).expect(201);
    const t = find(await txns(root, co), 'HYDRO')[0];
    await root.post(`${base(co)}/transactions/${t.id}/ignore`, { reason: 'personal' }).expect(204);
    expect(find(await txns(root, co), 'HYDRO')[0]).toMatchObject({ status: 'IGNORED' });
    await root.post(`${base(co)}/transactions/${t.id}/unignore`).expect(204);
  });
});

describe('categorisation rules (suggestions only)', () => {
  it('suggests an account by priority, never posts, and ignores inactive or empty rules', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const rule = (name: string, priority: number, contains: string[], account: string, extra: object = {}) => root.post(`${base(co)}/rules`, { name, priority, conditions: { descriptionContains: contains, direction: 'OUT' }, accountId: co.acct[account], ...extra });
    await rule('Utilities', 50, ['hydro'], '6130').expect(201);
    await rule('Generic', 100, ['hydro one'], '6050').expect(201);
    await rule('Off', 1, ['tim hortons'], '6110', { isActive: false }).expect(201);
    expect((await root.post(`${base(co)}/rules`, { name: 'Empty', conditions: {}, accountId: co.acct['6050'] })).status).toBe(400);
    expect((await root.post(`${base(co)}/rules`, { name: 'Control', conditions: { descriptionContains: ['x'] }, accountId: co.acct['1100'] })).body.code).toBe('INVALID_ACCOUNT');
    const before = await journalCount(co);
    await importCsv(root, co).expect(201);
    const list = await txns(root, co);
    expect(find(list, 'HYDRO')[0].suggestedAccount).toMatchObject({ code: '6130' });
    expect(find(list, 'TIM HORTONS')[0].suggestedAccount).toBeNull();
    expect(find(list, 'SHOPIFY')[0].suggestedAccount).toBeNull(); // deposits do not match an OUT rule
    expect(await journalCount(co)).toBe(before);
    expect(find(list, 'HYDRO')[0].status).toBe('UNMATCHED');
  });
});

describe('reconciliation', () => {
  async function ready(root: A, co: Co) {
    // Books: $1,000 opening. Bank: statement opens at $1,000, then a $113 deposit (matched to a payment) and a $84.20 withdrawal (categorised).
    const inv = await invoice(root, co);
    await root.post(`/companies/${co.id}/payments`, { direction: 'RECEIPT', contactId: co.customer, bankAccountId: co.acct['1010'], date: '2026-10-07', amount: '113.00', allocations: [{ documentId: inv.id, amount: '113.00' }] }).expect(201);
    await importCsv(root, co, `Date,Description,Withdrawals,Deposits\n2026-10-06,HYDRO ONE,84.20,\n2026-10-07,E-TRANSFER ACME CUSTOMER,,113.00\n2026-11-02,NEXT MONTH,10.00,\n`).expect(201);
    const list = await txns(root, co);
    const dep = find(list, 'ACME')[0];
    await root.post(`${base(co)}/matches/${dep.suggestions[0].id}/approve`).expect(201);
    await root.post(`${base(co)}/transactions/${find(list, 'HYDRO')[0].id}/categorize`, { lines: [{ accountId: co.acct['6130'], amount: '84.20' }], taxInclusive: true }).expect(201);
  }
  const rec = (co: Co, q: Record<string, string>) => `${base(co)}/accounts/${co.bank}/reconciliation-preview?${new URLSearchParams(q)}`;

  it('completes only when opening + cleared equals the statement to the cent, then locks the transactions', async () => {
    const root = await setupAdmin(app); const co = await company(root); await ready(root, co);
    const q = { statementDate: '2026-10-31', statementBalance: '1028.80', openingBalance: '1000.00' };
    const pv = (await root.get(rec(co, q)).expect(200)).body;
    expect(pv.summary).toMatchObject({ opening: '1000.00', cleared: '28.80', computedEnding: '1028.80', difference: '0.00', balanced: true });
    expect(pv.cleared).toHaveLength(2);
    expect(pv.bookVsBank.unexplained).toBe('0.00');
    expect(pv.warnings).toEqual([]);
    const off = await root.post(`${base(co)}/accounts/${co.bank}/reconciliations`, { ...q, statementBalance: '1028.79' });
    expect(off.status).toBe(422);
    expect(off.body.code).toBe('RECON_DIFFERENCE');
    expect(off.body.difference).toBe('0.01'); // computed - statement
    expect((await root.post(`${base(co)}/accounts/${co.bank}/reconciliations`, { statementDate: '2026-10-31', statementBalance: '1028.80' })).body.code).toBe('OPENING_REQUIRED');
    const done = (await root.post(`${base(co)}/accounts/${co.bank}/reconciliations`, q).expect(201)).body;
    expect(done).toMatchObject({ status: 'COMPLETED', txnCount: 2, clearedTotal: '28.8' });
    const after = await txns(root, co);
    expect(after.filter((t) => t.status === 'RECONCILED')).toHaveLength(2);
    expect(after.find((t) => t.description === 'NEXT MONTH')!.status).toBe('UNMATCHED');
    // locked
    const hydro = find(after, 'HYDRO')[0];
    expect((await root.post(`${base(co)}/transactions/${hydro.id}/unmatch`)).status).toBe(403);
    expect((await root.post(`${base(co)}/transactions/${hydro.id}/undo`)).status).toBe(403);
    expect((await root.post(`${base(co)}/transactions/${hydro.id}/ignore`, {})).status).toBe(409);
    await expect(prisma.$executeRawUnsafe(`UPDATE "BankTransaction" SET amount = 1 WHERE id = '${hydro.id}'`)).rejects.toThrow(/cannot be modified/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "BankTransaction" WHERE id = '${hydro.id}'`)).rejects.toThrow(/cannot be deleted/);
    // the next statement starts from this one and must be later
    expect((await root.get(rec(co, { statementDate: '2026-10-15', statementBalance: '1' })).expect(422)).body.code).toBe('DATE_NOT_AFTER_LAST');
    const next = (await root.get(rec(co, { statementDate: '2026-11-30', statementBalance: '1018.80' })).expect(200)).body;
    expect(next.summary.opening).toBe('1028.80');
  });
  it('lists history, reports cleared and outstanding items, and reopens only the latest reconciliation', async () => {
    const root = await setupAdmin(app); const co = await company(root); await ready(root, co);
    // an outstanding item: a cheque written but not yet seen by the bank
    await root.post(`/companies/${co.id}/journals`, { date: '2026-10-30', post: true, memo: 'Cheque 101', lines: [{ accountId: co.acct['6070'], debit: '300.00', credit: '0' }, { accountId: co.acct['1010'], debit: '0', credit: '300.00' }] }).expect(201);
    const q = { statementDate: '2026-10-31', statementBalance: '1028.80', openingBalance: '1000.00' };
    expect((await root.get(rec(co, q)).expect(200)).body.bookVsBank).toMatchObject({ outstandingNet: '-300.00', unexplained: '0.00' });
    const r1 = (await root.post(`${base(co)}/accounts/${co.bank}/reconciliations`, q).expect(201)).body;
    const next = await tb(root, co);
    expect(bal(next, '1010')).toBe('728.80');
    const hist = (await root.get(`${base(co)}/reconciliations?bankAccountId=${co.bank}`).expect(200)).body;
    expect(hist).toHaveLength(1);
    const rep = (await root.get(`${base(co)}/reconciliations/${r1.id}`).expect(200)).body;
    expect(rep.summary).toMatchObject({ balanced: true, difference: '0.00' });
    expect(rep.cleared).toHaveLength(2);
    expect(rep.outstandingLedgerItems.map((l: { amount: string }) => l.amount)).toEqual(['-300.00']);
    // second reconciliation, then only that one can be reopened
    await importCsv(root, co, `Date,Description,Withdrawals,Deposits\n2026-11-02,CHEQUE 101 CLEARED,300.00,\n`, 'nov.csv').expect(201);
    const ch = find(await txns(root, co), 'CHEQUE 101')[0];
    await root.post(`${base(co)}/matches/${ch.suggestions[0].id}/approve`).expect(201);
    const r2 = (await root.post(`${base(co)}/accounts/${co.bank}/reconciliations`, { statementDate: '2026-11-30', statementBalance: '728.80' }).expect(201)).body;
    expect((await root.post(`${base(co)}/reconciliations/${r1.id}/reopen`)).body.code).toBe('NOT_LATEST');
    await root.post(`${base(co)}/reconciliations/${r2.id}/reopen`).expect(201);
    expect((await root.post(`${base(co)}/reconciliations/${r2.id}/reopen`)).status).toBe(409);
    expect((await txns(root, co)).find((t) => t.id === ch.id)!.status).toBe('MATCHED');
    await root.post(`${base(co)}/reconciliations/${r1.id}/reopen`).expect(201);
    expect((await txns(root, co)).filter((t) => t.status === 'RECONCILED')).toHaveLength(0);
  });
  it('credit-card statements: the printed "amount owed" is converted to the books\' sign', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const card = (await root.post(`${base(co)}/accounts`, { name: 'Visa', kind: 'CREDIT_CARD', mask: '4242', ledgerAccountId: co.acct['2100'] }).expect(201)).body;
    await root.post(`${base(co)}/accounts`, { name: 'Bad', kind: 'CREDIT_CARD', ledgerAccountId: co.acct['4000'] }).expect(400);
    // statement: owed $0 at start; $45.10 purchase; $100.00 payment is NOT in this period => owed $45.10
    await send(root, `${base(co)}/accounts/${card.id}/import/commit?filename=visa.csv`, `Date,Description,Amount\n2026-10-03,STAPLES,45.10\n`, { 'X-Import-Mapping': JSON.stringify({ hasHeader: true, dateColumn: 0, dateFormat: 'YMD', descriptionColumns: [1], amount: { mode: 'single', column: 2, invert: true } }) }).expect(201);
    const t = (await txns(root, co, `bankAccountId=${card.id}`))[0];
    expect(t.amount).toBe('-45.1');
    await root.post(`${base(co)}/transactions/${t.id}/categorize`, { lines: [{ accountId: co.acct['6050'], amount: '45.10' }], taxInclusive: true }).expect(201);
    expect(bal(await tb(root, co), '2100')).toBe('-45.10'); // liability grows
    const q = new URLSearchParams({ statementDate: '2026-10-31', statementBalance: '45.10', openingBalance: '0.00' });
    const pv = (await root.get(`${base(co)}/accounts/${card.id}/reconciliation-preview?${q}`).expect(200)).body;
    expect(pv.summary).toMatchObject({ statementEnding: '-45.10', balanced: true });
    expect(pv.printedStatementBalance).toBe('45.10');
    await root.post(`${base(co)}/accounts/${card.id}/reconciliations`, { statementDate: '2026-10-31', statementBalance: '45.10', openingBalance: '0.00' }).expect(201);
  });
  it('warns when the books and the statement disagree for a reason matching cannot explain', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await importCsv(root, co, `Date,Description,Withdrawals,Deposits\n2026-10-06,HYDRO ONE,84.20,\n`).expect(201);
    const t = (await txns(root, co))[0];
    await root.post(`${base(co)}/transactions/${t.id}/categorize`, { lines: [{ accountId: co.acct['6130'], amount: '84.20' }], taxInclusive: true }).expect(201);
    // the statement opens at 5000 but the books only hold 1000: the difference is unexplained
    const pv = (await root.get(rec(co, { statementDate: '2026-10-31', statementBalance: '4915.80', openingBalance: '5000.00' })).expect(200)).body;
    expect(pv.summary.balanced).toBe(true);
    expect(pv.bookVsBank.unexplained).toBe('-4000.00');
    expect(pv.warnings.join()).toMatch(/differs from the statement balance/);
  });
});

describe('Plaid connection (against a fake of the documented HTTP shapes)', () => {
  const connect = async (root: A, co: Co) => {
    const { publicToken } = { publicToken: 'public-sandbox-abc' };
    const ex = (await root.post(`${base(co)}/connections/exchange`, { publicToken, institutionName: 'Test Bank' }).expect(201)).body;
    const linked = (await root.post(`${base(co)}/connections/${ex.connectionId}/accounts`, { accounts: [{ providerAccountId: 'pa-chq', name: 'Plaid Chequing', kind: 'CHEQUING', mask: '0000', newLedgerAccount: { code: '1016', name: 'Plaid Chequing' } }] }).expect(201)).body;
    return { connectionId: ex.connectionId as string, accountId: linked[0].id as string, exchange: ex };
  };
  it('creates a link token, stores the access token encrypted and never returns it', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    expect((await root.post(`${base(co)}/connections/link-token`).expect(201)).body.linkToken).toBe('link-sandbox-1');
    expect(plaid.calls[0].body).toMatchObject({ country_codes: ['CA'], products: ['transactions'] });
    expect(String((plaid.calls[0].body as { user: { client_user_id: string } }).user.client_user_id)).not.toMatch(/@/);
    const { connectionId, exchange } = await connect(root, co);
    expect(JSON.stringify(exchange)).not.toContain('SECRET');
    const row = await prisma.bankProviderConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row.accessTokenEnc).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain('access-sandbox-SECRET');
    const list = JSON.stringify((await root.get(`${base(co)}/connections`).expect(200)).body);
    expect(list).not.toMatch(/accessToken|SECRET|cursor/);
    expect(list).toContain('Test Bank');
  });
  it('a long backlog is fetched in bounded runs that continue where the last one stopped', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const { connectionId } = await connect(root, co);
    // 45 pages waiting at the bank; one run fetches at most BANK_MAX_PAGES_PER_RUN (40).
    for (let i = 0; i < 45; i++) plaid.pages[i === 0 ? '' : `c${i}`] = { accounts: PLAID_ACCOUNTS, added: [ptx(`t${i}`, 'pa-chq', 1 + i, '2026-10-06', `TXN ${i}`)], modified: [], removed: [], next_cursor: `c${i + 1}`, has_more: i < 44 };
    const s1 = (await root.post(`${base(co)}/connections/${connectionId}/sync`).expect(201)).body;
    expect(s1).toMatchObject({ pages: 40, added: 40, more: true });
    expect((await prisma.bankProviderConnection.findUniqueOrThrow({ where: { id: connectionId } })).cursor).toBe('c40');
    const s2 = (await root.post(`${base(co)}/connections/${connectionId}/sync`).expect(201)).body;
    expect(s2).toMatchObject({ pages: 5, added: 5, more: false });
    expect(await prisma.bankTransaction.count({ where: { companyId: co.id } })).toBe(45);
  });
  it('syncs pages with a cursor: skips pending, converts signs, is idempotent, applies modifications and removals safely', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const { connectionId, accountId } = await connect(root, co);
    plaid.pages[''] = { accounts: PLAID_ACCOUNTS, added: [ptx('p1', 'pa-chq', 84.2, '2026-10-06', 'HYDRO ONE'), ptx('p2', 'pa-chq', -120.38, '2026-10-05', 'SHOPIFY'), ptx('pend', 'pa-chq', 5, '2026-10-08', 'PENDING COFFEE', true), ptx('other', 'pa-visa', 9, '2026-10-08', 'UNMAPPED ACCOUNT')], modified: [], removed: [], next_cursor: 'c1', has_more: true };
    plaid.pages.c1 = { accounts: PLAID_ACCOUNTS, added: [ptx('p3', 'pa-chq', 4.15, '2026-10-09', 'TIM HORTONS')], modified: [], removed: [], next_cursor: 'c2', has_more: false };
    const s1 = (await root.post(`${base(co)}/connections/${connectionId}/sync`).expect(201)).body;
    expect(s1).toMatchObject({ added: 3, pages: 2 });
    const list = await txns(root, co, `bankAccountId=${accountId}`);
    expect(list.map((t) => [t.description, t.amount]).sort()).toEqual([['HYDRO ONE', '-84.2'], ['SHOPIFY', '120.38'], ['TIM HORTONS', '-4.15']]);
    expect((await prisma.bankProviderConnection.findUniqueOrThrow({ where: { id: connectionId } })).cursor).toBe('c2');
    expect(plaid.calls.filter((c) => c.path === '/transactions/sync').map((c) => c.body.cursor)).toEqual([undefined, 'c1']);
    // second sync from c2: Plaid re-sends p1 as added (idempotent), modifies p3, removes p2 after we matched p1
    plaid.pages.c2 = { accounts: PLAID_ACCOUNTS, added: [ptx('p1', 'pa-chq', 84.2, '2026-10-06', 'HYDRO ONE')], modified: [ptx('p3', 'pa-chq', 4.5, '2026-10-09', 'TIM HORTONS #9')], removed: [{ transaction_id: 'p2', account_id: 'pa-chq' }, { transaction_id: 'p1', account_id: 'pa-chq' }], next_cursor: 'c3', has_more: false };
    const hydro = list.find((t) => t.description === 'HYDRO ONE')!;
    await root.post(`${base(co)}/transactions/${hydro.id}/categorize`, { lines: [{ accountId: co.acct['6130'], amount: '84.20' }], taxInclusive: true }).expect(201);
    const s2 = (await root.post(`${base(co)}/connections/${connectionId}/sync`).expect(201)).body;
    expect(s2).toMatchObject({ added: 0, duplicates: 1, modified: 1, removed: 1 });
    expect(s2.warnings.join()).toMatch(/removed a matched transaction/);
    const after = await txns(root, co, `bankAccountId=${accountId}`);
    expect(after.map((t) => t.description).sort()).toEqual(['HYDRO ONE', 'TIM HORTONS #9']); // p2 removed, matched p1 kept
    expect(after.find((t) => t.description === 'TIM HORTONS #9')!.amount).toBe('-4.5');
  });
  it('re-link-required errors mark the connection and tell the user; failures do not advance the cursor; other companies cannot claim the same login', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const { connectionId } = await connect(root, co);
    plaid.fail = { status: 400, body: { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details of this item have changed' } };
    const r = await root.post(`${base(co)}/connections/${connectionId}/sync`);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/sign in again/);
    const row = await prisma.bankProviderConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row).toMatchObject({ status: 'ERROR', cursor: null });
    plaid.fail = null;
    const co2 = await company(root, 'Other Co');
    expect((await root.post(`${base(co2)}/connections/exchange`, { publicToken: 'public-sandbox-abc' })).body.code).toBe('ITEM_IN_USE');
    await root.delete(`${base(co)}/connections/${connectionId}`).expect(204);
    expect((await prisma.bankProviderConnection.findUniqueOrThrow({ where: { id: connectionId } })).status).toBe('REMOVED');
    expect((await root.post(`${base(co)}/connections/${connectionId}/sync`)).status).toBe(409);
  });
  it('is switched off with a clear message when no provider is configured', async () => {
    const { app: bare } = await bootApp({ PLAID_CLIENT_ID: '', PLAID_SECRET: '', QUEUE_MODE: 'none' });
    const root = await setupAdmin(bare); const co = await company(root);
    const list = (await root.get(`${base(co)}/connections`).expect(200)).body;
    expect(list).toMatchObject({ configured: false, connections: [] });
    const r = await root.post(`${base(co)}/connections/link-token`);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('BANK_PROVIDER_NOT_CONFIGURED');
    await bare.close();
  });
});

describe('isolation and permissions', () => {
  it("another company cannot see or touch this company's banking data", async () => {
    const root = await setupAdmin(app); const a = await company(root);
    await importCsv(root, a).expect(201);
    const tx = (await txns(root, a))[0];
    await root.post('/admin/companies', { legalName: 'B Co', province: 'ON', ownerEmail: 'b@example.test', ownerName: 'B', ownerTemporaryPassword: PASSWORD }).expect(201);
    const b = agent(app);
    await b.post('/auth/login', { email: 'b@example.test', password: PASSWORD }).expect(200);
    await b.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' }).expect(204);
    for (const p of ['accounts', 'transactions', 'statements', 'rules', 'reconciliations', 'connections', 'transfer-candidates']) await b.get(`${base(a)}/${p}`).expect(404);
    // B's own company id with A's object ids
    const bco = (await root.get('/admin/companies').expect(200)).body.find((c: { legalName: string }) => c.legalName === 'B Co');
    await b.post(`/companies/${bco.id}/fiscal-years`, { startDate: '2026-01-01' });
    for (const [method, path, body] of [['post', `transactions/${tx.id}/unmatch`, {}], ['post', `transactions/${tx.id}/categorize`, { lines: [{ accountId: a.acct['6050'], amount: '1.00' }] }], ['get', `transactions/${tx.id}/documents`, undefined], ['post', `accounts/${a.bank}/suggest`, {}], ['get', `reconciliations/${tx.id}`, undefined]] as const) {
      const r = method === 'get' ? await b.get(`/companies/${bco.id}/banking/${path}`) : await b.post(`/companies/${bco.id}/banking/${path}`, body);
      expect([400, 404], `${method} ${path}`).toContain(r.status);
    }
    const bAccts = (await b.get(`/companies/${bco.id}/accounts`).expect(200)).body as { id: string; code: string }[];
    expect((await b.post(`/companies/${bco.id}/banking/accounts`, { name: 'x', kind: 'CHEQUING', ledgerAccountId: a.acct['1010'] })).body.code).toBe('INVALID_ACCOUNT'); // A's ledger account
    expect((await b.post(`/companies/${bco.id}/banking/accounts`, { name: 'x', kind: 'CHEQUING', ledgerAccountId: bAccts.find((x) => x.code === '1010')!.id })).status).toBe(201);
    await b.raw.post(`/companies/${bco.id}/banking/accounts/${a.bank}/import/commit?filename=x.csv`).set('Origin', ORIGIN).set('Content-Type', 'application/octet-stream').set('X-Import-Mapping', JSON.stringify(CSV_MAPPING)).send(Buffer.from(CSV)).expect(404);
  });
  it('roles: bookkeepers import and write rules but cannot approve, post or reconcile; auditors only read; employees see nothing', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    const bk = await member(root, co, 'BOOKKEEPER'); const aud = await member(root, co, 'AUDITOR'); const emp = await member(root, co, 'EMPLOYEE'); const acc = await member(root, co, 'ACCOUNTANT');
    await importCsv(bk, co).expect(201);
    await bk.post(`${base(co)}/rules`, { name: 'r', conditions: { descriptionContains: ['x'] }, accountId: co.acct['6050'] }).expect(201);
    const t = find(await txns(bk, co), 'HYDRO')[0];
    await bk.post(`${base(co)}/transactions/${t.id}/categorize`, { lines: [{ accountId: co.acct['6130'], amount: '84.20' }], taxInclusive: true }).expect(403);
    await bk.post(`${base(co)}/matches/bulk`, {}).expect(404);
    await bk.post(`${base(co)}/transactions/${t.id}/ignore`, {}).expect(403);
    await bk.post(`${base(co)}/accounts/${co.bank}/reconciliations`, { statementDate: '2026-10-31', statementBalance: '1', openingBalance: '1' }).expect(403);
    await bk.post(`${base(co)}/connections/link-token`).expect(403);
    await aud.get(`${base(co)}/transactions`).expect(200);
    await aud.get(`${base(co)}/statements`).expect(200);
    await importCsv(aud, co, CSV + '\n', 'x.csv').expect(403);
    for (const p of ['accounts', 'transactions', 'rules']) await emp.get(`${base(co)}/${p}`).expect(403);
    await acc.post(`${base(co)}/transactions/${t.id}/categorize`, { lines: [{ accountId: co.acct['6130'], amount: '84.20' }], taxInclusive: true }).expect(201);
    await acc.post(`${base(co)}/transactions/${t.id}/undo`).expect(204);
  });
  it('every state-changing banking action is audited', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await importCsv(root, co).expect(201);
    const t = find(await txns(root, co), 'HYDRO')[0];
    await root.post(`${base(co)}/transactions/${t.id}/categorize`, { lines: [{ accountId: co.acct['6130'], amount: '84.20' }], taxInclusive: true }).expect(201);
    const actions = (await prisma.auditEvent.findMany({ where: { companyId: co.id } })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['bank_account.created', 'bank_import.committed', 'bank_txn.categorized']));
  });
});

describe('import cost does not grow with the unmatched backlog', () => {
  it('a new import scores only its own transactions; earlier suggestions are left alone', async () => {
    const root = await setupAdmin(app); const co = await company(root);
    await root.post(`/companies/${co.id}/journals`, { date: '2026-10-07', post: true, lines: [{ accountId: co.acct['1010'], debit: '113.00' }, { accountId: co.acct['4000'], credit: '113.00' }] }).expect(201);
    await importCsv(root, co).expect(201);
    const before = await prisma.reconciliationMatch.findMany({ where: { companyId: co.id, status: 'SUGGESTED' }, select: { id: true, bankTxnId: true } });
    expect(before.length).toBeGreaterThan(0);
    const second = `Date,Description,Withdrawals,Deposits\n2026-10-20,COFFEE SHOP,3.50,\n`;
    await importCsv(root, co, second, 'second.csv').expect(201);
    const after = await prisma.reconciliationMatch.findMany({ where: { companyId: co.id, bankTxnId: { in: before.map((m) => m.bankTxnId) }, status: 'SUGGESTED' }, select: { id: true } });
    expect(after.map((m) => m.id).sort()).toEqual(before.map((m) => m.id).sort()); // same rows: not deleted and re-created
    // The explicit "suggest" action still re-scores the whole backlog.
    expect((await root.post(`${base(co)}/accounts/${co.bank}/suggest`).expect(201)).body.suggestions).toBeGreaterThan(0);
  });
});

describe('statement files on the NAS documents folder (DOCUMENTS_DIR)', () => {
  it('stores the original file on disk, not in the database, serves it back byte-for-byte and detects tampering', async () => {
    const { mkdtempSync, readFileSync, writeFileSync, readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ca-docs-'));
    const { app: withDocs, prisma: p2 } = await bootApp({ DOCUMENTS_DIR: dir, QUEUE_MODE: 'none' });
    try {
      const root = await setupAdmin(withDocs);
      const co = await company(root);
      await importCsv(root, co).expect(201);
      const st = await p2.bankStatement.findFirstOrThrow({ where: { companyId: co.id } });
      expect(st.content).toBeNull();
      expect(st.storageKey).toBe(`${co.id}/${st.sha256.slice(0, 2)}/${st.sha256}`);
      const onDisk = join(dir, st.storageKey!);
      expect(readFileSync(onDisk, 'utf8')).toBe(CSV);
      expect(readdirSync(join(dir, co.id, st.sha256.slice(0, 2)))).toEqual([st.sha256]); // no temp files left behind
      const dl = await root.raw.get(`${base(co)}/statements/${st.id}/download`).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (c: Buffer) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
      expect(dl.status).toBe(200);
      expect((dl.body as Buffer).toString('utf8')).toBe(CSV);
      writeFileSync(onDisk, CSV.replace('84.20', '84.21'));
      const bad = await root.get(`${base(co)}/statements/${st.id}/download`);
      expect(bad.status).toBe(500);
      expect(bad.body.code).toBe('DOCUMENT_CORRUPT');
    } finally {
      await p2.$disconnect();
      await withDocs.close();
    }
  });
});
