/** Normalised, accounting-oriented shapes. Money is always a decimal string in the SHOP currency. */
export interface NormTransaction {
  shopifyId: string;
  numericId: string | null;
  kind: string; // OrderTransactionKind
  status: string; // OrderTransactionStatus
  gateway: string | null;
  amount: string;
  currency: string;
  processedAt: string | null;
  test: boolean;
  parentShopifyId: string | null;
  feeAmount: string;
  feeTax: string;
}

export interface NormRefund {
  shopifyId: string;
  processedAt: string;
  total: string;
  tax: string;
  transactions: NormTransaction[];
}

export interface NormTaxLine { title: string; amount: string; rate: number | null }

export interface NormOrder {
  shopifyId: string;
  name: string;
  processedAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  test: boolean;
  currency: string;
  taxesIncluded: boolean;
  financialStatus: string | null;
  gateways: string[];
  total: string;
  tax: string;
  discounts: string;
  /** Shipping after shipping discounts, EXCLUDING tax. */
  shippingNet: string;
  giftCardSales: string;
  taxLines: NormTaxLine[]; // order + shipping tax lines, merged by title
  lineItemCount: number;
  truncated: string[]; // connections that had more pages than we fetched
  currencies: string[]; // every currency seen (should be exactly one)
  transactions: NormTransaction[];
  refunds: NormRefund[];
}

export interface NormPayout {
  shopifyId: string;
  issuedAt: string;
  status: string;
  direction: 'DEPOSIT' | 'WITHDRAWAL';
  net: string;
  currency: string;
  externalTraceId: string | null;
  summary: Record<string, string>;
}

export interface NormBalanceTransaction {
  shopifyId: string;
  type: string;
  test: boolean;
  transactionDate: string;
  amount: string;
  fee: string;
  net: string;
  currency: string;
  sourceType: string | null;
  sourceId: string | null;
  sourceOrderTransactionId: string | null;
  adjustmentReason: string | null;
  orderName: string | null;
  payoutShopifyId: string | null;
  payoutStatus: string | null;
}

export interface NormDispute {
  shopifyId: string;
  amount: string;
  currency: string;
  status: string;
  type: string;
  initiatedAt: string;
  finalizedOn: string | null;
  orderShopifyId: string | null;
}
