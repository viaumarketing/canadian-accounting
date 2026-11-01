import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { col, fmtMoney, row, safeText, toCsv, toPdf, toXlsx, type Report } from './index';
import { pdfSafe } from './pdf';

const report = (): Report => ({
  key: 'demo', title: 'Profit & Loss', subtitle: '2026-01-01 to 2026-12-31', company: 'Érablière Maple Goods Inc.', generatedAt: '2026-10-30T12:00:00Z',
  sections: [{
    title: 'Revenue', columns: [col('name', 'Account'), col('amount', 'Amount', 'money'), col('pct', '% of revenue', 'pct'), col('n', 'Count', 'int')],
    rows: [row({ name: 'Sales Revenue', amount: '12345.5', pct: 98.123, n: 4 }, { level: 1 }), row({ name: '=HYPERLINK("http://evil")', amount: '-1234567.891', pct: null, n: 1 }), row({ name: 'Line, with "quotes"', amount: '0.00', pct: null, n: 0 })],
    totals: [row({ name: 'Total', amount: '-1222222.39' }, { bold: true })],
  }],
  checks: [{ label: 'Balances', ok: true }, { label: 'Ties to ledger', ok: false, detail: 'off by 0.01' }],
  notes: ['Accrual basis.'],
});

describe('formatting', () => {
  it('formats money from strings without floats', () => {
    expect(fmtMoney('1234567.891')).toBe('1,234,567.89');
    expect(fmtMoney('-0.004')).toBe('0.00');
    expect(fmtMoney('2.005')).toBe('2.01');
    expect(fmtMoney('2.004')).toBe('2.00');
    expect(fmtMoney('-1234.5')).toBe('-1,234.50');
    expect(fmtMoney(null)).toBe('');
    expect(fmtMoney('n/a')).toBe('n/a');
  });
  it('neutralises formula injection', () => {
    for (const bad of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx']) expect(safeText(bad)).toBe(`'${bad}`);
    expect(safeText('Hydro')).toBe('Hydro');
  });
});

describe('CSV', () => {
  const csv = toCsv(report());
  it('has a BOM, CRLF lines, quoted fields, real numbers, and neutralised text', () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('\r\n');
    expect(csv).toContain('"Line, with ""quotes"""');
    expect(csv).toContain("'=HYPERLINK(");
    expect(csv).toContain('Sales Revenue,12345.5,98.123,4');
    expect(csv).toContain(',-1234567.891,'); // negative money is a number, not text
    expect(csv).toContain('Érablière');
    expect(csv).toMatch(/Ties to ledger,FAILED,off by 0.01/);
  });
});

describe('XLSX', () => {
  it('writes real numeric cells with number formats, totals, checks and notes', async () => {
    const buf = await toXlsx(report());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    expect(ws.name).toBe('Profit & Loss');
    const find = (text: string) => { let r: ExcelJS.Row | undefined; ws.eachRow((x) => { if (String(x.getCell(1).value).trim() === text) r = x; }); return r!; };
    const sales = find('Sales Revenue');
    expect(sales.getCell(2).value).toBe(12345.5);
    expect(sales.getCell(2).numFmt).toMatch(/#,##0\.00/);
    expect(typeof sales.getCell(4).value).toBe('number');
    expect(String(find('=HYPERLINK("http://evil")').getCell(1).value)).toBe('=HYPERLINK("http://evil")'); // stored as a string cell, not a formula
    expect(find('=HYPERLINK("http://evil")').getCell(1).type).toBe(ExcelJS.ValueType.String);
    expect(find('Total').font?.bold).toBe(true);
    expect(find('Ties to ledger').getCell(2).value).toBe('FAILED');
  });
});

describe('PDF', () => {
  it('maps symbols the built-in font lacks to ASCII and keeps accents', () => {
    expect(pdfSafe('105 \u2212 108 \u2192 net \u2265 0 \u03a3')).toBe('105 - 108 -> net >= 0 Sum');
    expect(pdfSafe('\u00c9rabli\u00e8re \u2018x\u2019')).toBe("\u00c9rabli\u00e8re 'x'");
    expect(pdfSafe('\u4e2d')).toBe('?');
  });
  it('produces a valid multi-page PDF for a long report, with footer page numbers', async () => {
    const r = report();
    r.sections[0].rows = Array.from({ length: 160 }, (_, i) => row({ name: `Account ${i}`, amount: String(i * 10.5), pct: i / 2, n: i }));
    const buf = await toPdf(r, { compress: false });
    const s = buf.toString('latin1');
    expect(s.startsWith('%PDF-')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    const pages = (s.match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThan(2);
    expect(buf.length).toBeGreaterThan(5000);
  });
  it('handles wide tables (landscape) and empty sections', async () => {
    const r = report();
    r.sections.push({ title: 'Wide', columns: Array.from({ length: 9 }, (_, i) => col(`c${i}`, `Col ${i}`, i ? 'money' : 'text')), rows: [] });
    const buf = await toPdf(r);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
