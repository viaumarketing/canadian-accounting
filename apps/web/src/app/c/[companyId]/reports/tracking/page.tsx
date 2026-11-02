'use client';
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui/card';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { errorMessage } from '@/lib/api';
import { fmtMoney, today, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Pl { columns: { id: string | null; name: string }[]; lines: { accountId: string; code: string; name: string; type: string; values: string[]; total: string }[]; totals: { income: string[]; expenses: string[]; netIncome: string[] }; grand: { income: string; expenses: string; netIncome: string } }

/** Profit and loss with a column per class or per location. */
export default function TrackingReportPage() {
  const { companyId } = useCompany();
  const [dim, setDim] = useState<'class' | 'location'>('class');
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());
  const { data, error } = useApi<Pl>(`/companies/${companyId}/reports/profit-and-loss-by-${dim}?from=${from}&to=${to}`);
  const section = (type: string, label: string, totals: string[], grand: string) => data && [
    <tr key={type} className="bg-muted/30"><td colSpan={data.columns.length + 2} className="px-3 py-1.5 text-xs font-semibold uppercase">{label}</td></tr>,
    ...data.lines.filter((l) => l.type === type).map((l) => <tr key={l.accountId} className="border-t"><td className="sticky left-0 bg-card px-3 py-1.5">{l.code} · {l.name}</td>{l.values.map((v, i) => <td key={i} className="px-3 py-1.5 text-right tabular-nums">{v === '0.00' ? '' : fmtMoney(v)}</td>)}<td className="px-3 py-1.5 text-right font-medium tabular-nums">{fmtMoney(l.total)}</td></tr>),
    <tr key={`${type}-t`} className="border-t font-semibold"><td className="sticky left-0 bg-card px-3 py-1.5">Total {label.toLowerCase()}</td>{totals.map((v, i) => <td key={i} className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(v)}</td>)}<td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(grand)}</td></tr>,
  ];
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Profit and loss by {dim}</h1>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Columns" htmlFor="tr-dim"><Select id="tr-dim" value={dim} onChange={(e) => setDim(e.target.value as 'class' | 'location')}><option value="class">Classes</option><option value="location">Locations</option></Select></Field>
        <Field label="From" htmlFor="tr-from"><Input id="tr-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To" htmlFor="tr-to"><Input id="tr-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <FormError message={error ? errorMessage(error) : null} />
      {data && (data.columns.length === 1 ? <Card><EmptyState title={`No ${dim === 'class' ? 'classes' : 'locations'} yet`}>Add them in Settings → Classes & locations, then choose them on invoices, bills and expenses.</EmptyState></Card> : (
        <Card><CardHeader><CardTitle>{from} to {to} · year-end closing entries excluded</CardTitle></CardHeader><CardContent className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs uppercase text-muted-foreground"><tr><th className="sticky left-0 bg-card px-3 py-2 text-left">Account</th>{data.columns.map((c) => <th key={c.id ?? 'none'} className="px-3 py-2 text-right">{c.name}</th>)}<th className="px-3 py-2 text-right">Total</th></tr></thead>
            <tbody>
              {section('REVENUE', 'Income', data.totals.income, data.grand.income)}
              {section('EXPENSE', 'Expenses', data.totals.expenses, data.grand.expenses)}
              <tr className="border-t-2 text-base font-semibold"><td className="sticky left-0 bg-card px-3 py-2">Net income</td>{data.totals.netIncome.map((v, i) => <td key={i} className="px-3 py-2 text-right tabular-nums">{fmtMoney(v)}</td>)}<td className="px-3 py-2 text-right tabular-nums">{fmtMoney(data.grand.netIncome)}</td></tr>
            </tbody>
          </table>
        </CardContent></Card>
      ))}
    </div>
  );
}
