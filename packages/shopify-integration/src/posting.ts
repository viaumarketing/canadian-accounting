import Decimal from 'decimal.js';
import type { NormBalanceTransaction, NormOrder, NormPayout, NormRefund, NormTransaction } from './types';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });
const D = (v: Decimal.Value) => new Decimal(v);

/** Symbolic account keys; the API maps them to the company's ledger accounts via the store's account map. */
export type AccountKey =
  | 'clearing' | 'otherClearing' | 'sales' | 'shipping' | 'giftCard' | 'fees' | 'bank' | 'refunds'
  | 'reserve' | 'disputeHold' | 'chargebackFees' | 'shippingExpense' | 'classified'
  | 'tax:GST_HST' | 'tax:QST' | 'tax:PST';

export interface PlanLine { account: AccountKey; debit: string; credit: string; memo?: string }
export type Plan =
  | { kind: 'post'; lines: PlanLine[] }
  | { kind: 'skip'; reason: string }
  | { kind: 'review'; reason: string }
  | { kind: 'wait'; reason: string };

const dr = (account: AccountKey, v: Decimal.Value, memo?: string): PlanLine => ({ account, debit: D(v).toFixed(2), credit: '0.00', memo });
const cr = (account: AccountKey, v: Decimal.Value, memo?: string): PlanLine => ({ account, debit: '0.00', credit: D(v).toFixed(2), memo });
const nonZero = (l: PlanLine) => !D(l.debit).isZero() || !D(l.credit).isZero();

function finish(lines: PlanLine[]): Plan {
  const ls = lines.filter(nonZero);
  const d = ls.reduce((s, l) => s.plus(l.debit), D(0));
  const c = ls.reduce((s, l) => s.plus(l.credit), D(0));
  if (!d.eq(c)) return { kind: 'review', reason: `Internal imbalance: debits ${d.toFixed(2)} ≠ credits ${c.toFixed(2)}` };
  if (ls.length < 2 || d.isZero()) return { kind: 'skip', reason: 'Nothing to post (zero amount)' };
  return { kind: 'post', lines: ls };
}

/** Map a Shopify tax-line title to a Canadian tax component account. Unknown titles are NOT guessed. */
export function taxAccountFor(title: string): AccountKey | null {
  const t = title.toUpperCase();
  if (/\bQST\b|\bTVQ\b/.test(t)) return 'tax:QST';
  if (/\bHST\b|\bGST\b|\bTPS\b|\bTVH\b/.test(t)) return 'tax:GST_HST';
  if (/\bPST\b|\bRST\b/.test(t)) return 'tax:PST';
  return null;
}

type Category = 'clearing' | 'otherClearing' | 'giftCard';
export function gatewayCategory(gateway: string | null): Category {
  const g = (gateway ?? '').toLowerCase();
  if (g === 'shopify_payments') return 'clearing';
  if (g === 'gift_card') return 'giftCard';
  return 'otherClearing';
}

const isCapture = (t: NormTransaction) => (t.kind === 'SALE' || t.kind === 'CAPTURE') && t.status === 'SUCCESS' && !t.test;
const isRefundTxn = (t: NormTransaction) => t.kind === 'REFUND' && t.status === 'SUCCESS' && !t.test;

function byCategory(txns: NormTransaction[]): Map<Category, Decimal> {
  const m = new Map<Category, Decimal>();
  for (const t of txns) m.set(gatewayCategory(t.gateway), (m.get(gatewayCategory(t.gateway)) ?? D(0)).plus(t.amount));
  return m;
}

/** Tax by ledger account for an order, or a review reason. */
export function orderTaxByAccount(order: NormOrder): { byAccount: Map<AccountKey, Decimal> } | { review: string } {
  const by = new Map<AccountKey, Decimal>();
  for (const l of order.taxLines) {
    const k = taxAccountFor(l.title);
    if (!k) return { review: `Unrecognised tax line "${l.title}"; map it before posting` };
    by.set(k, (by.get(k) ?? D(0)).plus(l.amount));
  }
  const sum = [...by.values()].reduce((s, v) => s.plus(v), D(0));
  if (!sum.eq(order.tax)) return { review: `Tax lines (${sum.toFixed(2)}) do not add up to the order tax (${D(order.tax).toFixed(2)})` };
  return { byAccount: by };
}

