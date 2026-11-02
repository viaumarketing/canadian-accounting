'use client';
import { useState } from 'react';
import { SidePanel } from '@/components/sales/common';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState } from '@/components/ui/card';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Project { id: string; name: string; customerId: string; status: string; description: string | null; budget: string | null; startDate: string | null; endDate: string | null; customer: { name: string } }
interface Profit { projectId: string; income: string; costs: string; profit: string; margin: string | null; hours: { billable: string; nonBillable: string; unbilled: string } }
interface Contact { id: string; name: string }
const blank = { name: '', customerId: '', status: 'ACTIVE', description: '', budget: '', startDate: '', endDate: '' };

/** Projects with profitability from the ledger (income and costs tagged with the project) and hours from time entries. */
export default function ProjectsPage() {
  const { companyId, can } = useCompany();
  const base = `/companies/${companyId}`;
  const { data, reload, error } = useApi<Project[]>(`${base}/projects`);
  const { data: profit, reload: reloadProfit } = useApi<Profit[]>(can('reports:view') ? `${base}/projects/profitability` : null);
  const { data: customers } = useApi<Contact[]>(`${base}/contacts?kind=CUSTOMER`);
  const [edit, setEdit] = useState<Project | 'new' | null>(null);
  const [f, setF] = useState(blank);
  const [err, setErr] = useState<string | null>(null);
  const open = (p: Project | 'new') => { setErr(null); setEdit(p); setF(p === 'new' ? blank : { name: p.name, customerId: p.customerId, status: p.status, description: p.description ?? '', budget: p.budget ? String(Number(p.budget)) : '', startDate: p.startDate?.slice(0, 10) ?? '', endDate: p.endDate?.slice(0, 10) ?? '' }); };
  async function save() {
    setErr(null);
    const body = { name: f.name, customerId: f.customerId, status: f.status, ...(f.description ? { description: f.description } : {}), ...(f.budget ? { budget: f.budget } : {}), ...(f.startDate ? { startDate: f.startDate } : {}), ...(f.endDate ? { endDate: f.endDate } : {}) };
    try {
      if (edit === 'new') await api(`${base}/projects`, { method: 'POST', body }); else if (edit) await api(`${base}/projects/${edit.id}`, { method: 'PUT', body });
      setEdit(null); await reload(); await reloadProfit();
    } catch (x) { setErr(errorMessage(x)); }
  }
  const p = (id: string) => profit?.find((x) => x.projectId === id);
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3"><h1 className="text-2xl font-semibold tracking-tight">Projects</h1>{can('sales:create') && <Button className="ml-auto" onClick={() => open('new')}>New project</Button>}</div>
      <FormError message={error ? errorMessage(error) : null} />
      {data && data.length === 0 ? <Card><EmptyState title="No projects yet">Group a customer job's invoices, bills, expenses and time to see whether it makes money. Tag lines with the project on invoices, bills and expenses.</EmptyState></Card> : (
        <div className="overflow-x-auto rounded-md border bg-card shadow-sm">
          <table className="w-full min-w-[56rem] text-sm">
            <thead className="border-b bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr>{['Project', 'Customer', 'Status', 'Income', 'Costs', 'Profit', 'Margin', 'Hours (billable / other / unbilled)', ''].map((h, i) => <th key={h} className={`px-3 py-2.5 ${i >= 3 && i <= 6 ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
            <tbody>
              {(data ?? []).map((x) => {
                const r = p(x.id);
                const over = r && x.budget && Number(r.costs) > Number(x.budget);
                return (
                  <tr key={x.id} className="border-b last:border-0">
                    <td className="px-3 py-2.5 font-medium">{x.name}{x.budget && <span className="block text-xs font-normal text-muted-foreground">Budget {fmtMoney(String(Number(x.budget).toFixed(2)))}{over && <span className="text-destructive"> · over budget</span>}</span>}</td>
                    <td className="px-3 py-2.5">{x.customer.name}</td>
                    <td className="px-3 py-2.5"><Badge tone={x.status === 'ACTIVE' ? 'success' : 'neutral'}>{x.status.toLowerCase()}</Badge></td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r ? fmtMoney(r.income) : ''}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r ? fmtMoney(r.costs) : ''}</td>
                    <td className={`px-3 py-2.5 text-right font-medium tabular-nums ${r && Number(r.profit) < 0 ? 'text-destructive' : ''}`}>{r ? fmtMoney(r.profit) : ''}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r?.margin ? `${r.margin}%` : ''}</td>
                    <td className="px-3 py-2.5 tabular-nums">{r ? `${r.hours.billable} / ${r.hours.nonBillable} / ${r.hours.unbilled}` : ''}</td>
                    <td className="px-3 py-2.5 text-right">{can('sales:create') && <button className="text-xs font-medium text-primary hover:underline" onClick={() => open(x)}>Edit</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Costs are what was posted against the project (bills, expenses, cost of goods sold). Labour cost is not included: this app does not run payroll, so time has hours but no cost rate.</p>
      {edit && (
        <SidePanel title={edit === 'new' ? 'New project' : `Edit ${edit.name}`} onClose={() => setEdit(null)} footer={<><Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button disabled={!f.name.trim() || !f.customerId} onClick={() => void save()}>Save</Button></>}>
          <FormError message={err} />
          <Field label="Project name" htmlFor="pj-name"><Input id="pj-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Customer" htmlFor="pj-cust"><Select id="pj-cust" value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })}><option value="">Choose…</option>{(customers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Status" htmlFor="pj-st"><Select id="pj-st" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="ACTIVE">Active</option><option value="COMPLETED">Completed</option><option value="CANCELLED">Cancelled</option></Select></Field>
            <Field label="Cost budget" htmlFor="pj-bud"><Input id="pj-bud" inputMode="decimal" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} /></Field>
            <Field label="Start" htmlFor="pj-s"><Input id="pj-s" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
            <Field label="End" htmlFor="pj-e"><Input id="pj-e" type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
          </div>
          <Field label="Description" htmlFor="pj-d"><Input id="pj-d" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        </SidePanel>
      )}
    </div>
  );
}
