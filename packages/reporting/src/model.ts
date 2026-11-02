/** One report model, three renderers. Money is always a decimal STRING (never a float) until a renderer formats it. */
export type ColKind = 'text' | 'money' | 'pct' | 'date' | 'int';
export type Cell = string | number | null;

export interface Column { key: string; label: string; kind: ColKind }
export interface Row {
  cells: Record<string, Cell>;
  /** indentation depth for hierarchical statements */
  level?: number;
  bold?: boolean;
}
export interface Section { title?: string; columns: Column[]; rows: Row[]; totals?: Row[] }
/** A tie-out to the ledger. Failures are shown to the reader, never hidden. */
export interface Check { label: string; ok: boolean; detail?: string }

export interface Report {
  key: string;
  title: string;
  subtitle?: string;
  company: string;
  generatedAt: string;
  sections: Section[];
  checks: Check[];
  notes: string[];
  /** On-screen pages of a long report (exports are always complete and ignore this). */
  paging?: { page: number; pages: number; pageSize: number; total: number };
}

export const col = (key: string, label: string, kind: ColKind = 'text'): Column => ({ key, label, kind });
export const row = (cells: Record<string, Cell>, o: { level?: number; bold?: boolean } = {}): Row => ({ cells, ...o });

const NUM = /^-?\d+(\.\d+)?$/;
export const isNumeric = (v: Cell): v is string | number => v !== null && NUM.test(String(v));

/** Round half-up to cents using integer arithmetic on the decimal string (no floats). */
export function fmtMoney(v: Cell): string {
  if (v === null || v === '') return '';
  if (!isNumeric(v)) return String(v);
  const str = String(v);
  const neg = str.startsWith('-');
  const [i, f = ''] = str.replace('-', '').split('.');
  let cents = BigInt(i + (f + '00').slice(0, 2));
  if (f.length > 2 && f[2] >= '5') cents += 1n;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (cents % 100n).toString().padStart(2, '0');
  return `${neg && cents !== 0n ? '-' : ''}${whole}.${frac}`;
}

export function fmtCell(c: Column, v: Cell): string {
  if (v === null || v === undefined || v === '') return '';
  if (c.kind === 'money') return fmtMoney(v);
  if (c.kind === 'pct') return isNumeric(v) ? `${Number(v).toFixed(1)}%` : String(v);
  return String(v);
}
