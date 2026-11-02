import Decimal from 'decimal.js';
import { taxAccountFor } from '@ca/shopify-integration';
import { col, row, type Report, type Row } from '@ca/reporting';
import { D, Ctx, addDays, balances, fiscalYearBounds, loadAccounts, m2, net, newReport, type Acct } from './common';
import { isoOf, toDate } from '../accounting/setup';

export type TaxKind = 'gst-hst' | 'qst' | 'pst';
const GROUPS: Record<TaxKind, { label: string; payable: string; receivable?: string; account: 'tax:GST_HST' | 'tax:QST' | 'tax:PST'; components: string[] }> = {
  'gst-hst': { label: 'GST/HST', payable: 'GST_HST_PAYABLE', receivable: 'GST_HST_RECEIVABLE', account: 'tax:GST_HST', components: ['GST', 'HST'] },
  qst: { label: 'QST', payable: 'QST_PAYABLE', receivable: 'QST_RECEIVABLE', account: 'tax:QST', components: ['QST'] },
  pst: { label: 'PST', payable: 'PST_PAYABLE', account: 'tax:PST', components: ['PST'] },
};
/** Entry types that collect tax from customers / that claim tax on purchases. Anything else touching a tax account is "other" and is listed, not guessed. */
const SALES = new Set(['invoice', 'credit_note', 'sales_receipt', 'shopify_order', 'shopify_refund']);
const PURCHASES = new Set(['bill', 'vendor_credit', 'expense']);

interface TaxLineRow { debit: Decimal; credit: Decimal; entryId: string; number: number | null; date: string; memo: string | null; source: string; accountId: string }

async function linesOn(c: Ctx, accountIds: string[], from: string, to: string): Promise<TaxLineRow[]> {
  if (!accountIds.length) return [];
  const lines = await c.prisma.journalLine.findMany({
    where: { companyId: c.companyId, accountId: { in: accountIds }, entry: { status: 'POSTED', date: { gte: toDate(from), lte: toDate(to) } } },
    include: { entry: { select: { id: true, number: true, date: true, memo: true, sourceType: true, reversalOfId: true } } },
    orderBy: [{ entry: { date: 'asc' } }, { entry: { number: 'asc' } }],
  });
  const origIds = [...new Set(lines.map((l) => l.entry.reversalOfId).filter((x): x is string => !!x))];
  const origs = origIds.length ? await c.prisma.journalEntry.findMany({ where: { id: { in: origIds } }, select: { id: true, sourceType: true } }) : [];
  const om = new Map(origs.map((o) => [o.id, o.sourceType]));
  return lines.map((l) => ({ debit: D(l.debit), credit: D(l.credit), entryId: l.entry.id, number: l.entry.number, date: isoOf(l.entry.date), memo: l.memo ?? l.entry.memo, source: l.entry.reversalOfId ? om.get(l.entry.reversalOfId) ?? 'reversal' : l.entry.sourceType, accountId: l.accountId }));
}

interface Positions { collected: Decimal; itc: Decimal; other: { date: string; number: number | null; source: string; memo: string | null; amount: Decimal }[]; otherNet: Decimal; bankCollected: Decimal }

async function positions(c: Ctx, kind: TaxKind, accts: Acct[], from: string, to: string): Promise<Positions & { payableId?: string; receivableId?: string }> {
  const g = GROUPS[kind];
  const payable = accts.find((a) => a.role === g.payable);
  const receivable = g.receivable ? accts.find((a) => a.role === g.receivable) : undefined;
  const lines = await linesOn(c, [payable?.id, receivable?.id].filter((x): x is string => !!x), from, to);
  const out: Positions = { collected: D(0), itc: D(0), other: [], otherNet: D(0), bankCollected: D(0) };
  for (const l of lines) {
    if (l.accountId === payable?.id) {
      const amt = l.credit.minus(l.debit); // + increases tax payable
      if (SALES.has(l.source) || l.source === 'bank_txn') { out.collected = out.collected.plus(amt); if (l.source === 'bank_txn') out.bankCollected = out.bankCollected.plus(amt); }
      else { out.other.push({ date: l.date, number: l.number, source: l.source, memo: l.memo, amount: amt }); out.otherNet = out.otherNet.plus(amt); }
    } else {
      const amt = l.debit.minus(l.credit); // + increases the receivable (an ITC)
      if (PURCHASES.has(l.source) || l.source === 'bank_txn') out.itc = out.itc.plus(amt);
      else { out.other.push({ date: l.date, number: l.number, source: l.source, memo: l.memo, amount: amt.neg() }); out.otherNet = out.otherNet.minus(amt); } // a receivable increase lowers the amount payable
    }
  }
  return { ...out, payableId: payable?.id, receivableId: receivable?.id };
}

