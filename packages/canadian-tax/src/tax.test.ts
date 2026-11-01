import { describe, expect, it } from 'vitest';
import { SEED_TAX_CODES, activeRates, calculateTax, expectedComponents, type RateRow } from './index';

const rows = (code: string): RateRow[] => SEED_TAX_CODES.find((c) => c.code === code)!.rates;
const calc = (code: string, amount: string, inclusive: boolean, date = '2026-06-01') =>
  calculateTax({ amount, inclusive, rates: activeRates(rows(code), date) });

describe('calculateTax', () => {
  it('ON HST 13% exclusive', () => {
    const r = calc('HST_ON', '100.00', false);
    expect([r.net, r.taxTotal, r.gross]).toEqual(['100.00', '13.00', '113.00']);
  });
  it('QC GST + QST exclusive, each component rounded separately', () => {
    const r = calc('GST_QST', '100.00', false);
    expect(r.taxes.map((t) => [t.component, t.amount])).toEqual([['GST', '5.00'], ['QST', '9.98']]);
    expect(r.gross).toBe('114.98');
  });
  it('QC inclusive: net + tax equals gross exactly', () => {
    const r = calc('GST_QST', '114.98', true);
    expect(r.gross).toBe('114.98');
    expect(r.net).toBe('100.00');
  });
  it('inclusive never drifts a cent, over many amounts', () => {
    for (let c = 1; c <= 5000; c += 7) {
      const amt = (c / 100).toFixed(2);
      for (const code of ['HST_ON', 'GST_QST', 'GST_PST_BC', 'GST']) {
        const r = calc(code, amt, true);
        expect(r.gross).toBe(amt);
      }
    }
  });
  it('BC PST is flagged non-recoverable, GST recoverable', () => {
    const r = calc('GST_PST_BC', '200.00', false);
    expect(r.taxes.find((t) => t.component === 'PST')).toMatchObject({ amount: '14.00', recoverable: false });
    expect(r.taxes.find((t) => t.component === 'GST')).toMatchObject({ amount: '10.00', recoverable: true });
  });
  it('zero-rated and exempt have no tax', () => {
    expect(calc('ZERO', '50.00', false).taxTotal).toBe('0.00');
    expect(calc('EXEMPT', '50.00', true).net).toBe('50.00');
  });
  it('half-up rounding: 0.005 tax rounds up', () => {
    expect(calculateTax({ amount: '0.10', inclusive: false, rates: [{ component: 'GST', rate: '0.05', recoverable: true, effectiveFrom: '2008-01-01' }] }).taxTotal).toBe('0.01');
  });
});

describe('effective dating', () => {
  it('Nova Scotia HST is 15% until 2025-03-31 and 14% from 2025-04-01', () => {
    expect(calc('HST_NS', '100.00', false, '2025-03-31').taxTotal).toBe('15.00');
    expect(calc('HST_NS', '100.00', false, '2025-04-01').taxTotal).toBe('14.00');
  });
  it('no rate before it takes effect', () => {
    expect(activeRates(rows('GST'), '2007-12-31')).toEqual([]);
    expect(activeRates(rows('GST_QST'), '2012-12-31').map((r) => r.component)).toEqual(['GST']);
  });
  it('picks the latest row when ranges are open-ended', () => {
    const r: RateRow[] = [
      { component: 'GST', rate: '0.07', recoverable: true, effectiveFrom: '2006-07-01' },
      { component: 'GST', rate: '0.06', recoverable: true, effectiveFrom: '2006-07-01', effectiveTo: '2005-01-01' },
      { component: 'GST', rate: '0.05', recoverable: true, effectiveFrom: '2008-01-01' },
    ];
    expect(activeRates(r, '2010-01-01')[0].rate).toBe('0.05');
  });
});

describe('jurisdiction', () => {
  it('maps provinces to expected components', () => {
    expect(expectedComponents('ON')).toEqual(['HST']);
    expect(expectedComponents('QC')).toEqual(['GST', 'QST']);
    expect(expectedComponents('BC')).toEqual(['GST', 'PST']);
    expect(expectedComponents('AB')).toEqual(['GST']);
  });
});
