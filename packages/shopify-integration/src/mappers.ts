import Decimal from 'decimal.js';
import type { NormBalanceTransaction, NormDispute, NormOrder, NormPayout, NormRefund, NormTaxLine, NormTransaction } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any;

const D = (v: Decimal.Value) => new Decimal(v);
const amt = (m: Raw): string => D(m?.amount ?? 0).toFixed(4).replace(/\.?0+$/, '') || '0';
const bag = (b: Raw): string => amt(b?.shopMoney);
const gidNumeric = (gid: string | null | undefined): string | null => (gid ? (gid.match(/(\d+)(?:\?.*)?$/)?.[1] ?? null) : null);
export const numericId = gidNumeric;

function mapTxn(t: Raw, shopCurrency: string, seen: Set<string>): NormTransaction {
  const cur = t.amountSet?.shopMoney?.currencyCode;
  if (cur) seen.add(cur);
  const fees: Raw[] = t.fees ?? [];
  return {
    shopifyId: t.id,
    numericId: gidNumeric(t.id),
    kind: t.kind,
    status: t.status,
    gateway: t.gateway ?? null,
    amount: bag(t.amountSet),
    currency: cur ?? shopCurrency,
    processedAt: t.processedAt ?? null,
    test: Boolean(t.test),
    parentShopifyId: t.parentTransaction?.id ?? null,
    feeAmount: fees.reduce((s, f) => s.plus(amt(f.amount)), D(0)).toString(),
    feeTax: fees.reduce((s, f) => s.plus(amt(f.taxAmount)), D(0)).toString(),
  };
}

function mergeTax(lines: NormTaxLine[]): NormTaxLine[] {
  const m = new Map<string, NormTaxLine>();
  for (const l of lines) {
    const cur = m.get(l.title);
    if (cur) cur.amount = D(cur.amount).plus(l.amount).toString();
    else m.set(l.title, { ...l });
  }
  return [...m.values()];
}

export function mapOrder(o: Raw): NormOrder {
  const seen = new Set<string>([o.currencyCode]);
  const truncated: string[] = [];
  const taxesIncluded = Boolean(o.taxesIncluded);

  const lines: Raw[] = o.lineItems?.nodes ?? [];
  if (o.lineItems?.pageInfo?.hasNextPage) truncated.push('lineItems');
  const giftCardSales = lines.filter((l) => l.isGiftCard).reduce((s, l) => s.plus(bag(l.originalTotalSet)), D(0));

  const ship: Raw[] = o.shippingLines?.nodes ?? [];
  if (o.shippingLines?.pageInfo?.hasNextPage) truncated.push('shippingLines');
  const shipGross = ship.reduce((s, l) => s.plus(bag(l.discountedPriceSet)), D(0));
  const shipTaxLines: NormTaxLine[] = ship.flatMap((l) => (l.taxLines ?? []).map((t: Raw) => ({ title: t.title, amount: bag(t.priceSet), rate: t.ratePercentage ?? null })));
  const shipTax = shipTaxLines.reduce((s, t) => s.plus(t.amount), D(0));
  const shippingNet = taxesIncluded ? shipGross.minus(shipTax) : shipGross;

  const orderTax: NormTaxLine[] = (o.taxLines ?? []).map((t: Raw) => ({ title: t.title, amount: bag(t.priceSet), rate: t.ratePercentage ?? null }));

  const txns: NormTransaction[] = (o.transactions ?? []).map((t: Raw) => mapTxn(t, o.currencyCode, seen));

  const refunds: NormRefund[] = (o.refunds ?? []).map((r: Raw) => {
    if (r.refundLineItems?.pageInfo?.hasNextPage) truncated.push(`refund ${r.id} refundLineItems`);
    if (r.transactions?.pageInfo?.hasNextPage) truncated.push(`refund ${r.id} transactions`);
    const rl: Raw[] = r.refundLineItems?.nodes ?? [];
    return {
      shopifyId: r.id,
      processedAt: r.processedAt,
      total: bag(r.totalRefundedSet),
      tax: rl.reduce((s, x) => s.plus(bag(x.totalTaxSet)), D(0)).toString(),
      transactions: (r.transactions?.nodes ?? []).map((t: Raw) => mapTxn(t, o.currencyCode, seen)),
    };
  });
  for (const k of [o.totalPriceSet, o.totalTaxSet, o.totalDiscountsSet]) if (k?.shopMoney?.currencyCode) seen.add(k.shopMoney.currencyCode);

  return {
    shopifyId: o.id,
    name: o.name,
    processedAt: o.processedAt,
    updatedAt: o.updatedAt,
    cancelledAt: o.cancelledAt ?? null,
    test: Boolean(o.test),
    currency: o.currencyCode,
    taxesIncluded,
    financialStatus: o.displayFinancialStatus ?? null,
    gateways: o.paymentGatewayNames ?? [],
    total: bag(o.totalPriceSet),
    tax: bag(o.totalTaxSet),
    discounts: bag(o.totalDiscountsSet),
    shippingNet: shippingNet.toString(),
    giftCardSales: giftCardSales.toString(),
    taxLines: mergeTax([...orderTax, ...shipTaxLines]),
    lineItemCount: lines.length,
    truncated,
    currencies: [...seen],
    transactions: txns,
    refunds,
  };
}

export function mapPayout(p: Raw): NormPayout {
  const s = p.summary ?? {};
  return {
    shopifyId: p.id,
    issuedAt: p.issuedAt,
    status: p.status,
    direction: p.transactionType === 'WITHDRAWAL' ? 'WITHDRAWAL' : 'DEPOSIT',
    net: amt(p.net),
    currency: p.net?.currencyCode,
    externalTraceId: p.externalTraceId ?? null,
    summary: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, amt(v)])),
  };
}

export function mapBalanceTransaction(b: Raw): NormBalanceTransaction {
  return {
    shopifyId: b.id,
    type: b.type,
    test: Boolean(b.test),
    transactionDate: b.transactionDate,
    amount: amt(b.amount),
    fee: amt(b.fee),
    net: amt(b.net),
    currency: b.net?.currencyCode ?? b.amount?.currencyCode,
    sourceType: b.sourceType ?? null,
    sourceId: b.sourceId != null ? String(b.sourceId) : null,
    sourceOrderTransactionId: b.sourceOrderTransactionId != null ? String(b.sourceOrderTransactionId) : null,
    adjustmentReason: b.adjustmentReason ?? null,
    orderName: b.associatedOrder?.name ?? null,
    payoutShopifyId: b.associatedPayout?.id ?? null,
    payoutStatus: b.associatedPayout?.status ?? null,
  };
}

export function mapDispute(d: Raw): NormDispute {
  return {
    shopifyId: d.id,
    amount: amt(d.amount),
    currency: d.amount?.currencyCode,
    status: d.status,
    type: d.type,
    initiatedAt: d.initiatedAt,
    finalizedOn: d.finalizedOn ?? null,
    orderShopifyId: d.order?.id ?? null,
  };
}