const posOf = (b: Map<string, { debit: Decimal; credit: Decimal }>, payableId?: string, receivableId?: string) => {
  const p = payableId ? b.get(payableId) : undefined, r = receivableId ? b.get(receivableId) : undefined;
  return (p ? p.credit.minus(p.debit) : D(0)).minus(r ? r.debit.minus(r.credit) : D(0)); // net payable position
};

export interface TaxInputs {
  adj104?: string; adj107?: string; instalments110?: string; rebates111?: string; selfAssess?: string;
  /** Quick Method only: ITCs still claimable (capital and real property), and GST/HST-included eligible sales from other sources (Shopify, bank) with their rate */
  itcCapital?: string; qmOtherSales?: string; qmOtherRate?: string;
}
type QMRates = Record<string, { rate: string; credit?: string }>;

/** Invoice/credit-note and sales-receipt lines taxed at GST/HST, per tax code: GST/HST-included amount and the GST/HST on it (credit notes negative). */
async function gstHstSalesByCode(c: Ctx, from: string, to: string) {
  if (from > to) return new Map<string, { incl: Decimal; tax: Decimal; name: string }>();
  const [invLines, recLines] = await Promise.all([
    c.prisma.invoiceLine.findMany({ where: { companyId: c.companyId, invoice: { issueDate: { gte: toDate(from), lte: toDate(to) }, status: { in: ['POSTED', 'PARTIAL', 'PAID'] } } }, include: { invoice: { select: { kind: true } }, taxCode: { select: { code: true, name: true } } } }),
    c.prisma.salesReceiptLine.findMany({ where: { companyId: c.companyId, receipt: { date: { gte: toDate(from), lte: toDate(to) }, status: 'PAID' } }, include: { taxCode: { select: { code: true, name: true } } } }),
  ]);
  const lines = [...invLines, ...recLines.map((l) => ({ ...l, invoice: { kind: 'STANDARD' as const } }))];
  const m = new Map<string, { incl: Decimal; tax: Decimal; name: string }>();
  for (const l of lines) {
    const tax = (l.taxDetail as { component: string; amount: string }[]).filter((t) => t.component === 'GST' || t.component === 'HST').reduce((a, t) => a.plus(t.amount), D(0));
    if (tax.isZero()) continue; // zero-rated or exempt: not part of the Quick Method calculation
    const sign = l.invoice.kind === 'CREDIT' ? -1 : 1;
    const e = m.get(l.taxCode.code) ?? { incl: D(0), tax: D(0), name: l.taxCode.name };
    e.incl = e.incl.plus(D(String(l.net)).plus(tax).times(sign)); e.tax = e.tax.plus(tax.times(sign)); m.set(l.taxCode.code, e);
  }
  return m;
}
const dollars = (v: Decimal) => v.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
const cents = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export async function taxReport(c: Ctx, kind: TaxKind, p: { from: string; to: string } & TaxInputs): Promise<Report> {
  const g = GROUPS[kind];
  const accts = await loadAccounts(c);
  const pos = await positions(c, kind, accts, p.from, p.to);
  const r = newReport(c, `tax-${kind}`, `${g.label} Report`, `${p.from} to ${p.to} · preparation support, not a filing`);
  const [bOpen, bClose, bPeriod] = await Promise.all([balances(c, { to: addDays(p.from, -1) }), balances(c, { to: p.to }), balances(c, { from: p.from, to: p.to })]);
  const regs = await c.prisma.taxRegistration.findMany({ where: { companyId: c.companyId, kind: kind === 'gst-hst' ? 'GST_HST' : kind === 'qst' ? 'QST' : { in: ['PST_BC', 'PST_SK', 'PST_MB'] }, effectiveFrom: { lte: toDate(p.to) }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: toDate(p.from) } }] } });
  if (!regs.length) r.notes.push(`No ${g.label} registration is recorded for this period (Settings → Tax registration). Tax may still appear below if it was posted.`);
  else r.notes.push(`Registration: ${regs.map((x) => `${x.registrationNumber} (${x.filingFrequency.toLowerCase()})`).join(', ')}.`);

  const revenue = accts.filter((a) => a.type === 'REVENUE').reduce((s, a) => { const v = bPeriod.get(a.id); return v ? s.plus(v.credit.minus(v.debit)) : s; }, D(0));
  const num = (v?: string) => D(v && /^-?\d+(\.\d+)?$/.test(v) ? v : 0);

  if (kind === 'gst-hst') {
    const qm = regs.find((x) => x.quickMethodFrom && isoOf(x.quickMethodFrom) <= p.from);
    const starts = regs.find((x) => x.quickMethodFrom && isoOf(x.quickMethodFrom) > p.from && isoOf(x.quickMethodFrom) <= p.to);
    if (starts) r.checks.push({ label: 'The Quick Method election starts inside this period', ok: false, detail: `Run separate reports before and from ${isoOf(starts.quickMethodFrom!)}` });
    let l101: Decimal, l103: Decimal, l106: Decimal, l107: Decimal;
    let src: Record<'101' | '103' | '106' | '107' | '108', string>;
    let qmSection: Report['sections'][number] | null = null;
    if (!qm) {
      l101 = revenue; l103 = pos.collected; l106 = pos.itc; l107 = num(p.adj107);
      src = { '101': 'Ledger: revenue accounts, net of returns', '103': 'Ledger: GST/HST payable from invoices, credit notes, Shopify, bank receipts', '106': 'Ledger: GST/HST receivable from bills, expenses, bank payments', '107': 'You enter (e.g. bad-debt write-offs)', '108': '106 + 107 (regular method)' };
    } else {
      // Quick Method, following CRA guide RC4058 ("Filling out your GST/HST return using the quick method").
      const rates = (qm.quickMethodRates ?? {}) as QMRates;
      const cur = await gstHstSalesByCode(c, p.from, p.to);
      const groups = new Map<string, { rate: Decimal; credit: Decimal; incl: Decimal; codes: string[] }>();
      let nonEligibleTax = D(0); const nonEligible: string[] = [];
      for (const [code, v] of cur) {
        const rr = rates[code];
        if (!rr) { nonEligibleTax = nonEligibleTax.plus(v.tax); nonEligible.push(code); continue; }
        const k = `${rr.rate}|${rr.credit ?? '0'}`;
        const g0 = groups.get(k) ?? { rate: D(rr.rate), credit: D(rr.credit ?? 0), incl: D(0), codes: [] };
        g0.incl = g0.incl.plus(v.incl); g0.codes.push(code); groups.set(k, g0);
      }
      const otherSales = num(p.qmOtherSales);
      if (!otherSales.isZero()) {
        const rate = D(p.qmOtherRate && /^0(\.\d{1,4})?$/.test(p.qmOtherRate) ? p.qmOtherRate : 0);
        const k = `${rate.toString()}|0`;
        const g0 = groups.get(k) ?? { rate, credit: D(0), incl: D(0), codes: [] };
        g0.incl = g0.incl.plus(otherSales); g0.codes.push('other sales (you entered)'); groups.set(k, g0);
      }
      // Each remittance rate is calculated separately on its sales, rounded to the dollar like line 101.
      const calc = [...groups.values()].map((x) => ({ ...x, base: dollars(x.incl), remit: cents(dollars(x.incl).times(x.rate)), creditAmt: cents(dollars(x.incl).times(x.credit)) }));
      l101 = calc.reduce((a, x) => a.plus(x.base), D(0));
      l103 = calc.reduce((a, x) => a.plus(x.remit), D(0)).plus(nonEligibleTax);
      l106 = num(p.itcCapital).plus(calc.reduce((a, x) => a.plus(x.creditAmt), D(0)));
      // 1% credit on the first $30,000 of eligible supplies (GST/HST included) in each fiscal year, if the election was in
      // effect at the start of the fiscal year (or from the day a new registrant registered).
      const fy = await fiscalYearBounds(c, p.from);
      const qmFrom = isoOf(qm.quickMethodFrom!);
      const qualifies = qmFrom <= fy.start || qmFrom === isoOf(qm.effectiveFrom);
      const priorMap = await gstHstSalesByCode(c, fy.start > qmFrom ? fy.start : qmFrom, addDays(p.from, -1));
      const prior = [...priorMap].filter(([code]) => rates[code]).reduce((a, [, v]) => a.plus(v.incl), D(0));
      const room = Decimal.max(D(30000).minus(Decimal.max(prior, D(0))), D(0));
      const credit = qualifies ? cents(Decimal.min(Decimal.max(l101, D(0)), room).times('0.01')) : D(0);
      l107 = credit.plus(num(p.adj107));
      src = {
        '101': 'Eligible sales including GST/HST, rounded to the dollar per remittance rate (see the Quick Method calculation below)',
        '103': `Σ (sales × remittance rate)${nonEligible.length ? ` + full GST/HST on supplies with no Quick Method rate (${nonEligible.join(', ')})` : ''}`,
        '106': 'ITCs still claimable under the Quick Method (capital and real property, you enter) + credits on 0%-rate supplies',
        '107': `1% credit on the first $30,000 of eligible sales this fiscal year (${qualifies ? `${m2(credit)}; ${m2(prior)} already used earlier in the year` : 'not available: the election was not in effect at the start of the fiscal year'}) + adjustments you enter`,
        '108': '106 + 107 (Quick Method)',
      };
      qmSection = ({
        title: 'Quick Method calculation (CRA guide RC4058)',
        columns: [col('codes', 'Tax codes'), col('base', 'Eligible sales incl. GST/HST', 'money'), col('rate', 'Remittance rate', 'pct'), col('remit', 'Tax to remit (line 103)', 'money'), col('credit', 'Credit (line 106)', 'money')],
        rows: [
          ...calc.map((x) => row({ codes: x.codes.join(', '), base: m2(x.base), rate: x.rate.times(100).toNumber(), remit: m2(x.remit), credit: x.credit.isZero() ? null : m2(x.creditAmt) })),
          ...(nonEligible.length ? [row({ codes: `${nonEligible.join(', ')} (no Quick Method rate: reported in full)`, remit: m2(nonEligibleTax) })] : []),
        ],
        totals: [row({ codes: 'Total', base: m2(l101), remit: m2(l103), credit: m2(l106.minus(num(p.itcCapital))) }, { bold: true })],
      });
      // GST/HST in the ledger that did not come from invoices (Shopify orders, bank receipts) cannot be split by remittance rate here.
      const invoiceTax = [...cur.values()].reduce((a, v) => a.plus(v.tax), D(0));
      const unexplained = pos.collected.minus(invoiceTax);
      if (!unexplained.isZero()) {
        r.checks.push({ label: 'All GST/HST-taxed sales are in the Quick Method calculation', ok: !otherSales.isZero(), detail: `${m2(unexplained)} of GST/HST was collected outside invoices and sales receipts (Shopify orders, bank receipts). Enter those sales including GST/HST and their remittance rate in "Other eligible sales".` });
      }
      r.notes.push(`Quick Method in effect since ${qmFrom}. Remittance rates are the ones you recorded for each tax code (from the RC4058 rate charts); the system does not choose them. Invoices with a tax code that has no Quick Method rate are treated as supplies not eligible for the calculation, and their GST/HST is reported in full.`);
    }
    const l104 = num(p.adj104), l105 = l103.plus(l104);
    const l108 = l106.plus(l107);
    const l109 = l105.minus(l108);
    const rows: Row[] = [
      row({ line: '101', name: qm ? 'Eligible sales and other revenue, including GST/HST (Quick Method)' : 'Total sales and other revenue (excluding GST/HST and PST)', amount: m2(l101), src: src['101'] }),
      row({ line: '103', name: 'GST/HST collected or collectible', amount: m2(l103), src: src['103'] }),
      row({ line: '104', name: 'Adjustments to be added to the net tax', amount: m2(l104), src: 'You enter (e.g. recovered bad debts)' }),
      row({ line: '105', name: 'Total GST/HST and adjustments', amount: m2(l105), src: '103 + 104' }, { bold: true }),
      row({ line: '106', name: 'GST/HST paid or payable (ITCs)', amount: m2(l106), src: src['106'] }),
      row({ line: '107', name: 'Adjustments to be deducted', amount: m2(l107), src: src['107'] }),
      row({ line: '108', name: 'Total ITCs and adjustments', amount: m2(l108), src: src['108'] }, { bold: true }),
      row({ line: '109', name: 'Net tax', amount: m2(l109), src: '105 − 108; a negative number is a refund position' }, { bold: true }),
    ];
    const l110 = num(p.instalments110), l111 = num(p.rebates111), self = num(p.selfAssess);
    const ind = l109.minus(l110).minus(l111).plus(self);
    rows.push(
      row({ line: '110', name: 'Instalments and other payments made', amount: m2(l110), src: 'You enter' }),
      row({ line: '111', name: 'Rebates claimed', amount: m2(l111), src: 'You enter' }),
      row({ line: '205/405', name: 'Self-assessed GST/HST (real property, goods brought into a participating province)', amount: m2(self), src: 'You enter' }),
      row({ line: '114/115', name: ind.isNegative() ? 'Indicative refund' : 'Indicative amount owing', amount: m2(ind), src: '109 − 110 − 111 + 205/405' }, { bold: true }),
    );
    r.sections.push({ title: 'Return preparation (CRA GST/HST return lines)', columns: [col('line', 'Line'), col('name', 'Description'), col('amount', 'Amount', 'money'), col('src', 'Source')], rows });
    // Quick Method detail after the return lines it supports.
    if (qmSection) r.sections.push(qmSection);
    if (qm) {
      // The books still hold all GST/HST collected and every ITC recorded on purchases; the Quick Method keeps the difference.
      const adj = pos.collected.minus(pos.itc).minus(l109);
      r.sections.push({
        title: 'Suggested entry to record this return under the Quick Method (not posted)',
        columns: [col('name', 'Account'), col('debit', 'Debit', 'money'), col('credit', 'Credit', 'money')],
        rows: [
          row({ name: 'GST/HST payable (all collected this period)', debit: m2(pos.collected) }),
          row({ name: 'GST/HST receivable (ITCs recorded on purchases this period)', credit: m2(pos.itc) }),
          row({ name: 'GST/HST to remit (line 109)', credit: m2(l109) }),
          row({ name: adj.isNegative() ? 'Quick Method adjustment (expense)' : 'Quick Method adjustment (other income)', ...(adj.isNegative() ? { debit: m2(adj.neg()) } : { credit: m2(adj) }) }),
        ],
      });
    }
    r.notes.push('Line numbers follow the CRA GST/HST return instructions. The system computes 101, 103, 105, 106, 108 and 109 from the ledger; 104, 107, 110, 111 and 205/405 depend on facts the ledger cannot know, so you enter them (query inputs adj104, adj107, instalments110, rebates111, selfAssess). The Quick Method is supported when it is recorded on the GST/HST registration; simplified-ITC filers calculate differently. Nothing is filed by this system.');
  } else {
    r.sections.push({ title: `${g.label} summary`, columns: [col('name', 'Item'), col('amount', 'Amount', 'money')], rows: [
      row({ name: `${g.label} collected from customers`, amount: m2(pos.collected) }),
      ...(g.receivable ? [row({ name: `${g.label} recoverable on purchases (input credits)`, amount: m2(pos.itc) })] : []),
      row({ name: 'Total sales and other revenue (for reference)', amount: m2(revenue) }),
    ], totals: g.receivable ? [row({ name: `Net ${g.label} before remittances and adjustments`, amount: m2(pos.collected.minus(pos.itc)) }, { bold: true })] : [row({ name: `${g.label} collected`, amount: m2(pos.collected) }, { bold: true })] });
    r.notes.push(kind === 'qst' ? 'Revenu Québec form line numbers were not verified and are not shown; use these components to complete your QST return.' : 'PST rules and return layouts differ by province and were not verified; PST paid on purchases is not recoverable and is included in the related expense, not shown as a credit.');
  }

  if (pos.other.length) {
    r.sections.push({ title: 'Other movements in the tax account (review: remittances, refunds, manual adjustments)', columns: [col('date', 'Date', 'date'), col('number', '#', 'int'), col('source', 'Source'), col('memo', 'Memo'), col('amount', 'Effect on amount payable', 'money')], rows: pos.other.map((o) => row({ date: o.date, number: o.number, source: o.source, memo: o.memo, amount: m2(o.amount) })), totals: [row({ memo: 'Net', amount: m2(pos.otherNet) }, { bold: true })] });
  }

  // Roll-forward: ties the period's activity to the balances of the tax accounts.
  const open = posOf(bOpen, pos.payableId, pos.receivableId), close = posOf(bClose, pos.payableId, pos.receivableId);
  const computed = open.plus(pos.collected).minus(pos.itc).plus(pos.otherNet);
  r.sections.push({ title: `${g.label} account roll-forward (net payable position)`, columns: [col('name', 'Item'), col('amount', 'Amount', 'money')], rows: [
    row({ name: `Opening balance (${addDays(p.from, -1)})`, amount: m2(open) }), row({ name: '+ Collected', amount: m2(pos.collected) }), ...(g.receivable ? [row({ name: '− Input credits on purchases', amount: m2(pos.itc) })] : []),
    row({ name: '± Other movements (remittances, refunds, adjustments)', amount: m2(pos.otherNet) }),
  ], totals: [row({ name: `Computed closing balance (${p.to})`, amount: m2(computed) }, { bold: true }), row({ name: 'Ledger balance of the tax account(s)', amount: m2(close) }, { bold: true })] });
  r.checks.push({ label: `Roll-forward equals the ${g.label} account balance in the ledger`, ok: computed.eq(close), detail: computed.eq(close) ? undefined : `computed ${m2(computed)} vs ledger ${m2(close)}` });

  // Supporting schedules by tax code (document lines) + Shopify, reconciled to the ledger.
  await schedules(c, kind, p, pos, r);
  return r;
}

