import PDFDocument from 'pdfkit';
import { pdfSafe } from './pdf';

/** How the company's documents look (Settings → Branding). Every field is optional; the defaults are the 0.9.2 look. */
export interface DocumentStyle {
  accent?: string;
  layout?: 'modern' | 'classic' | 'compact';
  showLogo?: boolean;
  showServiceDate?: boolean;
  showTaxColumn?: boolean;
  footer?: string | null;
}

export interface DocumentCompany { name: string; legalName?: string; address?: string | null; phone?: string | null; email?: string | null; registrations: string[] }

/** A customer- or supplier-facing document (invoice, credit note, sales receipt, estimate, purchase order), ready to print or send. */
export interface SalesDocument {
  title: 'INVOICE' | 'CREDIT NOTE' | 'SALES RECEIPT' | 'ESTIMATE' | 'PURCHASE ORDER';
  currency: string;
  /** DRAFT or VOID prints a large watermark */
  watermark?: 'DRAFT' | 'VOID';
  company: DocumentCompany;
  /** PNG or JPEG bytes */
  logo?: Buffer | null;
  style?: DocumentStyle;
  number: string;
  /** Right-hand details box, e.g. [['Date', '2026-11-01'], ['Due date', '2026-12-01'], ['Terms', 'Net 30']] */
  details: [string, string][];
  billTo: { name: string; address?: string | null; email?: string | null };
  /** Second address block, e.g. SHIP TO on a purchase order */
  shipTo?: { label: string; text: string } | null;
  lines: { serviceDate?: string | null; product?: string | null; description: string; quantity: string; rate: string; amount: string; taxCode?: string | null }[];
  subtotal: string;
  taxes: { label: string; amount: string }[];
  total: string;
  /** Invoices: amount paid so far and what is still owed */
  paid?: string;
  balanceDue?: string;
  message?: string | null;
  paymentInstructions?: string | null;
  /** "Pay online" link printed under the totals */
  payUrl?: string | null;
}

const M = 50; // margin
const INK = '#1f2937';
const MUTED = '#6b7280';
const RULE = '#d1d5db';
const DEFAULT_ACCENT = '#2f8a2b';
const BAND = '#f3f4f6';

const NUMBER_LABEL: Record<SalesDocument['title'], string> = { INVOICE: 'Invoice no.', 'CREDIT NOTE': 'Credit note no.', 'SALES RECEIPT': 'Receipt no.', ESTIMATE: 'Estimate no.', 'PURCHASE ORDER': 'P.O. no.' };
const PARTY_LABEL: Record<SalesDocument['title'], string> = { INVOICE: 'BILL TO', 'CREDIT NOTE': 'BILL TO', 'SALES RECEIPT': 'SOLD TO', ESTIMATE: 'PREPARED FOR', 'PURCHASE ORDER': 'VENDOR' };

/** Fonts and sizes per layout. */
function look(style: DocumentStyle | undefined) {
  const layout = style?.layout ?? 'modern';
  const serif = layout === 'classic';
  const compact = layout === 'compact';
  return {
    layout,
    accent: /^#[0-9a-fA-F]{6}$/.test(style?.accent ?? '') ? style!.accent! : DEFAULT_ACCENT,
    regular: serif ? 'Times-Roman' : 'Helvetica',
    bold: serif ? 'Times-Bold' : 'Helvetica-Bold',
    body: compact ? 8 : 9,
    small: compact ? 7 : 8,
    title: compact ? 18 : 22,
    name: compact ? 14 : 16,
    pad: compact ? 4 : 6,
  };
}

