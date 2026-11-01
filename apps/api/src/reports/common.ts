import Decimal from 'decimal.js';
import type { Prisma } from '@ca/database';
import { col, row, type Report, type Row, type Section } from '@ca/reporting';
import { PrismaService } from '../prisma.service';
import { currentFiscalYear, isoDate } from '../companies/fiscal-year';
import { isoOf, toDate } from '../accounting/setup';

export const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
export const m2 = (d: Decimal) => d.toFixed(2);
export { isoOf, toDate, col, row };

export interface Ctx { prisma: PrismaService; companyId: string; companyName: string; baseCurrency: string }
export const newReport = (c: Ctx, key: string, title: string, subtitle?: string): Report => ({ key, title, subtitle, company: c.companyName, generatedAt: new Date().toISOString(), sections: [], checks: [], notes: [] });

export const addDays = (iso: string, n: number) => isoOf(new Date(toDate(iso).getTime() + n * 86_400_000));
export function addYears(iso: string, n: number): string {
  const d = toDate(iso);
  const y = d.getUTCFullYear() + n;
  const m = d.getUTCMonth();
  return isoOf(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), new Date(Date.UTC(y, m + 1, 0)).getUTCDate()))));
}
export const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);

export type Compare = 'none' | 'prior_period' | 'prior_year';
export function comparisonRange(from: string, to: string, mode: Compare): { from: string; to: string } | null {
  if (mode === 'none') return null;
  if (mode === 'prior_year') return { from: addYears(from, -1), to: addYears(to, -1) };
  const len = daysBetween(from, to) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

/** Fiscal-year bounds containing `date` (from the company's year-end setting; works even if no FiscalYear row exists yet). */
export async function fiscalYearBounds(c: Ctx, date: string) {
  const co = await c.prisma.company.findUniqueOrThrow({ where: { id: c.companyId } });
  const fy = currentFiscalYear(toDate(date), co.fiscalYearEndMonth, co.fiscalYearEndDay);
  return { start: isoDate(fy.startDate), end: isoDate(fy.endDate), label: fy.label };
}

export type Bal = { debit: Decimal; credit: Decimal };
/** Σ debit / credit per account over POSTED entries in [from, to] (both inclusive; from optional). */
export async function balances(c: Ctx, o: { from?: string; to: string }, db: Prisma.TransactionClient | PrismaService = c.prisma): Promise<Map<string, Bal>> {
  const rows = await db.journalLine.groupBy({
    by: ['accountId'],
    where: { companyId: c.companyId, entry: { status: 'POSTED', date: { ...(o.from ? { gte: toDate(o.from) } : {}), lte: toDate(o.to) } } },
    _sum: { debit: true, credit: true },
  });
  return new Map(rows.map((r) => [r.accountId, { debit: D(r._sum.debit ?? 0), credit: D(r._sum.credit ?? 0) }]));
}

export interface Acct { id: string; code: string; name: string; type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE'; parentId: string | null; role: string | null; cashFlow: 'OPERATING' | 'INVESTING' | 'FINANCING' | null }
export const loadAccounts = (c: Ctx): Promise<Acct[]> => c.prisma.account.findMany({ where: { companyId: c.companyId }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, type: true, parentId: true, role: true, cashFlow: true } });

/** Natural-sign amount: assets/expenses = debit − credit; liabilities/equity/revenue = credit − debit. */
export const natural = (a: Acct, b: Bal | undefined) => (!b ? D(0) : ['ASSET', 'EXPENSE'].includes(a.type) ? b.debit.minus(b.credit) : b.credit.minus(b.debit));
export const net = (b: Bal | undefined) => (b ? b.debit.minus(b.credit) : D(0)); // debit-positive

export interface Node { acct: Acct; level: number; own: Decimal[]; total: Decimal[] }
/** Depth-first rows of the account tree with roll-up totals per column; accounts whose totals are all zero are dropped. */
export function accountTree(accts: Acct[], type: Acct['type'], values: Decimal[][] /* per column: unused */, valueOf: (a: Acct, col: number) => Decimal, cols: number): Node[] {
  void values;
  const mine = accts.filter((a) => a.type === type);
  const ids = new Set(mine.map((a) => a.id));
  const kids = new Map<string | null, Acct[]>();
  for (const a of mine) { const k = a.parentId && ids.has(a.parentId) ? a.parentId : null; kids.set(k, [...(kids.get(k) ?? []), a]); }
  const out: Node[] = [];
  const walk = (a: Acct, level: number): Decimal[] => {
    const own = Array.from({ length: cols }, (_, i) => valueOf(a, i));
    const sub: Node[] = [];
    const start = out.length;
    out.push({ acct: a, level, own, total: own });
    let total = own;
    for (const k of kids.get(a.id) ?? []) { const t = walk(k, level + 1); total = total.map((v, i) => v.plus(t[i])); }
    out[start].total = total;
    void sub;
    if (total.every((v) => v.isZero())) out.length = start; // prune empty branches
    return total;
  };
  for (const r of kids.get(null) ?? []) walk(r, 0);
  return out;
}

export const nameOf = (a: Acct) => `${a.code} · ${a.name}`;
export const pct = (v: Decimal, base: Decimal) => (base.isZero() ? null : v.div(base).times(100).toDecimalPlaces(1).toNumber());

export function sectionTotals(label: string, vals: Decimal[], keys: string[]): Row {
  return row({ name: label, ...Object.fromEntries(keys.map((k, i) => [k, m2(vals[i])])) }, { bold: true });
}
export type { Section };
