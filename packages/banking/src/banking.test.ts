import { describe, expect, it } from 'vitest';
import {
  PlaidProvider, ProviderError, applyMapping, findTransferPairs, firstMatchingRule, fingerprints, looksLikeOfx, parseAmount, parseCsv, parseDate, parseOfx,
  reconSummary, ruleMatches, scoreDocument, sha256Hex, similarity, suggestMapping, suggestMatches, type CsvMapping, type LedgerCandidate,
} from './index';

const SINGLE = `Account Type,Account Number,Transaction Date,Cheque Number,Description 1,Description 2,CAD$,USD$
Chequing,12345678,10/05/2026,,"SHOPIFY* PAYOUT","TRACE1",120.38,
Chequing,12345678,10/06/2026,,"HYDRO ONE, BILL",,-84.20,
Chequing,12345678,10/06/2026,,"TIM HORTONS #123",,-4.15,
Chequing,12345678,10/06/2026,,"TIM HORTONS #123",,-4.15,
`;
const SPLIT = `Date,Description,Withdrawals,Deposits,Balance
2026-10-05,"Interac e-Transfer from ACME LTD",,"1,250.00","10,250.00"
2026-10-07,"Rent – Oct",2000.00,,"8,250.00"
2026-10-08,"Bad row",abc,,
`;
const FR = `Date;Description;Retrait;Dépôt
05/10/2026;Dépanneur Marché;12,50;
06/10/2026;Virement;;1 234,56
`;

describe('CSV', () => {
  it('parses quotes, embedded commas, CRLF, BOM and detects the delimiter', () => {
    const r = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n');
    expect(r.rows).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
    expect(parseCsv(FR).delimiter).toBe(';');
    expect(parseCsv('a\tb\n1\t2').delimiter).toBe('\t');
  });
  it('maps a signed-amount export; two identical purchases are kept and both fingerprints differ', () => {
    const { rows } = parseCsv(SINGLE);
    const m: CsvMapping = { hasHeader: true, dateColumn: 2, dateFormat: 'MDY', descriptionColumns: [4, 5], amount: { mode: 'single', column: 6 } };
    const r = applyMapping(rows, m);
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.date, x.amount])).toEqual([['2026-10-05', '120.38'], ['2026-10-06', '-84.20'], ['2026-10-06', '-4.15'], ['2026-10-06', '-4.15']]);
    expect(r.rows[0].description).toBe('SHOPIFY* PAYOUT TRACE1');
    const f = fingerprints(r.rows);
    expect(new Set(f).size).toBe(4);
  });
  it('maps debit/credit columns, thousands separators and reports bad rows without aborting', () => {
    const { rows } = parseCsv(SPLIT);
    const r = applyMapping(rows, { hasHeader: true, dateColumn: 0, dateFormat: 'YMD', descriptionColumns: [1], amount: { mode: 'split', debitColumn: 2, creditColumn: 3 }, balanceColumn: 4 });
    expect(r.rows.map((x) => x.amount)).toEqual(['1250.00', '-2000.00']);
    expect(r.rows[0].balance).toBe('10250.00');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 4, message: expect.stringMatching(/Not a number/) });
  });
  it('handles French-Canadian decimal commas and invert for credit-card exports', () => {
    const { rows } = parseCsv(FR);
    const r = applyMapping(rows, { hasHeader: true, dateColumn: 0, dateFormat: 'DMY', descriptionColumns: [1], amount: { mode: 'split', debitColumn: 2, creditColumn: 3 }, decimalComma: true });
    expect(r.rows.map((x) => x.amount)).toEqual(['-12.50', '1234.56']);
    const card = applyMapping([['d', 'x', 'a'], ['2026-10-01', 'STORE', '45.10'], ['2026-10-02', 'PAYMENT', '-100.00']], { hasHeader: true, dateColumn: 0, dateFormat: 'YMD', descriptionColumns: [1], amount: { mode: 'single', column: 2, invert: true } });
    expect(card.rows.map((x) => x.amount)).toEqual(['-45.10', '100.00']);
  });
  it('parses amounts in many notations and rejects junk', () => {
    expect(parseAmount('$1,234.56')!.toFixed(2)).toBe('1234.56');
    expect(parseAmount('(12.50)')!.toFixed(2)).toBe('-12.50');
    expect(parseAmount('12.50-')!.toFixed(2)).toBe('-12.50');
    expect(parseAmount('-0.99')!.toFixed(2)).toBe('-0.99');
    expect(parseAmount('  ')).toBeNull();
    expect(() => parseAmount('12.5.0')).toThrow();
    expect(() => parseAmount('1e5')).toThrow();
  });
  it('validates dates strictly; ambiguous slashes require an explicit format', () => {
    expect(parseDate('2026-02-30', 'YMD')).toEqual({ error: expect.stringMatching(/Invalid/) });
    expect(parseDate('10/05/2026', 'MDY')).toBe('2026-10-05');
    expect(parseDate('10/05/2026', 'DMY')).toBe('2026-05-10');
    expect(parseDate('10/05/2026', 'auto')).toEqual({ error: expect.stringMatching(/Ambiguous/) });
    expect(parseDate('2026/10/05', 'auto')).toBe('2026-10-05');
    expect(parseDate('20261005', 'auto')).toBe('2026-10-05');
    expect(parseDate('13/13/2026', 'MDY')).toEqual({ error: expect.any(String) });
  });
  it('suggests a mapping from headers', () => {
    expect(suggestMapping(['Date', 'Description', 'Withdrawals', 'Deposits', 'Balance'])).toMatchObject({ dateColumn: 0, descriptionColumns: [1], amount: { mode: 'split', debitColumn: 2, creditColumn: 3 }, balanceColumn: 4, confident: true });
    expect(suggestMapping(['Posted Date', 'Payee', 'Amount'])).toMatchObject({ amount: { mode: 'single', column: 2 }, confident: true });
    expect(suggestMapping(['foo', 'bar']).confident).toBe(false);
  });
  it('refuses absurdly large files', () => {
    expect(() => parseCsv('a\n'.repeat(60_000))).toThrow(/more than/);
  });
});

