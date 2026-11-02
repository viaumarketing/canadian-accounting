'use client';
import { useState } from 'react';
import { useTracking } from '@/components/shared/tracking';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney, today, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Entry { id: string; date: string; hours: string; description: string | null; billable: boolean; billed: boolean; rate: string | null; customerId: string | null; projectId: string | null; itemId: string | null; user: { name: string }; project: { name: string } | null }
interface Contact { id: string; name: string }
interface Item { id: string; name: string; rate: string | null; type: string }
const blank = { date: today(), hours: '', customerId: '', projectId: '', itemId: '', description: '', billable: false, rate: '' };

/** Timesheet: log hours against a customer or project, billable or not. Billable time is added to invoices from the invoice editor. */
export default function TimePage() {
  const { companyId, can } = useCompany();
  const base = `/companies/${companyId}`;
  const { data, reload, error } = useApi<Entry[]>(`${base}/time`);
  const { data: customers } = useApi<Contact[]>(can('sales:view') ? `${base}/contacts?kind=CUSTOMER` : null);
  const { data: items } = useApi<Item[]>(can('sales:view') ? `${base}/items` : null);
  const { projects } = useTracking(companyId, { projects: can('sales:view') });
  const services = (items ?? []).filter((i) => i.type === 'SERVICE');
  const [f, setF] = useState(blank);
  const [err, setErr] = useState<string | null>(null);
  async function log() {
    setErr(null);
    try {
      await api(`${base}/time`, { method: 'POST', body: { date: f.date, hours: f.hours, billable: f.billable, ...(f.customerId ? { customerId: f.customerId } : {}), ...(f.projectId ? { projectId: f.projectId } : {}), ...(f.itemId ? { itemId: f.itemId } : {}), ...(f.description ? { description: f.description } : {}), ...(f.billable && f.rate ? { rate: f.rate } : {}) } });
      setF({ ...blank, date: f.date, customerId: f.customerId, projectId: f.projectId, itemId: f.itemId, billable: f.billable, rate: f.rate }); await reload();
    } catch (x) { setErr(errorMessage(x)); }
  }
  const remove = (e: Entry) => window.confirm('Delete this time entry?') && void api(`${base}/time/${e.id}`, { method: 'DELETE' }).then(reload).catch((x) => setErr(errorMessage(x)));
  const week = (data ?? []).filter((e) => e.date >= new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10)).reduce((s, e) => s + Number(e.hours), 0);
  return (
    <div className="space-y-5">
      <div className="flex items-end gap-3"><h1 className="text-2xl font-semibold tracking-tight">Time</h1><span className="ml-auto text-sm text-muted-foreground">Last 7 days: <strong className="tabular-nums">{week.toFixed(2)} h</strong></span></div>
      <FormError message={err ?? (error ? errorMessage(error) : null)} />
      {can('expenses:create') && (
        <Card><CardHeader><CardTitle>Log time</CardTitle></CardHeader><CardContent>
          <form className="grid gap-3 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); void log(); }}>
            <Field label="Date" htmlFor="t-date"><Input id="t-date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
            <Field label="Hours" htmlFor="t-h"><Input id="t-h" required inputMode="decimal" placeholder="1.5" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} /></Field>
            <Field label="Project" htmlFor="t-p"><Select id="t-p" value={f.projectId} onChange={(e) => { const p = projects.find((x) => x.id === e.target.value); setF({ ...f, projectId: e.target.value, ...(p ? { customerId: p.customerId } : {}) }); }}><option value="">None</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.customer.name})</option>)}</Select></Field>
            <Field label="Customer" htmlFor="t-c"><Select id="t-c" value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })} disabled={!!f.projectId}><option value="">None</option>{(customers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
            <Field label="Service" htmlFor="t-s"><Select id="t-s" value={f.itemId} onChange={(e) => { const it = services.find((x) => x.id === e.target.value); setF({ ...f, itemId: e.target.value, ...(it?.rate ? { rate: Number(it.rate).toFixed(2) } : {}) }); }}><option value="">None</option>{services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
            <Field label="Description" htmlFor="t-d"><Input id="t-d" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
            <div className="flex items-end gap-3 text-sm"><label className="flex items-center gap-2 pb-2"><input type="checkbox" checked={f.billable} onChange={(e) => setF({ ...f, billable: e.target.checked })} /> Billable</label>{f.billable && <Input aria-label="Rate per hour" inputMode="decimal" placeholder="Rate / h" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />}</div>
            <div className="flex items-end"><Button type="submit">Save</Button></div>
          </form>
        </CardContent></Card>
      )}
      <div className="overflow-x-auto rounded-md border bg-card shadow-sm">
        <table className="w-full min-w-[48rem] text-sm">
          <thead className="border-b bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr>{['Date', 'Person', 'Project / customer', 'Description', 'Hours', 'Billable', ''].map((h, i) => <th key={h} className={`px-3 py-2.5 ${i === 4 ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
          <tbody>
            {data && data.length === 0 && <tr><td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">No time logged yet.</td></tr>}
            {(data ?? []).map((e) => (
              <tr key={e.id} className="border-b last:border-0">
                <td className="px-3 py-2">{e.date}</td><td className="px-3 py-2">{e.user.name}</td>
                <td className="px-3 py-2">{e.project?.name ?? (customers ?? []).find((c) => c.id === e.customerId)?.name ?? ''}</td>
                <td className="px-3 py-2 text-muted-foreground">{e.description}</td>
                <td className="px-3 py-2 text-right tabular-nums">{Number(e.hours).toFixed(2)}</td>
                <td className="px-3 py-2">{e.billable ? (e.billed ? 'Billed' : `Yes${e.rate ? ` · ${fmtMoney(String(e.rate))}/h` : ''}`) : 'No'}</td>
                <td className="px-3 py-2 text-right">{!e.billed && can('expenses:create') && <button className="text-xs font-medium text-primary hover:underline" onClick={() => remove(e)}>Delete</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
