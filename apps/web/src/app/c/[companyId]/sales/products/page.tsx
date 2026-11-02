'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { SalesHeader, SidePanel, type Account } from '@/components/sales/common';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Item { id: string; name: string; sku: string | null; type: 'SERVICE' | 'NON_INVENTORY'; description: string | null; rate: string | null; incomeAccountId: string; taxCodeId: string | null; isActive: boolean; incomeAccount: { code: string; name: string }; taxCode: { code: string } | null; trackInventory: boolean; qtyOnHand: string; avgCost: string; reorderPoint: string | null; purchaseCost: string | null; purchaseDescription: string | null; inventoryAccountId: string | null; cogsAccountId: string | null }
type Kind = 'SERVICE' | 'NON_INVENTORY' | 'INVENTORY';
interface TaxCode { id: string; code: string; name: string }
const empty = { name: '', sku: '', type: 'SERVICE' as Kind, description: '', rate: '', incomeAccountId: '', taxCodeId: '', purchaseCost: '', purchaseDescription: '', reorderPoint: '', inventoryAccountId: '', cogsAccountId: '' };
const KINDS: [Kind, string, string][] = [['SERVICE', 'Service', 'Work you do or hours you bill.'], ['NON_INVENTORY', 'Non-inventory', 'Products you sell without tracking quantities.'], ['INVENTORY', 'Inventory', 'Products you buy and sell, with quantity on hand and cost of goods sold.']];

