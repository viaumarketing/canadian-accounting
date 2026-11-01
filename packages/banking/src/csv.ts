import Decimal from 'decimal.js';
import type { NormBankTxn, ParseResult } from './types';

export const MAX_ROWS = 50_000;

/** RFC 4180-style parser: quoted fields, escaped quotes, CRLF/LF, embedded newlines, BOM. Delimiter is auto-detected. */
export function parseCsv(text: string, delimiter?: string): { rows: string[][]; delimiter: string } {
  const src = text.replace(/^\uFEFF/, '');
  const d = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"' && field === '') q = true;
    else if (c === d) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS + 1) throw new Error(`File has more than ${MAX_ROWS} rows`);
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return { rows, delimiter: d };
}

function detectDelimiter(s: string): string {
  const first = s.split(/\r?\n/).slice(0, 5).join('\n');
  const score = (d: string) => (first.match(new RegExp(d === '\t' ? '\t' : `\\${d}`, 'g')) ?? []).length;
  return [',', ';', '\t', '|'].map((d) => [d, score(d)] as const).sort((a, b) => b[1] - a[1])[0][0];
}

export type DateFormat = 'YMD' | 'MDY' | 'DMY' | 'YYYYMMDD' | 'auto';

export interface CsvMapping {
  hasHeader: boolean;
  dateColumn: number;
  dateFormat: DateFormat;
  descriptionColumns: number[];
  amount: { mode: 'single'; column: number; invert?: boolean } | { mode: 'split'; debitColumn: number; creditColumn: number };
  balanceColumn?: number;
  externalIdColumn?: number;
  /** Amounts like "1.234,56" (common in French-Canadian exports). */
  decimalComma?: boolean;
  delimiter?: string;
}

const realDate = (y: number, m: number, d: number): string | null => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (y < 1990 || y > 2100 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
};

export function parseDate(raw: string, fmt: DateFormat): string | { error: string } {
  const s = raw.trim();
  if (fmt === 'YYYYMMDD' || (fmt === 'auto' && /^\d{8}$/.test(s))) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    const r = m && realDate(+m[1], +m[2], +m[3]);
    return r || { error: `Invalid date "${raw}"` };
  }
  const parts = /^(\d{1,4})[-/. ](\d{1,2})[-/. ](\d{1,4})/.exec(s);
  if (!parts) return { error: `Unrecognised date "${raw}"` };
  const [a, b, c] = [+parts[1], +parts[2], +parts[3]];
  let f = fmt;
  if (f === 'auto') {
    if (parts[1].length === 4) f = 'YMD';
    else return { error: `Ambiguous date "${raw}": choose MDY or DMY` };
  }
  const r = f === 'YMD' ? realDate(a, b, c) : f === 'MDY' ? realDate(c, a, b) : realDate(c, b, a);
  return r || { error: `Invalid date "${raw}"` };
}

/** "$1,234.56", "(12.50)", "12.50-", "-12,50" (decimalComma) → Decimal. Returns null for blank. Throws on junk. */
export function parseAmount(raw: string, decimalComma = false): Decimal | null {
  let s = raw.trim();
  if (s === '') return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
  s = s.replace(/[\s$€£]|CAD|USD/gi, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  s = decimalComma ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) throw new Error(`Not a number: "${raw}"`);
  const v = new Decimal(s);
  return neg ? v.neg() : v;
}

/** Best-effort guess at a mapping from headers; the user always confirms it in the preview. */
export function suggestMapping(header: string[]): Partial<CsvMapping> & { confident: boolean } {
  const h = header.map((x) => x.trim().toLowerCase());
  const find = (...re: RegExp[]) => h.findIndex((x) => re.some((r) => r.test(x)));
  const date = find(/^(transaction |posting |posted |trans\.? )?date$/, /\bdate\b/);
  const desc = [find(/^description( 1)?$/, /^details$/, /^memo$/, /^payee$/, /^name$/, /description/)].filter((i) => i >= 0);
  const debit = find(/^debit$/, /withdrawal/, /money out/, /\bdebit\b/);
  const credit = find(/^credit$/, /deposit/, /money in/, /\bcredit\b/);
  const amount = find(/^amount$/, /^cad\$?$/, /\bamount\b/);
  const balance = find(/balance/);
  const out: Partial<CsvMapping> & { confident: boolean } = { hasHeader: true, dateColumn: date, descriptionColumns: desc, dateFormat: 'auto', confident: false };
  if (debit >= 0 && credit >= 0) out.amount = { mode: 'split', debitColumn: debit, creditColumn: credit };
  else if (amount >= 0) out.amount = { mode: 'single', column: amount };
  if (balance >= 0) out.balanceColumn = balance;
  out.confident = date >= 0 && desc.length > 0 && Boolean(out.amount);
  return out;
}

export function applyMapping(rows: string[][], m: CsvMapping): ParseResult {
  const out: NormBankTxn[] = [];
  const errors: ParseResult['errors'] = [];
  const start = m.hasHeader ? 1 : 0;
  const cell = (r: string[], i?: number) => (i === undefined || i < 0 ? '' : (r[i] ?? '').trim());
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 1;
    try {
      const dateRaw = cell(r, m.dateColumn);
      if (!dateRaw) throw new Error('Missing date');
      const date = parseDate(dateRaw, m.dateFormat);
      if (typeof date !== 'string') throw new Error(date.error);
      let amount: Decimal | null;
      if (m.amount.mode === 'single') {
        amount = parseAmount(cell(r, m.amount.column), m.decimalComma);
        if (amount && m.amount.invert) amount = amount.neg();
      } else {
        const debit = parseAmount(cell(r, m.amount.debitColumn), m.decimalComma);
        const credit = parseAmount(cell(r, m.amount.creditColumn), m.decimalComma);
        if (debit && credit && !debit.isZero() && !credit.isZero()) throw new Error('Both debit and credit have an amount');
        amount = (credit && !credit.isZero() ? credit.abs() : debit && !debit.isZero() ? debit.abs().neg() : null);
      }
      if (!amount || amount.isZero()) throw new Error('No amount');
      const description = m.descriptionColumns.map((c) => cell(r, c)).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (!description) throw new Error('Missing description');
      const bal = m.balanceColumn !== undefined ? parseAmount(cell(r, m.balanceColumn), m.decimalComma) : null;
      const ext = cell(r, m.externalIdColumn);
      out.push({ date, description, amount: amount.toFixed(2), ...(ext ? { externalId: ext } : {}), ...(bal ? { balance: bal.toFixed(2) } : {}) });
    } catch (e) {
      errors.push({ line, message: (e as Error).message });
    }
  }
  return { rows: out, errors };
}