function start(info: { title: string; author: string }, compress?: boolean) {
  const doc = new PDFDocument({ size: 'LETTER', margin: M, bufferPages: true, compress: compress ?? true, info: { Title: info.title, Author: info.author, Creator: 'Canadian Accounting' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res, rej) => { doc.on('end', () => res(Buffer.concat(chunks))); doc.on('error', rej); });
  return { doc, done };
}

const s = (t: string | null | undefined) => pdfSafe(t ?? '');

/** Seller block (logo, name, address, registrations) on the left and the document title on the right. Returns the y below it. */
function header(doc: PDFKit.PDFDocument, L: ReturnType<typeof look>, company: DocumentCompany, title: string, logo: Buffer | null | undefined, style: DocumentStyle | undefined) {
  const W = doc.page.width - 2 * M;
  let y = M;
  if (logo && style?.showLogo !== false) {
    try {
      doc.image(logo, M, y, { fit: [160, 56] });
      y += 62;
    } catch {
      /* unreadable image: print the document without it rather than fail */
    }
  }
  doc.fillColor(INK).font(L.bold).fontSize(L.name).text(s(company.name), M, y, { width: W * 0.6 });
  doc.font(L.regular).fontSize(L.body).fillColor(MUTED);
  if (company.legalName && company.legalName !== company.name) doc.text(s(company.legalName), { width: W * 0.6 });
  for (const l of (company.address ?? '').split('\n').filter(Boolean)) doc.text(s(l), { width: W * 0.6 });
  if (company.phone) doc.text(s(company.phone));
  if (company.email) doc.text(s(company.email));
  for (const r of company.registrations) doc.text(s(r));
  const leftBottom = doc.y;
  doc.font(L.bold).fontSize(L.title).fillColor(L.layout === 'classic' ? INK : L.accent).text(title, M, M, { width: W, align: 'right' });
  if (L.layout === 'classic') doc.moveTo(doc.page.width - M - 200, M + L.title + 4).lineTo(doc.page.width - M, M + L.title + 4).lineWidth(1).strokeColor(L.accent).stroke();
  return leftBottom;
}

/** Watermark, footer and page numbers on every page. */
function finish(doc: PDFKit.PDFDocument, L: ReturnType<typeof look>, watermark: 'DRAFT' | 'VOID' | undefined, footer: string | null | undefined) {
  const W = doc.page.width - 2 * M;
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(pages.start + i);
    if (watermark) {
      doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] }).font('Helvetica-Bold').fontSize(110).fillColor(watermark === 'VOID' ? '#dc2626' : '#9ca3af').opacity(0.15)
        .text(watermark, 0, doc.page.height / 2 - 60, { width: doc.page.width, align: 'center' }).restore().opacity(1);
    }
    // Writing below the bottom margin would add a page; lift the margin while drawing the footer.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    if (footer) doc.font(L.regular).fontSize(L.small).fillColor(MUTED).text(s(footer), M, doc.page.height - M + 2, { width: W - 70, height: 26, ellipsis: true });
    if (pages.count > 1) doc.font(L.regular).fontSize(L.small).fillColor(MUTED).text(`Page ${i + 1} of ${pages.count}`, M, doc.page.height - M + 2, { width: W, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
}

export function documentPdf(d: SalesDocument, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const { doc, done } = start({ title: `${d.title} ${d.number}`, author: d.company.name }, opts.compress);
  const L = look(d.style);
  const money = (v: string) => s(new Intl.NumberFormat('en-CA', { style: 'currency', currency: d.currency }).format(Number(v)));
  const W = doc.page.width - 2 * M;
  const right = doc.page.width - M;

  const leftBottom = header(doc, L, d.company, d.title, d.logo, d.style);

  // ---- details box (number, dates, terms)
  let y = M + L.title + 12;
  const labelX = right - 230;
  doc.fontSize(L.body);
  for (const [k, v] of [[NUMBER_LABEL[d.title], d.number], ...d.details] as [string, string][]) {
    doc.font(L.bold).fillColor(MUTED).text(s(k).toUpperCase(), labelX, y, { width: 110, align: 'right' });
    doc.font(L.regular).fillColor(INK).text(s(v), labelX + 120, y, { width: 110, align: 'right' });
    y += L.body + 5;
  }

  // ---- bill to (and ship to)
  y = Math.max(leftBottom, y) + 18;
  const party = (label: string, x: number, name: string | null, lines: string[]) => {
    doc.font(L.bold).fontSize(L.body).fillColor(MUTED).text(label, x, y);
    let yy = y + L.body + 4;
    if (name) { doc.font(L.bold).fontSize(L.body + 1).fillColor(INK).text(s(name), x, yy, { width: W / 2 - 10 }); yy = doc.y; }
    doc.font(L.regular).fontSize(L.body).fillColor(INK);
    for (const l of lines) { doc.text(s(l), x, yy, { width: W / 2 - 10 }); yy = doc.y; }
    return yy;
  };
  const b1 = party(PARTY_LABEL[d.title], M, d.billTo.name, [...(d.billTo.address ?? '').split('\n').filter(Boolean), ...(d.billTo.email ? [d.billTo.email] : [])]);
  const b2 = d.shipTo ? party(d.shipTo.label, M + W / 2, null, d.shipTo.text.split('\n').filter(Boolean)) : y;
  y = Math.max(b1, b2) + 18;

  // ---- lines table
  const hasDate = d.style?.showServiceDate !== false && d.lines.some((l) => l.serviceDate);
  const hasProduct = d.lines.some((l) => l.product);
  const hasTax = d.style?.showTaxColumn !== false;
  const cols: { key: 'serviceDate' | 'product' | 'description' | 'quantity' | 'rate' | 'amount' | 'taxCode'; label: string; w: number; align: 'left' | 'right' }[] = [
    ...(hasDate ? [{ key: 'serviceDate' as const, label: 'DATE', w: 62, align: 'left' as const }] : []),
    ...(hasProduct ? [{ key: 'product' as const, label: 'PRODUCT/SERVICE', w: 100, align: 'left' as const }] : []),
    { key: 'description', label: 'DESCRIPTION', w: 0, align: 'left' },
    { key: 'quantity', label: 'QTY', w: 40, align: 'right' },
    { key: 'rate', label: d.title === 'PURCHASE ORDER' ? 'COST' : 'RATE', w: 66, align: 'right' },
    { key: 'amount', label: 'AMOUNT', w: 76, align: 'right' },
    ...(hasTax ? [{ key: 'taxCode' as const, label: 'TAX', w: 52, align: 'left' as const }] : []),
  ];
  const fixed = cols.reduce((a, c) => a + c.w, 0);
  cols.find((c) => c.key === 'description')!.w = W - fixed - 6 * (cols.length - 1);
  const drawHeader = () => {
    if (L.layout === 'classic') {
      doc.moveTo(M, y).lineTo(right, y).lineWidth(1).strokeColor(INK).stroke();
      doc.moveTo(M, y + 18).lineTo(right, y + 18).lineWidth(0.5).strokeColor(INK).stroke();
    } else doc.rect(M, y, W, 18).fill(L.layout === 'modern' ? BAND : '#ffffff');
    let x = M + 4;
    doc.font(L.bold).fontSize(L.small).fillColor(L.layout === 'compact' ? L.accent : MUTED);
    for (const c of cols) { doc.text(c.label, x, y + 5, { width: c.w - 4, align: c.align }); x += c.w + 6; }
    y += 24;
  };
  drawHeader();
  doc.font(L.regular).fontSize(L.body).fillColor(INK);
  for (const l of d.lines) {
    const cell = (k: (typeof cols)[number]['key']) => (k === 'rate' ? money(l.rate) : k === 'amount' ? money(l.amount) : k === 'quantity' ? s(String(Number(l.quantity))) : s((l[k] as string | null | undefined) ?? ''));
    const h = Math.max(...cols.map((c) => doc.heightOfString(cell(c.key), { width: c.w - 4 }))) + L.pad;
    if (y + h > doc.page.height - M - 140) { doc.addPage(); y = M; drawHeader(); doc.font(L.regular).fontSize(L.body).fillColor(INK); }
    let x = M + 4;
    for (const c of cols) { doc.text(cell(c.key), x, y, { width: c.w - 4, align: c.align }); x += c.w + 6; }
    y += h;
    doc.moveTo(M, y - 3).lineTo(right, y - 3).lineWidth(0.5).strokeColor(RULE).stroke();
  }

  // ---- totals
  y += 8;
  if (y > doc.page.height - M - 120) { doc.addPage(); y = M; }
  const tot = (label: string, value: string, o: { bold?: boolean; big?: boolean } = {}) => {
    doc.font(o.bold ? L.bold : L.regular).fontSize(o.big ? L.body + 3 : L.body).fillColor(INK);
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

  // ---- message, payment instructions, pay link
  const block = (label: string, text: string) => {
    y += 10;
    if (y > doc.page.height - M - 60) { doc.addPage(); y = M; }
    doc.font(L.bold).fontSize(L.body).fillColor(MUTED).text(label, M, y);
    doc.font(L.regular).fontSize(L.body).fillColor(INK).text(s(text), M, y + L.body + 4, { width: W * 0.65 });
    y = doc.y;
  };
  if (d.message) block('MESSAGE', d.message);
  if (d.paymentInstructions) block('HOW TO PAY', d.paymentInstructions);
  if (d.payUrl) block('PAY ONLINE', d.payUrl);

  finish(doc, L, d.watermark, d.style?.footer);
  return done;
}

/** A customer statement: balance-forward (opening balance then each transaction) or open-item (open invoices only). */
export interface StatementDocument {
  currency: string;
  company: DocumentCompany;
  logo?: Buffer | null;
  style?: DocumentStyle;
  type: 'balance_forward' | 'open_item';
  from: string;
  to: string;
  customer: { name: string; address?: string | null; email?: string | null };
  /** Balance-forward only */
  opening?: string;
  rows: { date: string; type: string; number: string; dueDate?: string | null; amount: string; balance: string }[];
  closing: string;
  aging: { current: string; d1_30: string; d31_60: string; d61_90: string; over90: string };
}

export function statementPdf(d: StatementDocument, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const { doc, done } = start({ title: `Statement ${d.customer.name} ${d.to}`, author: d.company.name }, opts.compress);
  const L = look(d.style);
  const money = (v: string) => s(new Intl.NumberFormat('en-CA', { style: 'currency', currency: d.currency }).format(Number(v)));
  const W = doc.page.width - 2 * M;
  const right = doc.page.width - M;
  const leftBottom = header(doc, L, d.company, 'STATEMENT', d.logo, d.style);
  let y = M + L.title + 12;
  for (const [k, v] of [['Statement date', d.to], ['Period', `${d.from} to ${d.to}`], ['Type', d.type === 'open_item' ? 'Open items' : 'Balance forward'], ['Amount due', money(d.closing)]] as [string, string][]) {
    doc.font(L.bold).fontSize(L.body).fillColor(MUTED).text(s(k).toUpperCase(), right - 230, y, { width: 110, align: 'right' });
    doc.font(L.regular).fillColor(INK).text(v, right - 110, y, { width: 110, align: 'right' });
    y += L.body + 5;
  }
  y = Math.max(leftBottom, y) + 18;
  doc.font(L.bold).fontSize(L.body).fillColor(MUTED).text('TO', M, y);
  doc.font(L.bold).fontSize(L.body + 1).fillColor(INK).text(s(d.customer.name), M, y + L.body + 4);
  doc.font(L.regular).fontSize(L.body);
  for (const l of (d.customer.address ?? '').split('\n').filter(Boolean)) doc.text(s(l));
  y = doc.y + 18;

  const cols = [
    { label: 'DATE', w: 70, align: 'left' as const },
    { label: 'TRANSACTION', w: 0, align: 'left' as const },
    { label: 'DUE', w: 70, align: 'left' as const },
    { label: 'AMOUNT', w: 90, align: 'right' as const },
    { label: d.type === 'open_item' ? 'OPEN BALANCE' : 'BALANCE', w: 90, align: 'right' as const },
  ];
  cols[1].w = W - cols.reduce((a, c) => a + c.w, 0) - 6 * (cols.length - 1);
  const drawHeader = () => {
    doc.rect(M, y, W, 18).fill(BAND);
    let x = M + 4;
    doc.font(L.bold).fontSize(L.small).fillColor(MUTED);
    for (const c of cols) { doc.text(c.label, x, y + 5, { width: c.w - 4, align: c.align }); x += c.w + 6; }
    y += 24;
  };
  const row = (cells: string[], bold = false) => {
    if (y > doc.page.height - M - 110) { doc.addPage(); y = M; drawHeader(); }
    let x = M + 4;
    doc.font(bold ? L.bold : L.regular).fontSize(L.body).fillColor(INK);
    cells.forEach((t, i) => { doc.text(s(t), x, y, { width: cols[i].w - 4, align: cols[i].align }); x += cols[i].w + 6; });
    y += L.body + L.pad + 4;
    doc.moveTo(M, y - 3).lineTo(right, y - 3).lineWidth(0.5).strokeColor(RULE).stroke();
  };
  drawHeader();
  if (d.type === 'balance_forward' && d.opening !== undefined) row([d.from, 'Balance forward', '', '', money(d.opening)], true);
  for (const r of d.rows) row([r.date, `${r.type} ${r.number}`.trim(), r.dueDate ?? '', money(r.amount), money(r.balance)]);
  y += 6;
  doc.font(L.bold).fontSize(L.body + 3).fillColor(INK).text('Amount due', right - 260, y, { width: 160, align: 'right' }).text(money(d.closing), right - 95, y, { width: 95, align: 'right' });
  y += 30;

  // ---- aging boxes
  if (y > doc.page.height - M - 60) { doc.addPage(); y = M; }
  const buckets: [string, string][] = [['Current', d.aging.current], ['1-30 days', d.aging.d1_30], ['31-60 days', d.aging.d31_60], ['61-90 days', d.aging.d61_90], ['Over 90 days', d.aging.over90]];
  const bw = W / buckets.length;
  buckets.forEach(([k, v], i) => {
    doc.rect(M + i * bw, y, bw - 4, 36).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.font(L.bold).fontSize(L.small).fillColor(MUTED).text(k.toUpperCase(), M + i * bw + 6, y + 6, { width: bw - 16 });
    doc.font(L.regular).fontSize(L.body).fillColor(INK).text(money(v), M + i * bw + 6, y + 19, { width: bw - 16 });
  });
  finish(doc, L, undefined, d.style?.footer);
  return done;
}