/** Revenue recognition for one order. Posts once the full total has been captured; never guesses. */
export function planOrder(order: NormOrder): Plan {
  if (order.test) return { kind: 'skip', reason: 'Test order' };
  if (order.cancelledAt) return { kind: 'skip', reason: 'Cancelled order' };
  if (order.currencies.some((c) => c !== order.currency)) return { kind: 'review', reason: 'Order mixes currencies' };
  if (order.truncated.length) return { kind: 'review', reason: `Data was truncated (${order.truncated.join(', ')}); cannot post safely` };

  const captured = byCategory(order.transactions.filter(isCapture));
  const capturedTotal = [...captured.values()].reduce((s, v) => s.plus(v), D(0));
  if (!capturedTotal.eq(order.total)) {
    return { kind: 'wait', reason: `Payment not fully captured yet (${capturedTotal.toFixed(2)} of ${D(order.total).toFixed(2)})` };
  }
  const tax = orderTaxByAccount(order);
  if ('review' in tax) return { kind: 'review', reason: tax.review };

  const shipping = D(order.shippingNet);
  const giftCards = D(order.giftCardSales);
  const sales = D(order.total).minus(order.tax).minus(shipping).minus(giftCards);
  if (sales.isNegative()) return { kind: 'review', reason: 'Computed product sales are negative; the order needs a manual look' };

  const lines: PlanLine[] = [];
  for (const [cat, v] of captured) lines.push(dr(cat, v, order.name));
  lines.push(cr('sales', sales, order.name), cr('shipping', shipping, order.name), cr('giftCard', giftCards, `${order.name} gift cards sold`));
  for (const [k, v] of tax.byAccount) lines.push(cr(k, v, `${order.name} tax`));
  return finish(lines);
}

/** Split `amount` across weights in whole cents, largest remainder, so the parts sum exactly. */
export function allocate(amount: Decimal.Value, weights: Map<AccountKey, Decimal>): Map<AccountKey, Decimal> {
  const total = [...weights.values()].reduce((s, v) => s.plus(v), D(0));
  const out = new Map<AccountKey, Decimal>();
  if (total.isZero()) return out;
  const cents = D(amount).times(100).toDecimalPlaces(0);
  const raw = [...weights].map(([k, w]) => ({ k, exact: cents.times(w).div(total) }));
  let given = D(0);
  const parts = raw.map((r) => { const f = r.exact.floor(); given = given.plus(f); return { ...r, f, rem: r.exact.minus(f) }; });
  let left = cents.minus(given).toNumber();
  for (const p of [...parts].sort((a, b) => b.rem.comparedTo(a.rem))) { if (left <= 0) break; p.f = p.f.plus(1); left -= 1; }
  for (const p of parts) out.set(p.k, p.f.div(100));
  return out;
}

export function planRefund(order: NormOrder, refund: NormRefund): Plan {
  if (order.test) return { kind: 'skip', reason: 'Test order' };
  const paid = refund.transactions.filter(isRefundTxn);
  const cats = byCategory(paid);
  const paidTotal = [...cats.values()].reduce((s, v) => s.plus(v), D(0));
  if (!paidTotal.eq(refund.total)) {
    return { kind: 'review', reason: `Refund total ${D(refund.total).toFixed(2)} ≠ refunded to payment ${paidTotal.toFixed(2)} (store credit or pending?)` };
  }
  let taxParts = new Map<AccountKey, Decimal>();
  if (!D(refund.tax).isZero()) {
    const ot = orderTaxByAccount(order);
    if ('review' in ot) return { kind: 'review', reason: ot.review };
    if (ot.byAccount.size === 0) return { kind: 'review', reason: 'Refund has tax but the order has no tax lines' };
    taxParts = allocate(refund.tax, ot.byAccount);
  }
  const net = D(refund.total).minus(refund.tax);
  if (net.isNegative()) return { kind: 'review', reason: 'Refund tax exceeds refund total' };
  const lines: PlanLine[] = [dr('refunds', net, `Refund ${order.name}`)];
  for (const [k, v] of taxParts) lines.push(dr(k, v, `Refund ${order.name} tax`));
  for (const [cat, v] of cats) lines.push(cr(cat, v, `Refund ${order.name}`));
  return finish(lines);
}

const RESERVE_TYPES = new Set(['RESERVED_FUNDS', 'RESERVED_FUNDS_REVERSAL', 'RESERVED_FUNDS_WITHDRAWAL']);
const HOLD_TYPES = new Set(['CHARGEBACK_HOLD', 'CHARGEBACK_HOLD_RELEASE']);
const CHARGEBACK_FEE_TYPES = new Set(['CHARGEBACK_FEE', 'CHARGEBACK_FEE_REFUND']);
const SHIPPING_LABEL_TYPES = new Set(['SHIPPING_LABEL', 'SHIPPING_LABEL_ADJUSTMENT', 'SHIPPING_LABEL_ADJUSTMENT_BASE', 'SHIPPING_LABEL_ADJUSTMENT_SURCHARGE', 'SHIPPING_RETURN_TO_ORIGIN_ADJUSTMENT', 'SHIPPING_OTHER_CARRIER_CHARGE_ADJUSTMENT']);
const PAYOUT_TYPES = new Set(['TRANSFER']);
const PAYOUT_PROBLEM_TYPES = new Set(['TRANSFER_CANCEL', 'TRANSFER_FAILURE', 'TRANSFER_REFUND']);
/** CHARGE / REFUND amounts are recognised from orders and refunds, never from the balance transaction. */
const SOURCED_ELSEWHERE = new Set(['CHARGE', 'REFUND']);

