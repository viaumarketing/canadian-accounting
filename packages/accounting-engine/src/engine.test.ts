import { describe, expect, it } from 'vitest';
import { SEED_TAX_CODES, activeRates, calculateTax } from '@ca/canadian-tax';
import { UnbalancedEntryError, assertBalanced, paymentJournal, purchaseJournal, reverseLines, salesJournal, totals, type DocLine } from './index';

const acc = { gstHstPayable: 'gst-pay', gstHstReceivable: 'gst-itc', qstPayable: 'qst-pay', qstReceivable: 'qst-itr', pstPayable: 'pst-pay' };
const docLine = (code: string, amount: string, accountId: string, inclusive = false): DocLine => {
  const r = calculateTax({ amount, inclusive, rates: activeRates(SEED_TAX_CODES.find((c) => c.code === code)!.rates, '2026-06-01') });
  return { accountId, net: r.net, taxes: r.taxes };
};

describe('assertBalanced', () => {
  it('accepts balanced and rejects unbalanced / malformed', () => {
    expect(() => assertBalanced([{ debit: '10.00', credit: '0' }, { debit: '0', credit: '10.00' }])).not.toThrow();
    expect(() => assertBalanced([{ debit: '10.00', credit: '0' }, { debit: '0', credit: '9.99' }])).toThrow(UnbalancedEntryError);
    expect(() => assertBalanced([{ debit: '10', credit: '0' }])).toThrow();
    expect(() => assertBalanced([{ debit: '10', credit: '10' }, { debit: '0', credit: '0' }])).toThrow();
    expect(() => assertBalanced([{ debit: '-5', credit: '0' }, { debit: '0', credit: '-5' }])).toThrow();
  });
  it('is exact where floats are not (0.1 + 0.2)', () => {
    expect(() => assertBalanced([{ debit: '0.1', credit: '0' }, { debit: '0.2', credit: '0' }, { debit: '0', credit: '0.3' }])).not.toThrow();
  });
});

describe('salesJournal', () => {
  it('QC invoice posts revenue, GST payable, QST payable and A/R, balanced', () => {
    const j = salesJournal({ lines: [docLine('GST_QST', '100.00', 'rev')], receivableId: 'ar', contactId: 'c', taxAccounts: acc });
    expect(j.find((l) => l.accountId === 'ar')).toMatchObject({ debit: '114.98', credit: '0.00' });
    expect(j.find((l) => l.accountId === 'rev')?.credit).toBe('100.00');
    expect(j.find((l) => l.accountId === 'gst-pay')?.credit).toBe('5.00');
    expect(j.find((l) => l.accountId === 'qst-pay')?.credit).toBe('9.98');
    const t = totals(j);
    expect(t.debit.eq(t.credit)).toBe(true);
  });
  it('credit note mirrors the sides', () => {
    const j = salesJournal({ lines: [docLine('HST_ON', '100.00', 'rev')], receivableId: 'ar', contactId: 'c', taxAccounts: acc, credit: true });
    expect(j.find((l) => l.accountId === 'ar')).toMatchObject({ debit: '0.00', credit: '113.00' });
    expect(j.find((l) => l.accountId === 'rev')).toMatchObject({ debit: '100.00' });
  });
  it('fails clearly when a needed tax account is missing', () => {
    expect(() => salesJournal({ lines: [docLine('HST_ON', '10.00', 'rev')], receivableId: 'ar', contactId: 'c', taxAccounts: {} })).toThrow(/GST\/HST payable/);
  });
});

describe('purchaseJournal', () => {
  it('BC bill: GST goes to ITC, PST is added to the expense', () => {
    const j = purchaseJournal({ lines: [docLine('GST_PST_BC', '200.00', 'exp')], counterAccountId: 'ap', taxAccounts: acc });
    expect(j.find((l) => l.accountId === 'gst-itc')?.debit).toBe('10.00');
    expect(j.find((l) => l.accountId === 'exp')?.debit).toBe('214.00'); // 200 + 14 PST
    expect(j.find((l) => l.accountId === 'ap')?.credit).toBe('224.00');
  });
  it('vendor credit mirrors', () => {
    const j = purchaseJournal({ lines: [docLine('HST_ON', '100.00', 'exp')], counterAccountId: 'ap', taxAccounts: acc, credit: true });
    expect(j.find((l) => l.accountId === 'ap')?.debit).toBe('113.00');
    expect(j.find((l) => l.accountId === 'gst-itc')?.credit).toBe('13.00');
  });
});

describe('payments and reversal', () => {
  it('receipt and disbursement', () => {
    expect(paymentJournal({ direction: 'RECEIPT', amount: '50.00', bankAccountId: 'bank', controlAccountId: 'ar', contactId: 'c' })[0]).toMatchObject({ accountId: 'bank', debit: '50.00' });
    expect(paymentJournal({ direction: 'DISBURSEMENT', amount: '50.00', bankAccountId: 'bank', controlAccountId: 'ap', contactId: 'c' })[0]).toMatchObject({ accountId: 'bank', credit: '50.00' });
  });
  it('reversal nets to zero per account', () => {
    const j = salesJournal({ lines: [docLine('HST_ON', '33.33', 'rev')], receivableId: 'ar', contactId: 'c', taxAccounts: acc });
    const r = reverseLines(j);
    const all = [...j, ...r];
    for (const id of new Set(all.map((l) => l.accountId))) {
      const t = totals(all.filter((l) => l.accountId === id));
      expect(t.debit.eq(t.credit)).toBe(true);
    }
  });
});
