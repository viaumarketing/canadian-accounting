import PDFDocument from 'pdfkit';
import { pdfSafe } from './pdf';

/** A customer-facing sales document (invoice, credit note, sales receipt), ready to print or send. */
export interface SalesDocument {
  title: 'INVOICE' | 'CREDIT NOTE' | 'SALES RECEIPT';
  currency: string;
  /** DRAFT or VOID prints a large watermark */
  watermark?: 'DRAFT' | 'VOID';
  company: { name: string; legalName?: string; address?: string | null; phone?: string | null; email?: string | null; registrations: string[] };
  number: string;
  /** Right-hand details box, e.g. [['Date', '2026-11-01'], ['Due date', '2026-12-01'], ['Terms', 'Net 30']] */
  details: [string, string][];
  billTo: { name: string; address?: string | null; email?: string | null };
  lines: { serviceDate?: string | null; product?: string | null; description: string; quantity: string; rate: string; amount: string; taxCode?: string | null }[];
  subtotal: string;
  taxes: { label: string; amount: string }[];
  total: string;
  /** Invoices: amount paid so far and what is still owed */
  paid?: string;
  balanceDue?: string;
  message?: string | null;
}

const M = 50; // margin
const INK = '#1f2937';
const MUTED = '#6b7280';
const RULE = '#d1d5db';
const ACCENT = '#2f8a2b';
const BAND = '#f3f4f6';

