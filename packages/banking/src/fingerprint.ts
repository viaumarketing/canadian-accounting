import { createHash } from 'node:crypto';
import type { NormBankTxn } from './types';

export const normaliseDescription = (s: string) => s.toUpperCase().replace(/\s+/g, ' ').trim();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Stable identity of a bank transaction within one account.
 *  - With a bank-supplied id (OFX FITID, Plaid transaction_id): that id.
 *  - Otherwise date|amount|description plus an occurrence counter, so two genuinely identical purchases on the same day
 *    are two transactions, while re-importing an overlapping statement maps each occurrence onto the one already stored.
 */
export function fingerprints(rows: NormBankTxn[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    if (r.externalId) return sha(`id|${r.externalId}`);
    const base = `${r.date}|${r.amount}|${normaliseDescription(r.description)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return sha(`${base}|${n}`);
  });
}

export const sha256Hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
