'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { SalesHeader, SidePanel } from '@/components/sales/common';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Customer { id: string; kind: string; name: string; email: string | null; phone: string | null; billingAddress: string | null; province: string | null; defaultTerms: string | null }
const TERMS = [['', 'None'], ['DUE_ON_RECEIPT', 'Due on receipt'], ['NET_15', 'Net 15'], ['NET_30', 'Net 30'], ['NET_60', 'Net 60']] as const;
const empty = { name: '', email: '', phone: '', billingAddress: '', province: '', defaultTerms: '' };

function Customers() {
  const { companyId, can } = useCompany();
  const params = useSearchParams();
  const { data, reload } = useApi<Customer[]>(`/companies/${companyId}/contacts?kind=CUSTOMER`);
  const { data: balances, reload: reloadBalances } = useApi<Record<string, string>>(`/companies/${companyId}/sales/customer-balances`);
  const [edit, setEdit] = useState<Customer | 'new' | null>(null);
  const [f, setF] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => { if (params.get('new') === '1' && can('sales:create')) open('new'); }, []);
  function open(c: Customer | 'new') {
    setErr(null); setEdit(c);
    setF(c === 'new' ? empty : { name: c.name, email: c.email ?? '', phone: c.phone ?? '', billingAddress: c.billingAddress ?? '', province: c.province ?? '', defaultTerms: c.defaultTerms ?? '' });
  }
  async function save() {
    setErr(null);
    const body = { name: f.name, email: f.email || undefined, phone: f.phone || undefined, billingAddress: f.billingAddress || undefined, province: f.province || undefined, defaultTerms: f.defaultTerms || undefined };
    try {
      if (edit === 'new') await api(`/companies/${companyId}/contacts`, { method: 'POST', body: { kind: 'CUSTOMER', ...body } });
      else if (edit) await api(`/companies/${companyId}/contacts/${edit.id}`, { method: 'PATCH', body: { ...body, email: f.email || null, phone: f.phone || null, billingAddress: f.billingAddress || null } });
      setEdit(null); await reload(); await reloadBalances();
    } catch (x) { setErr(errorMessage(x)); }
  }
  const rows = (data ?? []).filter((c) => !q || `${c.name} ${c.email ?? ''} ${c.phone ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const totalOpen = Object.values(balances ?? {}).reduce((s, v) => s + Math.round(parseFloat(v) * 100), 0) / 100;
  return (
    <div className="space-y-5">
      <SalesHeader title="Customers" actions={can('sales:create') && <Button variant="outline" onClick={() => open('new')}>New customer</Button>} />
      <div className="flex flex-wrap items-center gap-3">
        <Input placeholder="Search customers" aria-label="Search customers" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <span className="ml-auto text-sm text-muted-foreground">Open balance across customers: <strong className="text-foreground">{fmtMoney(totalOpen.toFixed(2))}</strong></span>
      </div>
      <div className="overflow-x-auto rounded-md border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-3 py-2.5">Customer</th><th className="px-3 py-2.5">Phone</th><th className="px-3 py-2.5">Email</th><th className="px-3 py-2.5 text-right">Open balance</th><th className="px-3 py-2.5 text-right">Action</th></tr></thead>
          <tbody>
            {data && rows.length === 0 && <tr><td colSpan={5} className="px-3 py-10 text-center text-muted-foreground">No customers yet.</td></tr>}
            {rows.map((c) => (
              <tr key={c.id} className="border-b last:border-0 hover:bg-accent/50">
                <td className="px-3 py-2.5 font-medium">{c.name}</td><td className="px-3 py-2.5">{c.phone}</td><td className="px-3 py-2.5">{c.email}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(balances?.[c.id] ?? '0.00')}</td>
                <td className="px-3 py-2.5 text-right">
                  <div className="inline-flex gap-3 text-xs font-medium">
                    {can('sales:create') && <a className="text-primary hover:underline" href={`/c/${companyId}/sales/invoices/new?customer=${c.id}`}>Create invoice</a>}
                    {can('sales:create') && <button className="text-primary hover:underline" onClick={() => open(c)}>Edit</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <SidePanel title={edit === 'new' ? 'New customer' : `Edit ${edit.name}`} onClose={() => setEdit(null)} footer={<><Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={() => void save()} disabled={!f.name.trim()}>Save</Button></>}>
          <FormError message={err} />
          <Field label="Customer display name" htmlFor="c-name"><Input id="c-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Email" htmlFor="c-email"><Input id="c-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Phone" htmlFor="c-phone"><Input id="c-phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          </div>
          <Field label="Billing address" htmlFor="c-addr"><textarea id="c-addr" rows={3} className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={f.billingAddress} onChange={(e) => setF({ ...f, billingAddress: e.target.value })} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Province (place of supply)" htmlFor="c-prov" hint="Two letters, e.g. ON"><Input id="c-prov" maxLength={2} value={f.province} onChange={(e) => setF({ ...f, province: e.target.value.toUpperCase() })} /></Field>
            <Field label="Default terms" htmlFor="c-terms"><Select id="c-terms" value={f.defaultTerms} onChange={(e) => setF({ ...f, defaultTerms: e.target.value })}>{TERMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          </div>
        </SidePanel>
      )}
    </div>
  );
}
export default function CustomersPage() {
  return <Suspense><Customers /></Suspense>;
}
