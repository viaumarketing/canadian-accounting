/* eslint-disable @typescript-eslint/no-explicit-any */
// Synthetic Canadian orders shaped like the verified 2026-10 GraphQL schema. Not real customer data.
const m = (amount: string, currencyCode = 'CAD') => ({ shopMoney: { amount, currencyCode } });
const money = (amount: string, currencyCode = 'CAD') => ({ amount, currencyCode });

export const txn = (id: number, kind: string, amount: string, over: any = {}) => ({
  id: `gid://shopify/OrderTransaction/${id}`, kind, status: 'SUCCESS', gateway: 'shopify_payments', processedAt: '2026-10-05T15:00:00Z', test: false,
  amountSet: m(amount), parentTransaction: null, fees: [], ...over,
});

/** Ontario order: 2 items $100 + $10 shipping, HST 13% = $14.30, total $124.30, paid by Shopify Payments (fee $3.92). */
export const ontarioOrder = (over: any = {}) => ({
  id: 'gid://shopify/Order/1001', name: '#1001', processedAt: '2026-10-05T14:59:00Z', updatedAt: '2026-10-05T15:01:00Z', cancelledAt: null, test: false,
  currencyCode: 'CAD', taxesIncluded: false, displayFinancialStatus: 'PAID', paymentGatewayNames: ['shopify_payments'],
  totalPriceSet: m('124.30'), totalTaxSet: m('14.30'), totalDiscountsSet: m('0.00'),
  taxLines: [{ title: 'HST', ratePercentage: 13, priceSet: m('13.00') }],
  lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'gid://shopify/LineItem/1', isGiftCard: false, originalTotalSet: m('100.00') }] },
  shippingLines: { pageInfo: { hasNextPage: false }, nodes: [{ discountedPriceSet: m('10.00'), taxLines: [{ title: 'HST', ratePercentage: 13, priceSet: m('1.30') }] }] },
  transactions: [txn(5001, 'SALE', '124.30', { fees: [{ amount: money('3.92'), taxAmount: money('0.00') }] })],
  refunds: [], ...over,
});

/** Quebec order, taxes included: $114.98 total => 100.00 + GST 5.00 + QST 9.98. */
export const quebecOrderTaxIncluded = () => ontarioOrder({
  id: 'gid://shopify/Order/2001', name: '#2001', taxesIncluded: true,
  totalPriceSet: m('114.98'), totalTaxSet: m('14.98'), taxLines: [{ title: 'GST', ratePercentage: 5, priceSet: m('5.00') }, { title: 'QST', ratePercentage: 9.975, priceSet: m('9.98') }],
  lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'gid://shopify/LineItem/9', isGiftCard: false, originalTotalSet: m('114.98') }] },
  shippingLines: { pageInfo: { hasNextPage: false }, nodes: [] },
  transactions: [txn(6001, 'SALE', '114.98')],
});

export const refund = (id: number, total: string, tax: string, gateway = 'shopify_payments') => ({
  id: `gid://shopify/Refund/${id}`, processedAt: '2026-10-08T12:00:00Z', totalRefundedSet: m(total),
  refundLineItems: { pageInfo: { hasNextPage: false }, nodes: [{ totalTaxSet: m(tax) }] },
  transactions: { pageInfo: { hasNextPage: false }, nodes: [txn(7000 + id, 'REFUND', total, { gateway })] },
});

export const payoutNode = (id: number, net: string, status = 'PAID') => ({
  id: `gid://shopify/ShopifyPaymentsPayout/${id}`, issuedAt: '2026-10-09T00:00:00Z', status, transactionType: 'DEPOSIT', externalTraceId: 'TRACE1', net: money(net),
  summary: { chargesGross: money('124.30'), chargesFee: money('3.92'), refundsFee: money('0.00'), refundsFeeGross: money('0.00'), adjustmentsGross: money('0.00'), adjustmentsFee: money('0.00'), reservedFundsGross: money('0.00'), reservedFundsFee: money('0.00'), advanceGross: money('0.00'), advanceFees: money('0.00'), retriedPayoutsGross: money('0.00'), retriedPayoutsFee: money('0.00') },
});

export const btNode = (id: number, type: string, amount: string, fee: string, net: string, over: any = {}) => ({
  id: `gid://shopify/ShopifyPaymentsBalanceTransaction/${id}`, type, test: false, transactionDate: '2026-10-05T15:00:00Z', sourceType: 'CHARGE', sourceId: '1', sourceOrderTransactionId: '5001', adjustmentReason: null,
  amount: money(amount), fee: money(fee), net: money(net), associatedOrder: { id: 'gid://shopify/Order/1001', name: '#1001' }, associatedPayout: { id: 'gid://shopify/ShopifyPaymentsPayout/9001', status: 'PAID' }, ...over,
});
