import ExcelJS from 'exceljs';
import { isNumeric, type Report } from './model';

const MONEY = '#,##0.00;[Red]-#,##0.00';

/** One worksheet; sections stacked. Money/percent/int cells are real numbers with number formats, not text. */
export async function toXlsx(r: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Canadian Accounting';
  wb.created = new Date(r.generatedAt);
  const ws = wb.addWorksheet(r.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '), { views: [{ state: 'frozen', ySplit: 0 }] });
  const widths: number[] = [];
  const track = (i: number, len: number) => { widths[i] = Math.max(widths[i] ?? 10, Math.min(60, len + 2)); };
  const push = (vals: (string | number | null)[], o: { bold?: boolean; size?: number } = {}) => {
    const rw = ws.addRow(vals);
    if (o.bold) rw.font = { bold: true, size: o.size };
    return rw;
  };
  push([r.title], { bold: true, size: 14 });
  if (r.subtitle) push([r.subtitle]);
  push([r.company]);
  for (const s of r.sections) {
    ws.addRow([]);
    if (s.title) push([s.title], { bold: true, size: 12 });
    const hdr = push(s.columns.map((c) => c.label), { bold: true });
    hdr.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8ECF0' } }; c.border = { bottom: { style: 'thin' } }; });
    s.columns.forEach((c, i) => { track(i, c.label.length); if (c.kind !== 'text' && c.kind !== 'date') hdr.getCell(i + 1).alignment = { horizontal: 'right' }; });
    for (const row of [...s.rows, ...(s.totals ?? [])]) {
      const vals = s.columns.map((c, i) => {
        const v = row.cells[c.key] ?? null;
        if (v !== null && (c.kind === 'money' || c.kind === 'pct' || c.kind === 'int') && isNumeric(v)) return Number(v);
        const t = v === null ? null : String(v);
        if (t) track(i, t.length + (i === 0 ? (row.level ?? 0) * 2 : 0));
        return i === 0 && row.level ? `${' '.repeat(row.level * 2)}${t ?? ''}` : t;
      });
      const rw = ws.addRow(vals);
      if (row.bold || (s.totals ?? []).includes(row)) rw.font = { bold: true };
      s.columns.forEach((c, i) => {
        const cl = rw.getCell(i + 1);
        if (c.kind === 'money') cl.numFmt = MONEY;
        else if (c.kind === 'pct') { cl.numFmt = '0.0"%"'; }
        else if (c.kind === 'int') cl.numFmt = '#,##0';
      });
    }
  }
  if (r.checks.length) {
    ws.addRow([]);
    push(['Checks'], { bold: true, size: 12 });
    for (const c of r.checks) push([c.label, c.ok ? 'OK' : 'FAILED', c.detail ?? '']);
  }
  for (const n of r.notes) { ws.addRow([]); push([`Note: ${n}`]); }
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