const OFX1 = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
ENCODING:USASCII

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>CAD
<BANKACCTFROM><BANKID>00012<ACCTID>1234567890<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261001000000<DTEND>20261031000000
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261005120000[-5:EST]<TRNAMT>120.38<FITID>2026100501<NAME>SHOPIFY PAYOUT<MEMO>TRACE1</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261006<TRNAMT>-84.20<FITID>2026100601<NAME>HYDRO &amp; GAS</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261099<TRNAMT>-1.00<FITID>bad<NAME>BAD DATE</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>1500.25<DTASOF>20261031</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
const OFX2 = `<?xml version="1.0" encoding="UTF-8"?><?OFX OFXHEADER="200" VERSION="220"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>CAD</CURDEF><CCACCTFROM><ACCTID>4500123412341234</ACCTID></CCACCTFROM>
<BANKTRANLIST><DTSTART>20261001</DTSTART><DTEND>20261031</DTEND>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261003</DTPOSTED><TRNAMT>-45.10</TRNAMT><FITID>C1</FITID><NAME>STAPLES</NAME></STMTTRN>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261020</DTPOSTED><TRNAMT>100.00</TRNAMT><FITID>C2</FITID><NAME>PAYMENT THANK YOU</NAME></STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>-250.00</BALAMT><DTASOF>20261031</DTASOF></LEDGERBAL></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

describe('OFX / QFX', () => {
  it('parses OFX 1.x SGML: entities, timezone suffixes, metadata, and reports bad rows', () => {
    expect(looksLikeOfx(OFX1)).toBe(true);
    const r = parseOfx(OFX1);
    expect(r.rows).toEqual([
      { date: '2026-10-05', description: 'SHOPIFY PAYOUT TRACE1', amount: '120.38', externalId: '2026100501' },
      { date: '2026-10-06', description: 'HYDRO & GAS', amount: '-84.20', externalId: '2026100601' },
    ]);
    expect(r.errors).toHaveLength(1);
    expect(r.meta).toMatchObject({ currency: 'CAD', accountMask: '7890', accountKind: 'CHEQUING', periodStart: '2026-10-01', periodEnd: '2026-10-31', endingBalance: '1500.25' });
  });
  it('parses OFX 2.x XML credit-card statements (balance owed is negative)', () => {
    const r = parseOfx(OFX2);
    expect(r.rows.map((x) => x.amount)).toEqual(['-45.10', '100.00']);
    expect(r.meta).toMatchObject({ accountKind: 'CREDIT_CARD', accountMask: '1234', endingBalance: '-250.00' });
  });
  it('is safe against entity-expansion attacks and rejects non-OFX', () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><OFX><STMTTRN><DTPOSTED>20261005<TRNAMT>-1.00<FITID>x<NAME>&b;</STMTTRN></OFX>`;
    const r = parseOfx(evil);
    expect(r.rows[0].description).toBe('&b;'); // not expanded
    expect(() => parseOfx('hello')).toThrow();
    expect(looksLikeOfx('a,b,c')).toBe(false);
  });
});

