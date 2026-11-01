/** Provider-neutral banking aggregation interface. Implement it for Plaid, Flinks, etc.; the rest of the system never sees provider types. */
export interface ProviderAccount {
  providerAccountId: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  kind: 'CHEQUING' | 'SAVINGS' | 'CREDIT_CARD' | 'OTHER';
  currency: string | null;
  /** Signed like our books: money in positive; a credit card that owes $50 is "-50.00". */
  currentBalance: string | null;
}

export interface ProviderTxn {
  providerTxnId: string;
  providerAccountId: string;
  date: string;
  description: string;
  /** Signed from the account holder's view: + money in, − money out. Providers' own sign conventions are converted by the adapter. */
  amount: string;
  currency: string | null;
  pending: boolean;
}

export interface SyncPage {
  accounts: ProviderAccount[];
  added: ProviderTxn[];
  modified: ProviderTxn[];
  removed: { providerTxnId: string; providerAccountId: string }[];
  nextCursor: string;
  hasMore: boolean;
}

export class ProviderError extends Error {
  constructor(message: string, public code: string, public retryable: boolean, public requiresRelink = false) { super(message); }
}

export interface BankingProvider {
  readonly id: string;
  createLinkToken(p: { clientUserId: string; clientName: string }): Promise<{ linkToken: string; expiration: string }>;
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  listAccounts(accessToken: string): Promise<ProviderAccount[]>;
  syncTransactions(accessToken: string, cursor: string | null): Promise<SyncPage>;
  removeItem(accessToken: string): Promise<void>;
}
