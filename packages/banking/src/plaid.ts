import Decimal from 'decimal.js';
import { ProviderError, type BankingProvider, type ProviderAccount, type ProviderTxn, type SyncPage } from './provider';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Plaid adapter. Endpoints/fields are checked against Plaid's published OpenAPI spec by scripts/validate-plaid.mjs (see PLAID_USAGE).
 * Not exercised against Plaid itself in this repository: tests use an in-process fake of the documented HTTP shapes.
 *
 * Plaid's sign convention: "Positive values when money moves out of the account; negative values when money moves in." We flip it.
 * For credit-card accounts Plaid reports `balances.current` as the amount OWED (positive); our books show it negative.
 */
export interface PlaidOptions {
  clientId: string;
  secret: string;
  env: 'sandbox' | 'production';
  fetch?: typeof fetch;
  redirectUri?: string;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const PLAID_USAGE = {
  '/link/token/create': { request: ['client_name', 'language', 'country_codes', 'user', 'products', 'redirect_uri'], response: ['link_token', 'expiration'] },
  '/item/public_token/exchange': { request: ['public_token'], response: ['access_token', 'item_id'] },
  '/accounts/get': { request: ['access_token'], response: ['accounts'] },
  '/transactions/sync': { request: ['access_token', 'cursor', 'count'], response: ['accounts', 'added', 'modified', 'removed', 'next_cursor', 'has_more'] },
  '/item/remove': { request: ['access_token'], response: [] },
} as const;
export const PLAID_SCHEMA_FIELDS = {
  Transaction: ['transaction_id', 'account_id', 'amount', 'iso_currency_code', 'date', 'name', 'merchant_name', 'pending'],
  AccountBase: ['account_id', 'balances', 'mask', 'name', 'official_name', 'type', 'subtype'],
  AccountBalance: ['current', 'iso_currency_code'],
  RemovedTransaction: ['transaction_id', 'account_id'],
} as const;

const subtypeKind = (type: string, subtype: string | null): ProviderAccount['kind'] =>
  type === 'credit' ? 'CREDIT_CARD' : type === 'depository' ? (subtype === 'savings' || subtype === 'money market' || subtype === 'cd' ? 'SAVINGS' : 'CHEQUING') : 'OTHER';

export class PlaidProvider implements BankingProvider {
  readonly id = 'plaid';
  private f: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  constructor(private o: PlaidOptions) {
    this.f = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = `https://${this.o.env}.plaid.com${path}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.f(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'PLAID-CLIENT-ID': this.o.clientId, 'PLAID-SECRET': this.o.secret }, body: JSON.stringify(body) });
      } catch (e) {
        if (attempt < (this.o.maxRetries ?? 3)) { await this.sleep(500 * 2 ** attempt); continue; }
        throw new ProviderError(`Network error talking to Plaid: ${(e as Error).message}`, 'NETWORK', true);
      }
      const json = (await res.json().catch(() => ({}))) as any;
      if (res.ok) return json as T;
      const code = String(json.error_code ?? res.status);
      const relink = code === 'ITEM_LOGIN_REQUIRED' || code === 'PENDING_EXPIRATION' || code === 'ITEM_NOT_FOUND';
      const retryable = res.status === 429 || res.status >= 500 || code === 'PRODUCT_NOT_READY';
      if (retryable && attempt < (this.o.maxRetries ?? 3)) { await this.sleep(Math.min(500 * 2 ** attempt, 8000)); continue; }
      throw new ProviderError(`${json.error_message ?? json.display_message ?? 'Plaid error'} (${code})`, code, retryable, relink);
    }
  }

  async createLinkToken(p: { clientUserId: string; clientName: string }) {
    const r = await this.call<any>('/link/token/create', {
      client_name: p.clientName.slice(0, 30), language: 'en', country_codes: ['CA'], user: { client_user_id: p.clientUserId }, products: ['transactions'],
      ...(this.o.redirectUri ? { redirect_uri: this.o.redirectUri } : {}),
    });
    return { linkToken: r.link_token as string, expiration: r.expiration as string };
  }

  async exchangePublicToken(publicToken: string) {
    const r = await this.call<any>('/item/public_token/exchange', { public_token: publicToken });
    return { accessToken: r.access_token as string, itemId: r.item_id as string };
  }

  private mapAccount(a: any): ProviderAccount {
    const kind = subtypeKind(a.type, a.subtype ?? null);
    const cur = a.balances?.current;
    let bal: string | null = cur === null || cur === undefined ? null : new Decimal(cur).toFixed(2);
    if (bal !== null && kind === 'CREDIT_CARD') bal = new Decimal(bal).neg().toFixed(2);
    return { providerAccountId: a.account_id, name: a.name, officialName: a.official_name ?? null, mask: a.mask ?? null, kind, currency: a.balances?.iso_currency_code ?? null, currentBalance: bal };
  }

  async listAccounts(accessToken: string) {
    const r = await this.call<any>('/accounts/get', { access_token: accessToken });
    return (r.accounts as any[]).map((a) => this.mapAccount(a));
  }

  private mapTxn(t: any): ProviderTxn {
    return {
      providerTxnId: t.transaction_id, providerAccountId: t.account_id, date: t.date,
      description: String(t.merchant_name ? `${t.merchant_name} ${t.name !== t.merchant_name ? `· ${t.name}` : ''}` : t.name).replace(/\s+/g, ' ').trim(),
      amount: new Decimal(t.amount).neg().toFixed(2), currency: t.iso_currency_code ?? null, pending: Boolean(t.pending),
    };
  }

  /** One page. The caller loops while `hasMore` and persists `nextCursor` only after saving the page. */
  async syncTransactions(accessToken: string, cursor: string | null): Promise<SyncPage> {
    const r = await this.call<any>('/transactions/sync', { access_token: accessToken, count: 500, ...(cursor ? { cursor } : {}) });
    return {
      accounts: (r.accounts as any[]).map((a) => this.mapAccount(a)),
      added: (r.added as any[]).map((t) => this.mapTxn(t)),
      modified: (r.modified as any[]).map((t) => this.mapTxn(t)),
      removed: (r.removed as any[]).map((t) => ({ providerTxnId: t.transaction_id, providerAccountId: t.account_id })),
      nextCursor: r.next_cursor as string,
      hasMore: Boolean(r.has_more),
    };
  }

  async removeItem(accessToken: string) {
    await this.call('/item/remove', { access_token: accessToken });
  }
}
