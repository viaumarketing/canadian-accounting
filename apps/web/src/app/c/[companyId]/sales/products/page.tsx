'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { SalesHeader, SidePanel, type Account } from '@/components/sales/common';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Item { id: string; name: string; sku: string | null; type: 'SERVICE' | 'NON_INVENTORY'; description: string | null; rate: string | null; incomeAccountId: string; taxCodeId: string | null; isActive: boolean; incomeAccount: { code: string; name: string }; taxCode: { code: string } | null }
interface TaxCode { id: string; code: string; name: string }
const empty = { name: '', sku: '', type: 'SERVICE' as Item['type'], description: '', rate: '', incomeAccountId: '', taxCodeId: '' };

function Products() {
  const { companyId, can } = useCompany();
  const params = useSearchParams();
  const [showInactive, setShowInactive] = useState(false);
  const { data, reload } = useApi<Item[]>(`/companies/${companyId}/items${showInactive ? '?all=true' : ''}`);
  const { data: accounts } = useApi<Account[]>(can('accounts:view') ? `/companies/${companyId}/accounts` : null);
  const { data: taxCodes } = useApi<TaxCode[]>(can('taxes:view') ? `/companies/${companyId}/tax-codes` : null);
  const income = (accounts ?? []).filter((a) => a.type === 'REVENUE' && !a.role);
  const [edit, setEdit] = useState<Item | 'new' | null>(null);
  const [f, setF] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (params.get('new') === '1' && can('sales:create')) open('new'); }, []);
  function open(i: Item | 'new') {
    setErr(null); setEdit(i);
    setF(i === 'new' ? empty : { name: i.name, sku: i.sku ?? '', type: i.type, description: i.description ?? '', rate: i.rate ? String(i.rate) : '', incomeAccountId: i.incomeAccountId, taxCodeId: i.taxCodeId ?? '' });
  }
  async function save(extra: object = {}) {
    setErr(null);
    const body = { name: f.name, type: f.type, sku: f.sku || null, description: f.description || null, rate: f.rate || null, incomeAccountId: f.incomeAccountId || income[0]?.id, taxCodeId: f.taxCodeId || null, ...extra };
    try {
      if (edit === 'new') await api(`/companies/${companyId}/items`, { method: 'POST', body: Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null)) });
      else if (edit) await api(`/companies/${companyId}/items/${edit.id}`, { method: 'PATCH', body });
      setEdit(null); await reload();
    } catch (x) { setErr(errorMessage(x)); }
  }
  return (
    <div className="space-y-5">
      <SalesHeader title="Products and services" actions={can('sales:create') && <Button variant="outline" onClick={() => open('new')}>New product or service</Button>} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Include inactive</label>
      <div className="overflow-x-auto rounded-md border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-3 py-2.5">Name</th><th className="px-3 py-2.5">SKU</th><th className="px-3 py-2.5">Type</th><th className="px-3 py-2.5">Sales description</th><th className="px-3 py-2.5">Income account</th><th className="px-3 py-2.5">Tax</th><th className="px-3 py-2.5 text-right">Sales price</th><th className="px-3 py-2.5 text-right">Action</th></tr></thead>
          <tbody>
            {data && data.length === 0 && <tr><td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">No products or services yet. Add the things you sell so invoices and receipts fill themselves in.</td></tr>}
            {(data ?? []).map((i) => (
              <tr key={i.id} className="border-b last:border-0 hover:bg-accent/50">
                <td className="px-3 py-2.5 font-medium">{i.name}{!i.isActive && <span className="ml-2 text-xs text-muted-foreground">(inactive)</span>}</td>
                <td className="px-3 py-2.5 font-mono text-xs">{i.sku}</td>
                <td className="px-3 py-2.5">{i.type === 'SERVICE' ? 'Service' : 'Non-inventory'}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{i.description}</td>
                <td className="px-3 py-2.5">{i.incomeAccount.code} · {i.incomeAccount.name}</td>
                <td className="px-3 py-2.5 font-mono text-xs">{i.taxCode?.code}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{i.rate ? fmtMoney(String(i.rate)) : ''}</td>
                <td className="px-3 py-2.5 text-right">{can('sales:create') && <button className="text-xs font-medium text-primary hover:underline" onClick={() => open(i)}>Edit</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <SidePanel title={edit === 'new' ? 'New product or service' : `Edit ${edit.name}`} onClose={() => setEdit(null)}
          footer={<>{edit !== 'new' && <Button variant="ghost" className="mr-auto" onClick={() => void save({ isActive: !edit.isActive })}>{edit.isActive ? 'Make inactive' : 'Make active'}</Button>}<Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={() => void save()} disabled={!f.name.trim()}>Save</Button></>}>
          <FormError message={err} />
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Type">
            {(['SERVICE', 'NON_INVENTORY'] as const).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={f.type === t} onClick={() => setF({ ...f, type: t })} className={`rounded-md border p-3 text-left text-sm ${f.type === t ? 'border-primary bg-accent' : 'hover:bg-accent/50'}`}>
                <div className="font-medium">{t === 'SERVICE' ? 'Service' : 'Non-inventory'}</div>
                <div className="text-xs text-muted-foreground">{t === 'SERVICE' ? 'Work you do or hours you bill.' : 'Products you sell without tracking quantities.'}</div>
              </button>
            ))}
          </div>
          <Field label="Name" htmlFor="i-name"><Input id="i-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="SKU" htmlFor="i-sku"><Input id="i-sku" value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></Field>
          <Field label="Sales description" htmlFor="i-desc" hint="Appears on invoices and sales receipts"><Input id="i-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Sales price / rate" htmlFor="i-rate"><Input id="i-rate" inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></Field>
            <Field label="Sales tax" htmlFor="i-tax"><Select id="i-tax" value={f.taxCodeId} onChange={(e) => setF({ ...f, taxCodeId: e.target.value })}><option value="">Choose on each sale</option>{(taxCodes ?? []).map((t) => <option key={t.id} value={t.id}>{t.code} · {t.name}</option>)}</Select></Field>
          </div>
          <Field label="Income account" htmlFor="i-inc"><Select id="i-inc" value={f.incomeAccountId || income[0]?.id || ''} onChange={(e) => setF({ ...f, incomeAccountId: e.target.value })}>{income.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
        </SidePanel>
      )}
    </div>
  );
}
export default function ProductsPage() {
  return <Suspense><Products /></Suspense>;
}