describe('fingerprints', () => {
  it('uses the bank id when present; occurrence counters otherwise', () => {
    const a = fingerprints([{ date: '2026-10-01', description: 'X', amount: '-1.00', externalId: 'F1' }]);
    const b = fingerprints([{ date: '2099-01-01', description: 'totally different', amount: '-9.00', externalId: 'F1' }]);
    expect(a).toEqual(b);
    const two = fingerprints([{ date: '2026-10-01', description: 'tim  hortons', amount: '-4.15' }, { date: '2026-10-01', description: 'TIM HORTONS', amount: '-4.15' }]);
    expect(two[0]).not.toBe(two[1]);
    const overlap = fingerprints([{ date: '2026-10-01', description: 'TIM HORTONS', amount: '-4.15' }]);
    expect(overlap[0]).toBe(two[0]);
  });
  it('hashes files', () => expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'));
});

describe('match suggestions', () => {
  const cand = (id: string, date: string, signed: string, o: Partial<LedgerCandidate> = {}): LedgerCandidate => ({ lineId: id, date, signed, ...o });
  const txn = { date: '2026-10-05', amount: '120.38', description: 'SHOPIFY* PAYOUT TRACE1' };
  it('requires an exact amount; scores same-day higher than distant dates', () => {
    expect(suggestMatches(txn, [cand('a', '2026-10-05', '120.39')])).toEqual([]);
    const s = suggestMatches(txn, [cand('near', '2026-10-05', '120.38'), cand('far', '2026-10-20', '120.38', { memo: 'x' })]);
    expect(s[0].lineId).toBe('near');
    expect(s[0].confidence).toBeGreaterThan(0.7);
  });
  it('boosts Shopify payouts and text similarity; flags ambiguity instead of pretending certainty', () => {
    const shop = suggestMatches(txn, [cand('p', '2026-10-05', '120.38', { sourceType: 'shopify_payout', memo: 'Shopify payout 9001' })])[0];
    expect(shop.confidence).toBeGreaterThan(0.95);
    expect(shop.reasons).toContain('Shopify payout');
    const amb = suggestMatches(txn, [cand('a', '2026-10-05', '120.38'), cand('b', '2026-10-05', '120.38')]);
    expect(amb).toHaveLength(2);
    expect(amb.every((x) => x.confidence < 0.8 && x.reasons.some((r) => /ambiguous/.test(r)))).toBe(true);
  });
  it('signs matter: a deposit never matches a withdrawal of the same size', () => {
    expect(suggestMatches({ ...txn, amount: '-120.38' }, [cand('a', '2026-10-05', '120.38')])).toEqual([]);
  });
  it('similarity ignores short tokens and case', () => {
    expect(similarity('Interac e-Transfer ACME LTD', 'acme ltd')).toBeGreaterThan(0.3);
    expect(similarity('a b', 'c d')).toBe(0);
  });
});

describe('document and transfer suggestions', () => {
  it('suggests invoices by exact balance and contact name, partials only with evidence', () => {
    const d = { number: 'INV-0007', outstanding: '113.00', contactName: 'Acme Customer' };
    expect(scoreDocument({ amount: '113.00', description: 'E-TRANSFER ACME CUSTOMER' }, d)!.confidence).toBeGreaterThan(0.8);
    expect(scoreDocument({ amount: '50.00', description: 'E-TRANSFER ACME CUSTOMER' }, d)!.reasons).toContain('looks like a partial payment');
    expect(scoreDocument({ amount: '50.00', description: 'RANDOM' }, d)).toBeNull();
    expect(scoreDocument({ amount: '200.00', description: 'ACME CUSTOMER' }, d)).toBeNull();
    expect(scoreDocument({ amount: '-113.00', description: 'pay INV-0007' }, d)!.reasons).toContain('document number in description');
  });
  it('pairs transfers between different accounts only, closest dates first, one-to-one', () => {
    const t = [
      { id: 'o1', bankAccountId: 'A', date: '2026-10-01', amount: '-500.00' },
      { id: 'i1', bankAccountId: 'B', date: '2026-10-02', amount: '500.00' },
      { id: 'i2', bankAccountId: 'B', date: '2026-10-01', amount: '500.00' },
      { id: 'same', bankAccountId: 'A', date: '2026-10-01', amount: '500.00' },
    ];
    expect(findTransferPairs(t)).toEqual([{ fromId: 'o1', toId: 'i2', confidence: 0.9 }]);
  });
});

describe('rules', () => {
  const t = { description: 'Hydro One Networks #4412', amount: '-84.20', bankAccountId: 'A' };
  it('matches on contains/direction/amount range; empty rules match nothing', () => {
    expect(ruleMatches({ descriptionContains: ['hydro'] }, t)).toBe(true);
    expect(ruleMatches({ descriptionContains: ['bell', 'hydro'], direction: 'OUT' }, t)).toBe(true);
    expect(ruleMatches({ descriptionContains: ['hydro'], direction: 'IN' }, t)).toBe(false);
    expect(ruleMatches({ descriptionContains: ['hydro'], minAmount: '100' }, t)).toBe(false);
    expect(ruleMatches({ minAmount: '50', maxAmount: '100' }, t)).toBe(true);
    expect(ruleMatches({ descriptionContains: ['hydro'], bankAccountId: 'B' }, t)).toBe(false);
    expect(ruleMatches({}, t)).toBe(false);
    expect(ruleMatches({ descriptionContains: ['  '] }, t)).toBe(false);
  });
  it('applies the lowest priority number first and ignores inactive rules', () => {
    const rules = [
      { id: 'late', priority: 200, conditions: { descriptionContains: ['hydro'] }, accountId: 'x', isActive: true },
      { id: 'off', priority: 1, conditions: { descriptionContains: ['hydro'] }, accountId: 'x', isActive: false },
      { id: 'first', priority: 10, conditions: { descriptionContains: ['hydro one'] }, accountId: 'utilities', isActive: true },
    ];
    expect(firstMatchingRule(rules, t)!.id).toBe('first');
  });
});

describe('reconciliation math', () => {
  it('balances to the cent, exactly', () => {
    const ok = reconSummary({ opening: '1000.10', cleared: ['0.10', '0.20', '-0.30', '500.00'], statementEnding: '1500.10' });
    expect(ok).toMatchObject({ computedEnding: '1500.10', difference: '0.00', balanced: true });
    const off = reconSummary({ opening: '1000.00', cleared: ['100.00'], statementEnding: '1100.01' });
    expect(off).toMatchObject({ difference: '-0.01', balanced: false }); // (computed 1100.00 - statement 1100.01)
  });
});

describe('Plaid adapter (against a fake of the documented HTTP shapes)', () => {
  const resp = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const mk = (responses: Response[]) => {
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> & { client_name: string } }[] = [];
    const f = (async (url: string, init: { headers: Record<string, string>; body: string }) => { calls.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return responses.shift()!; }) as unknown as typeof fetch;
    return { p: new PlaidProvider({ clientId: 'cid', secret: 'sec', env: 'sandbox', fetch: f, sleep: async () => {}, redirectUri: 'https://x/redirect' }), calls };
  };
  it('creates a Canadian link token for the transactions product with auth headers', async () => {
    const { p, calls } = mk([resp({ link_token: 'link-1', expiration: '2026-10-31T00:00:00Z', request_id: 'r' })]);
    expect(await p.createLinkToken({ clientUserId: 'user-1', clientName: 'Canadian Accounting – a very long name indeed' })).toEqual({ linkToken: 'link-1', expiration: '2026-10-31T00:00:00Z' });
    expect(calls[0].url).toBe('https://sandbox.plaid.com/link/token/create');
    expect(calls[0].headers).toMatchObject({ 'PLAID-CLIENT-ID': 'cid', 'PLAID-SECRET': 'sec' });
    expect(calls[0].body).toMatchObject({ country_codes: ['CA'], products: ['transactions'], user: { client_user_id: 'user-1' }, redirect_uri: 'https://x/redirect' });
    expect(calls[0].body.client_name.length).toBeLessThanOrEqual(30);
  });
  it('converts Plaid signs to ours and credit-card balances to negative-when-owed', async () => {
    const { p, calls } = mk([resp({
      accounts: [{ account_id: 'a1', name: 'Chequing', official_name: null, mask: '0000', type: 'depository', subtype: 'checking', balances: { current: 1500.255, iso_currency_code: 'CAD' } }, { account_id: 'a2', name: 'Visa', mask: '1234', type: 'credit', subtype: 'credit card', balances: { current: 250, iso_currency_code: 'CAD' } }],
      added: [{ transaction_id: 't1', account_id: 'a1', amount: 84.2, iso_currency_code: 'CAD', date: '2026-10-06', name: 'HYDRO ONE', merchant_name: 'Hydro One', pending: false },
              { transaction_id: 't2', account_id: 'a1', amount: -120.38, iso_currency_code: 'CAD', date: '2026-10-05', name: 'SHOPIFY', merchant_name: null, pending: true }],
      modified: [], removed: [{ transaction_id: 't0', account_id: 'a1' }], next_cursor: 'c2', has_more: false, request_id: 'r' })]);
    const page = await p.syncTransactions('access-1', 'c1');
    expect(calls[0].body).toMatchObject({ access_token: 'access-1', cursor: 'c1', count: 500 });
    expect(page.added.map((t) => [t.providerTxnId, t.amount, t.pending, t.description])).toEqual([['t1', '-84.20', false, 'Hydro One · HYDRO ONE'], ['t2', '120.38', true, 'SHOPIFY']]);
    expect(page.accounts.map((a) => [a.kind, a.currentBalance])).toEqual([['CHEQUING', '1500.26'], ['CREDIT_CARD', '-250.00']]);
    expect(page).toMatchObject({ nextCursor: 'c2', hasMore: false, removed: [{ providerTxnId: 't0', providerAccountId: 'a1' }] });
  });
  it('retries 429/5xx, flags relink-required errors, and fails fast on others', async () => {
    const ok = resp({ accounts: [], added: [], modified: [], removed: [], next_cursor: 'c', has_more: false });
    const { p, calls } = mk([resp({ error_code: 'RATE_LIMIT' }, 429), resp({}, 503), ok]);
    await p.syncTransactions('a', null);
    expect(calls).toHaveLength(3);
    expect(calls[0].body).not.toHaveProperty('cursor');
    const { p: p2 } = mk([resp({ error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details of this item have changed' }, 400)]);
    await expect(p2.syncTransactions('a', null)).rejects.toMatchObject({ code: 'ITEM_LOGIN_REQUIRED', requiresRelink: true, retryable: false });
    const { p: p3 } = mk([resp({ error_code: 'INVALID_ACCESS_TOKEN', error_message: 'bad' }, 400)]);
    await expect(p3.syncTransactions('a', null)).rejects.toBeInstanceOf(ProviderError);
  });
});
