'use client';
import { BarChart3 } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui/card';
import { fmtMoney } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Charts {
  months: { month: string; income: string; expenses: string; net: string }[];
  receivables: { current: string; d1_30: string; d31_60: string; d61_90: string; over90: string; total: string; count: number };
  payables: { total: string; overdue: string; count: number };
  bankAccounts: { id: string; name: string; kind: string; balance: string }[];
  profitAndLoss: { fiscalYear: string; income: string; expenses: string; netIncome: string } | null;
}
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const AGING: [keyof Charts['receivables'], string, string][] = [['current', 'Current', 'bg-slate-400'], ['d1_30', '1–30 days', 'bg-amber-400'], ['d31_60', '31–60', 'bg-orange-500'], ['d61_90', '61–90', 'bg-orange-600'], ['over90', '90+', 'bg-red-600']];

/** Dashboard charts from the ledger: 12 months of income and expenses, A/R aging, bills owed and bank balances. */
export function DashboardCharts({ companyId }: { companyId: string }) {
  const { data } = useApi<Charts>(`/companies/${companyId}/dashboard/charts`);
  if (!data) return null;
  const series = data.months.map((m) => ({ label: `${MONTH[Number(m.month.slice(5)) - 1]} ${m.month.slice(2, 4)}`, Income: Number(m.income), Expenses: Number(m.expenses) }));
  const any = series.some((s) => s.Income || s.Expenses);
  const ar = data.receivables;
  const arTotal = Number(ar.total);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader><CardTitle>Income and expenses, last 12 months</CardTitle></CardHeader>
        <CardContent>
          {!any ? <EmptyState icon={<BarChart3 className="h-8 w-8" aria-hidden />} title="No income or expenses posted yet">Bars appear as invoices, receipts, bills and expenses are posted.</EmptyState> : (
            <div className="h-64" role="img" aria-label="Monthly income and expenses">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={series} margin={{ left: 8, right: 8, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
                  <Tooltip formatter={(v: number) => fmtMoney(v.toFixed(2))} contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Income" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="Expenses" fill="hsl(var(--muted-foreground) / 0.55)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle>Customers owe you · {ar.count} invoice{ar.count === 1 ? '' : 's'}</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <p className="text-2xl font-semibold tabular-nums">{fmtMoney(ar.total)}</p>
            <div className="flex h-3 overflow-hidden rounded-sm bg-muted" aria-hidden>{arTotal > 0 && AGING.map(([k, , cls]) => <div key={k} className={cls} style={{ width: `${(Number(ar[k]) / arTotal) * 100}%` }} />)}</div>
            <dl className="grid grid-cols-5 gap-1 text-[11px]">{AGING.map(([k, label]) => <div key={k}><dt className="text-muted-foreground">{label}</dt><dd className="tabular-nums">{fmtMoney(String(ar[k]))}</dd></div>)}</dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>You owe suppliers · {data.payables.count} bill{data.payables.count === 1 ? '' : 's'}</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-semibold tabular-nums">{fmtMoney(data.payables.total)}</p>{Number(data.payables.overdue) > 0 && <p className="text-sm text-orange-600">{fmtMoney(data.payables.overdue)} overdue</p>}</CardContent>
        </Card>
      </div>
      <Card className="lg:col-span-3">
        <CardHeader><CardTitle>Bank and holding accounts (balance in the books)</CardTitle></CardHeader>
        <CardContent>
          {data.bankAccounts.length === 0 ? <p className="text-sm text-muted-foreground">Add a bank account under Banking to see its balance here.</p> : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{data.bankAccounts.map((b) => <li key={b.id} className="rounded-md border p-3"><div className="text-xs text-muted-foreground">{b.kind === 'HOLDING' ? 'Waiting to be deposited' : b.kind === 'CREDIT_CARD' ? 'Credit card (owed)' : 'Bank'}</div><div className="font-medium">{b.name}</div><div className="text-lg font-semibold tabular-nums">{fmtMoney(b.balance)}</div></li>)}</ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