export interface BalancePlan { fee: Plan; amount: Plan }

export function planBalanceTransaction(bt: NormBalanceTransaction, classifiedTo?: AccountKey): BalancePlan {
  if (bt.test) return { fee: { kind: 'skip', reason: 'Test transaction' }, amount: { kind: 'skip', reason: 'Test transaction' } };

  const fee = D(bt.fee);
  const feePlan: Plan = fee.isZero()
    ? { kind: 'skip', reason: 'No fee' }
    : finish(fee.gt(0) ? [dr('fees', fee, `Processing fee ${bt.orderName ?? bt.type}`), cr('clearing', fee, `Processing fee ${bt.orderName ?? bt.type}`)] : [dr('clearing', fee.abs(), `Fee refund ${bt.orderName ?? bt.type}`), cr('fees', fee.abs(), `Fee refund ${bt.orderName ?? bt.type}`)]);

  const amount = D(bt.amount);
  let amountPlan: Plan;
  if (SOURCED_ELSEWHERE.has(bt.type)) amountPlan = { kind: 'skip', reason: `${bt.type} amount is recognised from the order/refund record` };
  else if (PAYOUT_TYPES.has(bt.type)) amountPlan = { kind: 'skip', reason: 'Payout transfer is posted from the payout record' };
  else if (amount.isZero()) amountPlan = { kind: 'skip', reason: 'Zero amount' };
  else {
    let target: AccountKey | undefined = classifiedTo;
    if (!target) {
      if (RESERVE_TYPES.has(bt.type)) target = 'reserve';
      else if (HOLD_TYPES.has(bt.type)) target = 'disputeHold';
      else if (CHARGEBACK_FEE_TYPES.has(bt.type)) target = 'chargebackFees';
      else if (SHIPPING_LABEL_TYPES.has(bt.type)) target = 'shippingExpense';
    }
    if (!target) {
      amountPlan = { kind: 'review', reason: PAYOUT_PROBLEM_TYPES.has(bt.type) ? `${bt.type}: payout problem, needs a human decision` : `Type ${bt.type}${bt.adjustmentReason ? ` (${bt.adjustmentReason})` : ''} has no automatic mapping; choose an account` };
    } else {
      const m = `${bt.type} ${bt.orderName ?? ''}`.trim();
      amountPlan = finish(amount.gt(0) ? [dr('clearing', amount, m), cr(target, amount, m)] : [dr(target, amount.abs(), m), cr('clearing', amount.abs(), m)]);
    }
  }
  return { fee: feePlan, amount: amountPlan };
}

/** Σ net of a payout's balance transactions, excluding the payout's own TRANSFER lines. */
export function payoutComponentsNet(bts: NormBalanceTransaction[]): Decimal {
  return bts.filter((b) => !PAYOUT_TYPES.has(b.type) && !b.test).reduce((s, b) => s.plus(b.net), D(0));
}

export function planPayout(p: NormPayout, componentsNet: Decimal.Value): Plan {
  if (p.status !== 'PAID') return { kind: 'wait', reason: `Payout is ${p.status}; posts when PAID` };
  const net = D(p.net);
  if (p.direction === 'DEPOSIT' && !D(componentsNet).eq(net)) {
    return { kind: 'review', reason: `Σ balance transactions ${D(componentsNet).toFixed(2)} ≠ payout net ${net.toFixed(2)}; transactions may be missing or unclassified` };
  }
  const amt = net.abs();
  return finish(p.direction === 'DEPOSIT'
    ? [dr('bank', amt, `Shopify payout ${p.shopifyId.split('/').pop()}`), cr('clearing', amt, `Shopify payout ${p.shopifyId.split('/').pop()}`)]
    : [dr('clearing', amt, `Shopify withdrawal ${p.shopifyId.split('/').pop()}`), cr('bank', amt, `Shopify withdrawal ${p.shopifyId.split('/').pop()}`)]);
}

/** Fields whose change after posting means the posted journal may be wrong. */
export function orderFingerprint(o: NormOrder): string {
  return JSON.stringify([o.total, o.tax, o.shippingNet, o.giftCardSales, o.cancelledAt, [...o.taxLines].sort((a, b) => a.title.localeCompare(b.title)).map((t) => [t.title, t.amount]), o.transactions.filter(isCapture).map((t) => [t.shopifyId, t.amount, t.gateway]).sort()]);
}