async function schedules(c: Ctx, kind: TaxKind, p: { from: string; to: string }, pos: Positions, r: Report) {
  const g = GROUPS[kind];
  const range = { gte: toDate(p.from), lte: toDate(p.to) };
  const okStatus = { in: ['POSTED', 'PARTIAL', 'PAID'] as ('POSTED' | 'PARTIAL' | 'PAID')[] };
  type Detail = { component: string; amount: string; recoverable: boolean }[];
  const [invOnly, rec, bill, exp] = await Promise.all([
    c.prisma.invoiceLine.findMany({ where: { companyId: c.companyId, invoice: { issueDate: range, status: okStatus } }, include: { invoice: { select: { kind: true } }, taxCode: { select: { code: true, name: true } } } }),
    c.prisma.salesReceiptLine.findMany({ where: { companyId: c.companyId, receipt: { date: range, status: 'PAID' } }, include: { taxCode: { select: { code: true, name: true } } } }),
    c.prisma.billLine.findMany({ where: { companyId: c.companyId, bill: { issueDate: range, status: okStatus } }, include: { bill: { select: { kind: true } }, taxCode: { select: { code: true, name: true } } } }),
    c.prisma.expenseLine.findMany({ where: { companyId: c.companyId, expense: { date: range, status: 'POSTED' } }, include: { taxCode: { select: { code: true, name: true } } } }),
  ]);
  const sum = (lines: { net: unknown; taxDetail: unknown; taxCode: { code: string; name: string } }[], signOf: (i: number) => number, recoverableOnly: boolean) => {
    const m = new Map<string, { base: Decimal; tax: Decimal; name: string }>();
    lines.forEach((l, i) => {
      const s = signOf(i);
      const tax = (l.taxDetail as Detail).filter((t) => g.components.includes(t.component) && (!recoverableOnly || t.recoverable)).reduce((a, t) => a.plus(t.amount), D(0));
      const e = m.get(l.taxCode.code) ?? { base: D(0), tax: D(0), name: l.taxCode.name };
      e.base = e.base.plus(D(String(l.net)).times(s)); e.tax = e.tax.plus(tax.times(s)); m.set(l.taxCode.code, e);
    });
    return m;
  };
  const inv = [...invOnly, ...rec.map((l) => ({ ...l, invoice: { kind: 'STANDARD' as const } }))];
  const sales = sum(inv, (i) => (inv[i].invoice.kind === 'CREDIT' ? -1 : 1), false);
  const purch = new Map<string, { base: Decimal; tax: Decimal; name: string }>();
  for (const [k, v] of [...sum(bill, (i) => (bill[i].bill.kind === 'CREDIT' ? -1 : 1), true), ...sum(exp, () => 1, true)]) { const e = purch.get(k) ?? { base: D(0), tax: D(0), name: v.name }; e.base = e.base.plus(v.base); e.tax = e.tax.plus(v.tax); purch.set(k, e); }
  const sched = (title: string, m: Map<string, { base: Decimal; tax: Decimal; name: string }>, taxLabel: string) => {
    const rows = [...m].filter(([, v]) => !v.base.isZero() || !v.tax.isZero()).map(([k, v]) => row({ code: k, name: v.name, base: m2(v.base), tax: m2(v.tax) }));
    const tb = [...m.values()].reduce((s, v) => s.plus(v.base), D(0)), tt = [...m.values()].reduce((s, v) => s.plus(v.tax), D(0));
    r.sections.push({ title, columns: [col('code', 'Tax code'), col('name', 'Description'), col('base', 'Amount before tax', 'money'), col('tax', taxLabel, 'money')], rows, totals: [row({ name: 'Total', base: m2(tb), tax: m2(tt) }, { bold: true })] });
    return tt;
  };
  const docSales = sched('Schedule: sales documents by tax code (invoices and sales receipts, less credit notes)', sales, `${g.label} collected`);
  const docItc = g.receivable ? sched('Schedule: purchase documents and expenses by tax code', purch, `${g.label} recoverable`) : D(0);

  // Shopify orders by tax title, mapped with the same rule the posting engine uses.
  const entries = await c.prisma.journalEntry.findMany({ where: { companyId: c.companyId, status: 'POSTED', date: range, sourceType: { in: ['shopify_order', 'shopify_refund'] }, reversalOfId: null }, select: { id: true, sourceType: true } });
  const orderEntryIds = entries.filter((e) => e.sourceType === 'shopify_order').map((e) => e.id);
  const refundEntryIds = entries.filter((e) => e.sourceType === 'shopify_refund').map((e) => e.id);
  const orders = orderEntryIds.length ? await c.prisma.shopifyOrder.findMany({ where: { journalEntryId: { in: orderEntryIds } }, select: { payload: true } }) : [];
  const byTitle = new Map<string, Decimal>();
  let shopTax = D(0);
  for (const o of orders) for (const t of ((o.payload as { taxLines?: { title: string; amount: string }[] }).taxLines ?? [])) {
    if (taxAccountFor(t.title) !== g.account) continue;
    byTitle.set(t.title, (byTitle.get(t.title) ?? D(0)).plus(t.amount)); shopTax = shopTax.plus(t.amount);
  }
  // Refund tax is allocated across components in the order's proportions, so ask the ledger for it directly.
  const refundTax = refundEntryIds.length ? await refundTaxFromLedger(c, g.payable, refundEntryIds) : D(0);
  if (byTitle.size || !refundTax.isZero()) {
    r.sections.push({ title: 'Schedule: Shopify orders by tax name', columns: [col('name', 'Tax name on the order'), col('tax', `${g.label} collected`, 'money')], rows: [...byTitle].map(([k, v]) => row({ name: k, tax: m2(v) })), totals: [row({ name: 'Orders', tax: m2(shopTax) }, { bold: true }), row({ name: 'Less: tax on Shopify refunds (from the ledger)', tax: m2(refundTax.neg()) }), row({ name: 'Net Shopify', tax: m2(shopTax.minus(refundTax)) }, { bold: true })] });
  }
  const explained = docSales.plus(shopTax).minus(refundTax).plus(pos.bankCollected);
  r.checks.push({ label: `Ledger ${g.label} collected = document schedule + Shopify + bank receipts`, ok: explained.eq(pos.collected), detail: explained.eq(pos.collected) ? undefined : `ledger ${m2(pos.collected)} vs schedules ${m2(explained)}: tax posted without document detail` });
  if (g.receivable) r.notes.push(`The purchase schedule lists documents and expenses only; ${g.label} claimed through bank-transaction categorisation is in the ledger totals above but not in the schedule (recoverable per schedule: ${m2(docItc)}).`);
  r.notes.push('Reports are prepared on the accrual basis (tax recorded when documents are posted). If you account for GST/HST on another basis (e.g. cash, quick method), treat these as supporting data only.');
}

