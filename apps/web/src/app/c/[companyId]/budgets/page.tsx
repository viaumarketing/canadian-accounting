'use client';
import { useEffect, useMemo, useState } from 'react';
import type { Account } from '@/components/sales/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui/card';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Budget { id: string; name: string; fiscalYearId: string; _count?: { lines: number } }
interface FY { id: string; label: string; startDate: string; endDate: string }
interface Vs { budget: { name: string; fiscalYear: string }; months: string[]; rows: { accountId: string; code: string; name: string; type: string; months: { month: string; budget: string; actual: string; variance: string }[]; total: { budget: string; actual: string; variance: string; percent: string | null } }[] }
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthsOf = (fy: FY) => { const out: string[] = []; let y = Number(fy.startDate.slice(0, 4)), m = Number(fy.startDate.slice(5, 7)); const end = fy.endDate.slice(0, 7); for (;;) { const k = `${y}-${String(m).padStart(2, '0')}`; out.push(k); if (k >= end || out.length > 13) break; m++; if (m > 12) { m = 1; y++; } } return out; };

/** Budgets by account and month, and budget vs. actual. */
export default function BudgetsPage() {
  const { companyId, can } = useCompany();
  const base = `/companies/${companyId}`;
  const { data: budgets, reload } = useApi<Budget[]>(`${base}/budgets`);
  const { data: years } = useApi<FY[]>(can('journal:view') ? `${base}/fiscal-years` : null);
  const { data: accounts } = useApi<Account[]>(can('accounts:view') ? `${base}/accounts` : null);
  const pl = (accounts ?? []).filter((a) => a.type === 'REVENUE' || a.type === 'EXPENSE');
  const [current, setCurrent] = useState<string>('');
  const [name, setName] = useState('');
  const [fyId, setFyId] = useState('');
  const [grid, setGrid] = useState<Record<string, string>>({}); // `${accountId}|${month}` → amount
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const budget = (budgets ?? []).find((b) => b.id === current);
  const fy = (years ?? []).find((y) => y.id === (budget?.fiscalYearId ?? fyId)) ?? years?.[years.length - 1];
  const months = useMemo(() => (fy ? monthsOf(fy) : []), [fy]);
  const { data: vs, reload: reloadVs } = useApi<Vs>(current ? `${base}/budgets/${current}/vs-actual` : null);
  useEffect(() => {
    if (!current) { setGrid({}); return; }
    api<{ name: string; fiscalYearId: string; lines: { accountId: string; month: string; amount: string }[] }>(`${base}/budgets/${current}`).then((b) => { setName(b.name); setFyId(b.fiscalYearId); setGrid(Object.fromEntries(b.lines.map((l) => [`${l.accountId}|${l.month}`, String(Number(l.amount))]))); }).catch((e) => setErr(errorMessage(e)));
  }, [current]);
  useEffect(() => { if (!current && budgets?.length) setCurrent(budgets[0].id); }, [budgets]);
  const fill = (accountId: string) => { const first = grid[`${accountId}|${months[0]}`]; if (first) setGrid((g) => ({ ...g, ...Object.fromEntries(months.map((m) => [`${accountId}|${m}`, first])) })); };
  async function save() {
    setErr(null); setMsg(null);
    const lines = Object.entries(grid).filter(([, v]) => v && Number(v) !== 0).map(([k, amount]) => { const [accountId, month] = k.split('|'); return { accountId, month, amount }; });
    try {
      const body = { name: name || 'Budget', fiscalYearId: fy!.id, lines };
      const b = current ? await api<Budget>(`${base}/budgets/${current}`, { method: 'PUT', body }) : await api<Budget>(`${base}/budgets`, { method: 'POST', body });
      await reload(); setCurrent(b.id); await reloadVs(); setMsg('Budget saved.');
    } catch (x) { setErr(errorMessage(x)); }
  }
  const sumRow = (accountId: string) => months.reduce((s, m) => s + (Number(grid[`${accountId}|${m}`]) || 0), 0);
  const editable = can('accounts:create');
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Budgets</h1>
        <div className="ml-auto flex items-end gap-2">
          <Field label="Budget" htmlFor="bg-sel"><Select id="bg-sel" className="w-56" value={current} onChange={(e) => setCurrent(e.target.value)}><option value="">New budget…</option>{(budgets ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        </div>
      </div>
      <FormError message={err} />
      {msg && <p role="status" className="rounded-md border border-primary/30 bg-accent px-3 py-2 text-sm">{msg}</p>}
      <Tabs defaultValue="edit">
        <TabsList><TabsTrigger value="edit">Budget</TabsTrigger>{current && <TabsTrigger value="vs">Budget vs. actual</TabsTrigger>}</TabsList>
        <TabsContent value="edit" className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Name" htmlFor="bg-name"><Input id="bg-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="2026 operating budget" /></Field>
            <Field label="Fiscal year" htmlFor="bg-fy"><Select id="bg-fy" disabled={!!current} value={fy?.id ?? ''} onChange={(e) => setFyId(e.target.value)}>{(years ?? []).map((y) => <option key={y.id} value={y.id}>{y.label}</option>)}</Select></Field>
            {editable && <Button disabled={!fy} onClick={() => void save()}>Save budget</Button>}
          </div>
          {!fy ? <Card><EmptyState title="No fiscal year">Create a fiscal year under Accounting first.</EmptyState></Card> : (
            <div className="overflow-x-auto rounded-md border bg-card shadow-sm">
              <table className="min-w-full text-sm">
                <thead className="border-b bg-muted/60 text-xs uppercase text-muted-foreground"><tr><th className="sticky left-0 bg-muted/60 px-3 py-2 text-left">Account</th>{months.map((m) => <th key={m} className="px-1 py-2 text-right">{MONTH[Number(m.slice(5)) - 1]} {m.slice(2, 4)}</th>)}<th className="px-3 py-2 text-right">Total</th></tr></thead>
                <tbody>
                  {(['REVENUE', 'EXPENSE'] as const).map((t) => [
                    <tr key={t} className="bg-muted/30"><td colSpan={months.length + 2} className="px-3 py-1.5 text-xs font-semibold uppercase">{t === 'REVENUE' ? 'Income' : 'Expenses'}</td></tr>,
                    ...pl.filter((a) => a.type === t).map((a) => (
                      <tr key={a.id} className="border-t">
                        <td className="sticky left-0 whitespace-nowrap bg-card px-3 py-1">{a.code} · {a.name}{editable && <button type="button" className="ml-2 text-[11px] text-primary hover:underline" onClick={() => fill(a.id)} title="Copy the first month to every month">fill →</button>}</td>
                        {months.map((m) => <td key={m} className="px-1 py-1"><Input aria-label={`${a.name} ${m}`} disabled={!editable} inputMode="decimal" className="h-7 w-20 text-right" value={grid[`${a.id}|${m}`] ?? ''} onChange={(e) => setGrid((g) => ({ ...g, [`${a.id}|${m}`]: e.target.value }))} /></td>)}
                        <td className="px-3 py-1 text-right tabular-nums">{sumRow(a.id) ? fmtMoney(sumRow(a.id).toFixed(2)) : ''}</td>
                      </tr>
                    )),
                  ])}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
        {current && <TabsContent value="vs">
          {vs && <Card><CardHeader><CardTitle>{vs.budget.name} · {vs.budget.fiscalYear} · actual excludes year-end closing entries</CardTitle></CardHeader><CardContent className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground"><tr><th className="py-2">Account</th><th className="text-right">Budget</th><th className="text-right">Actual</th><th className="text-right">Over / (under)</th><th className="text-right">% of budget</th></tr></thead>
              <tbody>{vs.rows.map((r) => { const v = Number(r.total.variance); const bad = r.type === 'EXPENSE' ? v > 0 : v < 0; return <tr key={r.accountId} className="border-t"><td className="py-1.5">{r.code} · {r.name}</td><td className="text-right tabular-nums">{fmtMoney(r.total.budget)}</td><td className="text-right tabular-nums">{fmtMoney(r.total.actual)}</td><td className={`text-right tabular-nums ${v !== 0 && bad ? 'text-destructive' : ''}`}>{fmtMoney(r.total.variance)}</td><td className="text-right tabular-nums">{r.total.percent ? `${r.total.percent}%` : '—'}</td></tr>; })}</tbody>
            </table>
          </CardContent></Card>}
        </TabsContent>}
      </Tabs>
    </div>
  );
}