function Products() {
  const { companyId, can } = useCompany();
  const params = useSearchParams();
  const [showInactive, setShowInactive] = useState(false);
  const { data, reload } = useApi<Item[]>(`/companies/${companyId}/items${showInactive ? '?all=true' : ''}`);
  const { data: accounts } = useApi<Account[]>(can('accounts:view') ? `/companies/${companyId}/accounts` : null);
  const { data: taxCodes } = useApi<TaxCode[]>(can('taxes:view') ? `/companies/${companyId}/tax-codes` : null);
  const income = (accounts ?? []).filter((a) => a.type === 'REVENUE' && !a.role);
  const assets = (accounts ?? []).filter((a) => a.type === 'ASSET' && !a.role);
  const expense = (accounts ?? []).filter((a) => a.type === 'EXPENSE' && !a.role);
  const pickCode = (list: typeof assets, code: string) => list.find((a) => a.code === code)?.id ?? list[0]?.id ?? '';
  const [edit, setEdit] = useState<Item | 'new' | null>(null);
  const [f, setF] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (params.get('new') === '1' && can('sales:create')) open('new'); }, []);
  function open(i: Item | 'new') {
    setErr(null); setEdit(i);
    setF(i === 'new' ? empty : { name: i.name, sku: i.sku ?? '', type: i.trackInventory ? 'INVENTORY' : i.type, description: i.description ?? '', rate: i.rate ? String(i.rate) : '', incomeAccountId: i.incomeAccountId, taxCodeId: i.taxCodeId ?? '', purchaseCost: i.purchaseCost ? String(i.purchaseCost) : '', purchaseDescription: i.purchaseDescription ?? '', reorderPoint: i.reorderPoint ? String(Number(i.reorderPoint)) : '', inventoryAccountId: i.inventoryAccountId ?? '', cogsAccountId: i.cogsAccountId ?? '' });
  }
  async function save(extra: object = {}) {
    setErr(null);
    const inv = f.type === 'INVENTORY';
    const body = {
      name: f.name, type: inv ? 'NON_INVENTORY' : f.type, sku: f.sku || null, description: f.description || null, rate: f.rate || null, incomeAccountId: f.incomeAccountId || income[0]?.id, taxCodeId: f.taxCodeId || null,
      purchaseCost: f.purchaseCost || null, purchaseDescription: f.purchaseDescription || null, reorderPoint: inv ? f.reorderPoint || null : null,
      ...(edit === 'new' && inv ? { trackInventory: true, inventoryAccountId: f.inventoryAccountId || pickCode(assets, '1200'), cogsAccountId: f.cogsAccountId || pickCode(expense, '5000') } : {}),
      ...extra,
    };
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
          <thead className="border-b bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-3 py-2.5">Name</th><th className="px-3 py-2.5">SKU</th><th className="px-3 py-2.5">Type</th><th className="px-3 py-2.5">Sales description</th><th className="px-3 py-2.5">Income account</th><th className="px-3 py-2.5">Tax</th><th className="px-3 py-2.5 text-right">Sales price</th><th className="px-3 py-2.5 text-right">Qty on hand</th><th className="px-3 py-2.5 text-right">Action</th></tr></thead>
          <tbody>
            {data && data.length === 0 && <tr><td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">No products or services yet. Add the things you sell so invoices and receipts fill themselves in.</td></tr>}
            {(data ?? []).map((i) => (
              <tr key={i.id} className="border-b last:border-0 hover:bg-accent/50">
                <td className="px-3 py-2.5 font-medium">{i.name}{!i.isActive && <span className="ml-2 text-xs text-muted-foreground">(inactive)</span>}</td>
                <td className="px-3 py-2.5 font-mono text-xs">{i.sku}</td>
                <td className="px-3 py-2.5">{i.trackInventory ? 'Inventory' : i.type === 'SERVICE' ? 'Service' : 'Non-inventory'}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{i.description}</td>
                <td className="px-3 py-2.5">{i.incomeAccount.code} · {i.incomeAccount.name}</td>
                <td className="px-3 py-2.5 font-mono text-xs">{i.taxCode?.code}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{i.rate ? fmtMoney(String(i.rate)) : ''}</td>
                <td className={`px-3 py-2.5 text-right tabular-nums ${i.trackInventory && i.reorderPoint !== null && Number(i.qtyOnHand) <= Number(i.reorderPoint) ? 'font-semibold text-orange-600' : ''}`}>{i.trackInventory ? Number(i.qtyOnHand).toString() : ''}</td>
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
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Type">
            {KINDS.map(([t, label, hint]) => {
              // Quantity tracking is chosen once, when the product is created (the ledger and the stock records must agree).
              const locked = edit !== 'new' && (t === 'INVENTORY') !== (f.type === 'INVENTORY');
              return (
                <button key={t} type="button" role="radio" aria-checked={f.type === t} disabled={locked} onClick={() => setF({ ...f, type: t })} className={`rounded-md border p-3 text-left text-sm disabled:opacity-40 ${f.type === t ? 'border-primary bg-accent' : 'hover:bg-accent/50'}`}>
                  <div className="font-medium">{label}</div>
                  <div className="text-xs text-muted-foreground">{hint}</div>
                </button>
              );
            })}
          </div>
          <Field label="Name" htmlFor="i-name"><Input id="i-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="SKU" htmlFor="i-sku"><Input id="i-sku" value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></Field>
          <Field label="Sales description" htmlFor="i-desc" hint="Appears on invoices and sales receipts"><Input id="i-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Sales price / rate" htmlFor="i-rate"><Input id="i-rate" inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></Field>
            <Field label="Sales tax" htmlFor="i-tax"><Select id="i-tax" value={f.taxCodeId} onChange={(e) => setF({ ...f, taxCodeId: e.target.value })}><option value="">Choose on each sale</option>{(taxCodes ?? []).map((t) => <option key={t.id} value={t.id}>{t.code} · {t.name}</option>)}</Select></Field>
          </div>
          <Field label="Income account" htmlFor="i-inc"><Select id="i-inc" value={f.incomeAccountId || income[0]?.id || ''} onChange={(e) => setF({ ...f, incomeAccountId: e.target.value })}>{income.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
          {f.type !== 'SERVICE' && <>
            <h3 className="pt-2 text-sm font-semibold">Purchasing</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Cost" htmlFor="i-cost"><Input id="i-cost" inputMode="decimal" value={f.purchaseCost} onChange={(e) => setF({ ...f, purchaseCost: e.target.value })} /></Field>
              <Field label="Purchase description" htmlFor="i-pdesc"><Input id="i-pdesc" value={f.purchaseDescription} onChange={(e) => setF({ ...f, purchaseDescription: e.target.value })} /></Field>
            </div>
          </>}
          {f.type === 'INVENTORY' && <>
            <h3 className="pt-2 text-sm font-semibold">Inventory</h3>
            {edit !== 'new' && <p className="text-sm">On hand: <strong>{Number(edit.qtyOnHand).toString()}</strong> at an average cost of {fmtMoney(Number(edit.avgCost).toFixed(2))}. <a className="text-primary hover:underline" href={`/c/${companyId}/inventory?item=${edit.id}`}>Adjust quantity</a></p>}
            <Field label="Reorder point" htmlFor="i-reorder" hint="Listed as low stock at or below this quantity"><Input id="i-reorder" inputMode="decimal" value={f.reorderPoint} onChange={(e) => setF({ ...f, reorderPoint: e.target.value })} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Inventory asset account" htmlFor="i-asset"><Select id="i-asset" disabled={edit !== 'new'} value={f.inventoryAccountId || pickCode(assets, '1200')} onChange={(e) => setF({ ...f, inventoryAccountId: e.target.value })}>{assets.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
              <Field label="Cost of goods sold account" htmlFor="i-cogs"><Select id="i-cogs" disabled={edit !== 'new'} value={f.cogsAccountId || pickCode(expense, '5000')} onChange={(e) => setF({ ...f, cogsAccountId: e.target.value })}>{expense.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
            </div>
            {edit === 'new' && <p className="text-xs text-muted-foreground">Stock comes in on bills (at cost) and leaves on invoices and sales receipts at the weighted-average cost. For stock you already have, add an opening quantity on the Inventory page after saving.</p>}
          </>}
        </SidePanel>
      )}
    </div>
  );
}
export default function ProductsPage() {
  return <Suspense><Products /></Suspense>;
}