async function refundTaxFromLedger(c: Ctx, payableRole: string, entryIds: string[]): Promise<Decimal> {
  const rows = await c.prisma.journalLine.aggregate({ where: { companyId: c.companyId, entryId: { in: entryIds }, account: { role: payableRole as 'GST_HST_PAYABLE' } }, _sum: { debit: true, credit: true } });
  return D(rows._sum.debit ?? 0).minus(rows._sum.credit ?? 0); // refunds debit the payable account
}

/** Reporting periods derived from the registration's frequency and the company's fiscal year (confirm against your CRA account). */
export async function filingPeriods(c: Ctx, onDate: string) {
  const fy = await fiscalYearBounds(c, onDate);
  const prev = await fiscalYearBounds(c, addDays(fy.start, -1));
  const regs = await c.prisma.taxRegistration.findMany({ where: { companyId: c.companyId }, orderBy: [{ kind: 'asc' }, { effectiveFrom: 'desc' }] });
  const months = (start: string, step: number, count: number) => Array.from({ length: count }, (_, i) => { const s = new Date(toDate(start)); s.setUTCMonth(s.getUTCMonth() + i * step); const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + step, 0)); return { from: isoOf(s), to: isoOf(e) }; });
  return regs.map((r) => ({
    registrationId: r.id, kind: r.kind, number: r.registrationNumber, frequency: r.filingFrequency,
    periods: [prev, fy].flatMap((y) => r.filingFrequency === 'ANNUAL' ? [{ from: y.start, to: y.end }] : r.filingFrequency === 'QUARTERLY' ? months(y.start, 3, 4) : months(y.start, 1, 12)).filter((x) => x.to >= isoOf(r.effectiveFrom)),
    note: 'Computed from your fiscal year; confirm against your filing schedule.',
  }));
}
export { net };
