import PDFDocument from 'pdfkit';
import { fmtCell, type Column, type Report, type Row } from './model';

const MARGIN = 40;

/** The built-in PDF fonts are Latin-1 only. Map the few typographic symbols our reports use to ASCII, so nothing renders as a stray glyph. */
const MAP: Record<string, string> = { '\u2212': '-', '\u2013': '-', '\u2014': '-', '\u2192': '->', '\u2190': '<-', '\u2265': '>=', '\u2264': '<=', '\u2260': '!=', '\u03a3': 'Sum', '\u2713': 'OK', '\u2717': 'X', '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"', '\u2026': '...', '\u00a0': ' ', '\u202f': ' ' };
export const pdfSafe = (s: string) => s.replace(/[\u0100-\uffff]/g, (c) => MAP[c] ?? '?').replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');
const FONT = 'Helvetica';
const BOLD = 'Helvetica-Bold';

/** A4 PDF. Landscape when a table has more than 6 columns. Standard Helvetica (Latin-1: French accents render). */
export function toPdf(r: Report, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const wide = r.sections.some((s) => s.columns.length > 6);
  const doc = new PDFDocument({ size: 'A4', layout: wide ? 'landscape' : 'portrait', margin: MARGIN, bufferPages: true, compress: opts.compress ?? true, info: { Title: r.title, Author: 'Canadian Accounting', Creator: 'Canadian Accounting' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res, rej) => { doc.on('end', () => res(Buffer.concat(chunks))); doc.on('error', rej); });

  const W = () => doc.page.width - MARGIN * 2;
  const bottom = () => doc.page.height - MARGIN - 20;

  doc.font(BOLD).fontSize(16).text(pdfSafe(r.title), MARGIN, MARGIN);
  doc.font(FONT).fontSize(10).fillColor('#444');
  if (r.subtitle) doc.text(pdfSafe(r.subtitle));
  doc.text(pdfSafe(r.company)).fillColor('#000').moveDown(0.8);

  /** Column widths follow content: short columns (line numbers, dates, amounts) stay narrow, text columns take the rest. */
  const widths = (cols: Column[], rows: Row[]) => {
    const want = cols.map((c) => {
      const longest = Math.max(c.label.length, ...rows.slice(0, 200).map((r) => fmtCell(c, r.cells[c.key] ?? null).length));
      return c.kind === 'text' ? Math.min(Math.max(longest, 10), 48) : Math.min(Math.max(longest, 9), 16);
    });
    const total = want.reduce((a, b) => a + b, 0);
    return want.map((x) => (x / total) * W());
  };

  const drawRow = (cols: Column[], w: number[], row: Row, bold: boolean, shade: boolean) => {
    const y0 = doc.y;
    doc.font(bold ? BOLD : FONT).fontSize(8.5);
    const heights = cols.map((c, i) => {
      const text = pdfSafe(i === 0 && row.level ? `${'   '.repeat(row.level)}${fmtCell(c, row.cells[c.key] ?? null)}` : fmtCell(c, row.cells[c.key] ?? null));
      return { text, h: doc.heightOfString(text, { width: w[i] - 8 }) };
    });
    const h = Math.max(...heights.map((x) => x.h), 10) + 4;
    if (y0 + h > bottom()) { doc.addPage(); drawHead(cols, w); }
    const y = doc.y;
    if (shade) doc.save().rect(MARGIN, y - 1, W(), h).fill('#EEF1F4').restore();
    let x = MARGIN;
    cols.forEach((c, i) => {
      doc.font(bold ? BOLD : FONT).fontSize(8.5).fillColor('#000').text(heights[i].text, x + 4, y + 1, { width: w[i] - 8, align: c.kind === 'text' || c.kind === 'date' ? 'left' : 'right' });
      x += w[i];
    });
    doc.y = y + h;
  };
  const drawHead = (cols: Column[], w: number[]) => {
    const y = doc.y;
    doc.save().rect(MARGIN, y, W(), 16).fill('#DDE3EA').restore();
    let x = MARGIN;
    cols.forEach((c, i) => { doc.font(BOLD).fontSize(8.5).fillColor('#000').text(pdfSafe(c.label), x + 4, y + 4, { width: w[i] - 8, align: c.kind === 'text' || c.kind === 'date' ? 'left' : 'right' }); x += w[i]; });
    doc.y = y + 18;
  };

  for (const s of r.sections) {
    if (doc.y > bottom() - 60) doc.addPage();
    if (s.title) doc.font(BOLD).fontSize(11).fillColor('#000').text(pdfSafe(s.title), MARGIN, doc.y + 4).moveDown(0.3);
    const sig = s.columns.map((c) => c.key).join('|');
    const w = widths(s.columns, r.sections.filter((x) => x.columns.map((c) => c.key).join('|') === sig).flatMap((x) => [...x.rows, ...(x.totals ?? [])])); // same columns => same widths across sections
    drawHead(s.columns, w);
    s.rows.forEach((row, i) => drawRow(s.columns, w, row, Boolean(row.bold), i % 2 === 1));
    for (const t of s.totals ?? []) drawRow(s.columns, w, t, true, false);
    doc.moveDown(0.8);
  }
  if (r.checks.length) {
    if (doc.y > bottom() - 40) doc.addPage();
    doc.font(BOLD).fontSize(10).text('Checks', MARGIN, doc.y);
    for (const c of r.checks) doc.font(FONT).fontSize(8.5).fillColor(c.ok ? '#0a6b3d' : '#b00020').text(pdfSafe(`${c.ok ? '[OK]' : '[FAILED]'} ${c.label}${c.detail ? ` - ${c.detail}` : ''}`), { width: W() }).fillColor('#000');
  }
  for (const n of r.notes) doc.moveDown(0.4).font(FONT).fontSize(8).fillColor('#444').text(pdfSafe(n), { width: W() }).fillColor('#000');

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.font(FONT).fontSize(7.5).fillColor('#666').text(pdfSafe(`${r.company} · ${r.title} · generated ${r.generatedAt.slice(0, 16).replace('T', ' ')} UTC · page ${i + 1} of ${range.count}`), MARGIN, doc.page.height - MARGIN + 8, { width: W(), align: 'center', lineBreak: false });
  }
  doc.end();
  return done;
}
