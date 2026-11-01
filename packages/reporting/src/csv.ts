import { isNumeric, type Cell, type Column, type Report } from './model';

/** Neutralise spreadsheet formula injection: text that starts with = + - @ TAB or CR is prefixed with an apostrophe. */
export function safeText(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

function cell(c: Column, v: Cell): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if ((c.kind === 'money' || c.kind === 'pct' || c.kind === 'int') && isNumeric(v)) s = String(v); // genuine numbers stay numbers
  else s = safeText(String(v));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 with BOM so Excel shows accented French names correctly. Sections are stacked, separated by a blank line. */
export function toCsv(r: Report): string {
  const out: string[] = [];
  const line = (cells: string[]) => out.push(cells.join(','));
  line([cell({ key: 't', label: '', kind: 'text' }, r.title)]);
  if (r.subtitle) line([cell({ key: 't', label: '', kind: 'text' }, r.subtitle)]);
  line([cell({ key: 't', label: '', kind: 'text' }, r.company)]);
  for (const s of r.sections) {
    out.push('');
    if (s.title) line([cell({ key: 't', label: '', kind: 'text' }, s.title)]);
    line(s.columns.map((c) => cell({ ...c, kind: 'text' }, c.label)));
    for (const row of [...s.rows, ...(s.totals ?? [])]) line(s.columns.map((c) => cell(c, row.cells[c.key] ?? null)));
  }
  if (r.checks.length) {
    out.push('');
    line(['Checks']);
    for (const c of r.checks) line([cell({ key: 't', label: '', kind: 'text' }, c.label), c.ok ? 'OK' : 'FAILED', cell({ key: 't', label: '', kind: 'text' }, c.detail ?? '')]);
  }
  for (const n of r.notes) { out.push(''); line([cell({ key: 't', label: '', kind: 'text' }, `Note: ${n}`)]); }
  return `\uFEFF${out.join('\r\n')}\r\n`;
}
