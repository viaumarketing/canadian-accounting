import Decimal from 'decimal.js';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type TaxComponent = 'GST' | 'HST' | 'QST' | 'PST';

/** One effective-dated rate row of a tax code. Dates are ISO `YYYY-MM-DD`; effectiveTo is inclusive. */
export interface RateRow {
  component: TaxComponent;
  rate: string; // decimal fraction, "0.13" = 13%
  recoverable: boolean;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

export interface TaxLine {
  component: TaxComponent;
  rate: string;
  amount: string;
  recoverable: boolean;
}

export interface TaxResult {
  net: string;
  taxes: TaxLine[];
  taxTotal: string;
  gross: string;
}

export const money = (v: Decimal.Value): Decimal => new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * Rates in force on `date`: for each component the row with the latest effectiveFrom that
 * covers the date. Dates compare as ISO strings, so there is no timezone ambiguity.
 */
export function activeRates(rows: RateRow[], date: string): RateRow[] {
  const best = new Map<TaxComponent, RateRow>();
  for (const r of rows) {
    if (r.effectiveFrom > date) continue;
    if (r.effectiveTo && r.effectiveTo < date) continue;
    const cur = best.get(r.component);
    if (!cur || r.effectiveFrom > cur.effectiveFrom) best.set(r.component, r);
  }
  return [...best.values()];
}

/**
 * Tax on one amount. Rounding is half-up to the cent, per component.
 *  - exclusive: net = amount; tax_i = round(net * r_i)
 *  - inclusive: tax_i = round(gross * r_i / (1 + R)); net = gross - Σ tax_i (so net + tax always equals gross exactly)
 * QST is computed on the same base as GST/HST (not on tax-on-tax), per current Quebec rules; confirm with Revenu Québec.
 */
export function calculateTax(input: { amount: Decimal.Value; inclusive: boolean; rates: RateRow[] }): TaxResult {
  const amount = money(input.amount);
  const R = input.rates.reduce((s, r) => s.plus(r.rate), new Decimal(0));
  const taxes: TaxLine[] = input.rates.map((r) => {
    const raw = input.inclusive ? amount.times(r.rate).div(R.plus(1)) : amount.times(r.rate);
    return { component: r.component, rate: r.rate, amount: money(raw).toFixed(2), recoverable: r.recoverable };
  });
  const taxTotal = taxes.reduce((s, t) => s.plus(t.amount), new Decimal(0));
  const net = input.inclusive ? amount.minus(taxTotal) : amount;
  const gross = net.plus(taxTotal);
  return { net: net.toFixed(2), taxes, taxTotal: taxTotal.toFixed(2), gross: gross.toFixed(2) };
}

/** Which tax components normally apply to a taxable supply in a province (used to sanity-check code choice). */
export function expectedComponents(province: string): TaxComponent[] {
  switch (province) {
    case 'ON': case 'NB': case 'NL': case 'NS': case 'PE': return ['HST'];
    case 'QC': return ['GST', 'QST'];
    case 'BC': case 'SK': case 'MB': return ['GST', 'PST'];
    default: return ['GST']; // AB, NT, NU, YT
  }
}

/** Recommended default tax-code name for a place of supply. The user may always choose another code. */
export function suggestedTaxCode(province: string): string {
  return { ON: 'HST_ON', NB: 'HST_NB', NL: 'HST_NL', NS: 'HST_NS', PE: 'HST_PE', QC: 'GST_QST', BC: 'GST_PST_BC', SK: 'GST_PST_SK', MB: 'GST_PST_MB' }[province] ?? 'GST';
}

/**
 * Starter tax codes and rates. NOT authoritative: these are seed data with the citation each rate rests on.
 * Verified against CRA: NS HST 14% from 2025-04-01 (was 15%); ON HST 13%; GST 5%; MB PST 7%.
 * Others (NB/NL/PE 15%, QST 9.975%, BC 7%, SK 6%) are from general knowledge and flagged `verify`.
 * Companies can edit/add rates; always confirm against CRA / Revenu Québec / provincial sources before filing.
 */
export interface SeedTaxCode { code: string; name: string; kind: 'TAXABLE' | 'ZERO_RATED' | 'EXEMPT'; rates: (Omit<RateRow, 'recoverable'> & { recoverable: boolean; source: string; verify?: boolean })[] }
const CRA = 'https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate.html';
const GST = { component: 'GST' as const, rate: '0.05', recoverable: true, effectiveFrom: '2008-01-01', source: CRA };
const hst = (rate: string, from: string, to?: string, verify = false) => ({ component: 'HST' as const, rate, recoverable: true, effectiveFrom: from, effectiveTo: to ?? null, source: CRA, verify });

export const SEED_TAX_CODES: SeedTaxCode[] = [
  { code: 'GST', name: 'GST 5%', kind: 'TAXABLE', rates: [GST] },
  { code: 'HST_ON', name: 'HST Ontario 13%', kind: 'TAXABLE', rates: [hst('0.13', '2010-07-01')] },
  { code: 'HST_NB', name: 'HST New Brunswick 15%', kind: 'TAXABLE', rates: [hst('0.15', '2016-07-01', undefined, true)] },
  { code: 'HST_NL', name: 'HST Newfoundland and Labrador 15%', kind: 'TAXABLE', rates: [hst('0.15', '2016-07-01', undefined, true)] },
  { code: 'HST_PE', name: 'HST Prince Edward Island 15%', kind: 'TAXABLE', rates: [hst('0.15', '2016-10-01', undefined, true)] },
  { code: 'HST_NS', name: 'HST Nova Scotia (15% → 14%)', kind: 'TAXABLE', rates: [hst('0.15', '2010-07-01', '2025-03-31', true), hst('0.14', '2025-04-01')] },
  { code: 'GST_QST', name: 'GST 5% + QST 9.975%', kind: 'TAXABLE', rates: [GST, { component: 'QST', rate: '0.09975', recoverable: true, effectiveFrom: '2013-01-01', source: 'Revenu Québec (verify)', verify: true }] },
  { code: 'GST_PST_BC', name: 'GST 5% + BC PST 7%', kind: 'TAXABLE', rates: [GST, { component: 'PST', rate: '0.07', recoverable: false, effectiveFrom: '2013-04-01', source: 'BC (verify)', verify: true }] },
  { code: 'GST_PST_SK', name: 'GST 5% + SK PST 6%', kind: 'TAXABLE', rates: [GST, { component: 'PST', rate: '0.06', recoverable: false, effectiveFrom: '2017-03-23', source: 'SK (verify)', verify: true }] },
  { code: 'GST_PST_MB', name: 'GST 5% + MB PST 7%', kind: 'TAXABLE', rates: [GST, { component: 'PST', rate: '0.07', recoverable: false, effectiveFrom: '2019-07-01', source: CRA }] },
  { code: 'ZERO', name: 'Zero-rated (0%)', kind: 'ZERO_RATED', rates: [] },
  { code: 'EXEMPT', name: 'Exempt', kind: 'EXEMPT', rates: [] },
];
