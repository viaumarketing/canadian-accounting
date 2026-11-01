/** A bank transaction as parsed from a file or provider. `amount` is signed from the account holder's view: + money in, − money out. */
export interface NormBankTxn {
  date: string; // YYYY-MM-DD
  description: string;
  amount: string; // decimal string, never 0
  externalId?: string;
  balance?: string;
}

export interface ParseResult {
  rows: NormBankTxn[];
  errors: { line: number; message: string }[];
}

export interface StatementMeta {
  format: 'csv' | 'ofx';
  periodStart?: string;
  periodEnd?: string;
  endingBalance?: string; // as stated by the file, in OUR signed convention (credit-card balances are negative when owed)
  accountMask?: string;
  accountKind?: 'CHEQUING' | 'SAVINGS' | 'CREDIT_CARD';
  currency?: string;
}