export function documentPdf(d: SalesDocument, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margin: M, bufferPages: true, compress: opts.compress ?? true, info: { Title: `${d.title} ${d.number}`, Author: d.company.name, Creator: 'Canadian Accounting' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  const s = (t: string | null | undefined) => pdfSafe(t ?? '');
  const money = (v: string) => s(new Intl.NumberFormat('en-CA', { style: 'currency', currency: d.currency }).format(Number(v)));
  const W = doc.page.width - 2 * M;
  const right = doc.page.width - M;

  // ---- header: seller on the left, document title on the right
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(s(d.company.name), M, M, { width: W * 0.6 });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  if (d.company.legalName && d.company.legalName !== d.company.name) doc.text(s(d.company.legalName), { width: W * 0.6 });
  for (const l of (d.company.address ?? '').split('\n').filter(Boolean)) doc.text(s(l), { width: W * 0.6 });
  if (d.company.phone) doc.text(s(d.company.phone));
  if (d.company.email) doc.text(s(d.company.email));
  for (const r of d.company.registrations) doc.text(s(r));
  const leftBottom = doc.y;
  doc.font('Helvetica-Bold').fontSize(22).fillColor(ACCENT).text(d.title, M, M, { width: W, align: 'right' });

  // ---- details box (number, dates, terms)
  let y = M + 34;
  const labelX = right - 230;
  doc.fontSize(9);
  for (const [k, v] of [[d.title === 'SALES RECEIPT' ? 'Receipt no.' : d.title === 'CREDIT NOTE' ? 'Credit note no.' : 'Invoice no.', d.number], ...d.details] as [string, string][]) {
    doc.font('Helvetica-Bold').fillColor(MUTED).text(s(k).toUpperCase(), labelX, y, { width: 110, align: 'right' });
    doc.font('Helvetica').fillColor(INK).text(s(v), labelX + 120, y, { width: 110, align: 'right' });
    y += 14;
  }

  // ---- bill to
  y = Math.max(leftBottom, y) + 18;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text(d.title === 'SALES RECEIPT' ? 'SOLD TO' : 'BILL TO', M, y);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(s(d.billTo.name), M, y + 13);
  doc.font('Helvetica').fontSize(9);
  for (const l of (d.billTo.address ?? '').split('\n').filter(Boolean)) doc.text(s(l));
  if (d.billTo.email) doc.fillColor(MUTED).text(s(d.billTo.email)).fillColor(INK);
  y = doc.y + 18;

  // ---- lines table
  const hasDate = d.lines.some((l) => l.serviceDate);
  const hasProduct = d.lines.some((l) => l.product);
  const cols: { key: 'serviceDate' | 'product' | 'description' | 'quantity' | 'rate' | 'amount' | 'taxCode'; label: string; w: number; align: 'left' | 'right' }[] = [
    ...(hasDate ? [{ key: 'serviceDate' as const, label: 'DATE', w: 62, align: 'left' as const }] : []),
    ...(hasProduct ? [{ key: 'product' as const, label: 'PRODUCT/SERVICE', w: 100, align: 'left' as const }] : []),
    { key: 'description', label: 'DESCRIPTION', w: 0, align: 'left' },
    { key: 'quantity', label: 'QTY', w: 40, align: 'right' },
    { key: 'rate', label: 'RATE', w: 66, align: 'right' },
    { key: 'amount', label: 'AMOUNT', w: 76, align: 'right' },
    { key: 'taxCode', label: 'TAX', w: 52, align: 'left' },
  ];
  const fixed = cols.reduce((a, c) => a + c.w, 0);
  cols.find((c) => c.key === 'description')!.w = W - fixed - 6 * (cols.length - 1);
  const drawHeader = () => {
    doc.rect(M, y, W, 18).fill(BAND);
    let x = M + 4;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
    for (const c of cols) { doc.text(c.label, x, y + 5, { width: c.w - 4, align: c.align }); x += c.w + 6; }
    y += 24;
  };
  drawHeader();
  doc.font('Helvetica').fontSize(9).fillColor(INK);
  for (const l of d.lines) {
    const cell = (k: (typeof cols)[number]['key']) => (k === 'rate' ? money(l.rate) : k === 'amount' ? money(l.amount) : k === 'quantity' ? s(String(Number(l.quantity))) : s((l[k] as string | null | undefined) ?? ''));
    const h = Math.max(...cols.map((c) => doc.heightOfString(cell(c.key), { width: c.w - 4 }))) + 6;
    if (y + h > doc.page.height - M - 140) { doc.addPage(); y = M; drawHeader(); doc.font('Helvetica').fontSize(9).fillColor(INK); }
    let x = M + 4;
    for (const c of cols) { doc.text(cell(c.key), x, y, { width: c.w - 4, align: c.align }); x += c.w + 6; }
    y += h;
    doc.moveTo(M, y - 3).lineTo(right, y - 3).lineWidth(0.5).strokeColor(RULE).stroke();
  }

  // ---- totals
  y += 8;
  const tot = (label: string, value: string, o: { bold?: boolean; big?: boolean } = {}) => {
    doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.big ? 12 : 9).fillColor(INK);
    doc.text(s(label), right - 260, y, { width: 160, align: 'right' });
    doc.text(value, right - 95, y, { width: 95, align: 'right' });
    y += o.big ? 20 : 15;
  };
  tot('Subtotal', money(d.subtotal));
  for (const t of d.taxes) tot(t.label, money(t.amount));
  doc.moveTo(right - 260, y - 2).lineTo(right, y - 2).lineWidth(0.5).strokeColor(RULE).stroke();
  y += 4;
  tot('Total', money(d.total), { bold: true });
  if (d.paid !== undefined) tot(d.title === 'SALES RECEIPT' ? 'Amount received' : 'Payments', money(d.paid));
  if (d.balanceDue !== undefined) tot('Balance due', money(d.balanceDue), { bold: true, big: true });

  // ---- message
  if (d.message) {
    y += 10;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('MESSAGE', M, y);
    doc.font('Helvetica').fontSize(9).fillColor(INK).text(s(d.message), M, y + 13, { width: W * 0.6 });
  }

  // ---- watermark and page numbers
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(pages.start + i);
    if (d.watermark) {
      doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] }).font('Helvetica-Bold').fontSize(110).fillColor(d.watermark === 'VOID' ? '#dc2626' : '#9ca3af').opacity(0.15)
        .text(d.watermark, 0, doc.page.height / 2 - 60, { width: doc.page.width, align: 'center' }).restore().opacity(1);
    }
    if (pages.count > 1) doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`Page ${i + 1} of ${pages.count}`, M, doc.page.height - M + 10, { width: W, align: 'right', lineBreak: false });
  }
  doc.end();
  return done;
}
