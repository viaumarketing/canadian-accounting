/**
 * Every query below is validated against Shopify's published schema for API 2026-10 by
 * scripts/validate-queries.mjs. Money fields use shopMoney (the shop's own currency).
 */
const M = '{ amount currencyCode }';
const SET = `{ shopMoney ${M} }`;

export const API_VERSION = '2026-10';

export const SHOP_QUERY = `query ShopInfo {
  shop { name myshopifyDomain currencyCode ianaTimezone }
  shopifyPaymentsAccount { activated defaultCurrency }
}`;

export const ORDERS_QUERY = `query Orders($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name processedAt updatedAt cancelledAt test currencyCode taxesIncluded displayFinancialStatus paymentGatewayNames
      totalPriceSet ${SET}
      totalTaxSet ${SET}
      totalDiscountsSet ${SET}
      taxLines { title ratePercentage priceSet ${SET} }
      lineItems(first: 100) {
        pageInfo { hasNextPage }
        nodes { id isGiftCard originalTotalSet ${SET} }
      }
      shippingLines(first: 10) {
        pageInfo { hasNextPage }
        nodes { discountedPriceSet ${SET} taxLines { title ratePercentage priceSet ${SET} } }
      }
      transactions(first: 50) {
        id kind status gateway processedAt test
        amountSet ${SET}
        parentTransaction { id }
        fees { amount ${M} taxAmount ${M} }
      }
      refunds(first: 20) {
        id processedAt
        totalRefundedSet ${SET}
        refundLineItems(first: 100) { pageInfo { hasNextPage } nodes { totalTaxSet ${SET} } }
        transactions(first: 20) {
          pageInfo { hasNextPage }
          nodes { id kind status gateway processedAt test amountSet ${SET} parentTransaction { id } fees { amount ${M} taxAmount ${M} } }
        }
      }
    }
  }
}`;

export const PAYOUTS_QUERY = `query Payouts($first: Int!, $after: String, $query: String) {
  shopifyPaymentsAccount {
    payouts(first: $first, after: $after, query: $query, sortKey: ISSUED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id issuedAt status transactionType externalTraceId
        net ${M}
        summary {
          chargesGross ${M} chargesFee ${M} refundsFee ${M} refundsFeeGross ${M}
          adjustmentsGross ${M} adjustmentsFee ${M} reservedFundsGross ${M} reservedFundsFee ${M}
          advanceGross ${M} advanceFees ${M} retriedPayoutsGross ${M} retriedPayoutsFee ${M}
        }
      }
    }
  }
}`;

export const BALANCE_TRANSACTIONS_QUERY = `query BalanceTransactions($first: Int!, $after: String, $query: String) {
  shopifyPaymentsAccount {
    balanceTransactions(first: $first, after: $after, query: $query, sortKey: PROCESSED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id type test transactionDate sourceType sourceId sourceOrderTransactionId adjustmentReason
        amount ${M} fee ${M} net ${M}
        associatedOrder { id name }
        associatedPayout { id status }
      }
    }
  }
}`;

export const DISPUTES_QUERY = `query Disputes($first: Int!, $after: String, $query: String) {
  shopifyPaymentsAccount {
    disputes(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes { id status type initiatedAt finalizedOn amount ${M} order { id } }
    }
  }
}`;

export const WEBHOOK_CREATE_MUTATION = `mutation WebhookCreate($topic: WebhookSubscriptionTopic!, $uri: String!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`;

export const ALL_QUERIES = { SHOP_QUERY, ORDERS_QUERY, PAYOUTS_QUERY, BALANCE_TRANSACTIONS_QUERY, DISPUTES_QUERY, WEBHOOK_CREATE_MUTATION };
