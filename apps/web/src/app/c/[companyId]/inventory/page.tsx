'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import type { Account } from '@/components/sales/common';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui/card';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney, today, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Valuation { asOf: string; rows: { itemId: string; name: string; sku: string | null; qtyOnHand: string; avgCost: string; value: string; reorderPoint: string | null; low: boolean }[]; total: string; ledgerBalance: string; difference: string; reconciled: boolean }
interface Move { id: string; date: string; item: string; sourceType: string; quantity: string; value: string; qtyAfter: string; avgCostAfter: string; memo: string | null }
const SOURCE: Record<string, string> = { bill: 'Bill', vendor_credit: 'Supplier credit', invoice: 'Invoice', credit_note: 'Credit note', sales_receipt: 'Sales receipt', adjustment: 'Adjustment', reversal: 'Void' };

/** Inventory: valuation (checked against the ledger), adjustments and stock movements. */
function Inventory() {
  const { companyId, can } = useCompany();
  const params = useSearchParams();
  const base = `/companies/${companyId}`;
  const [asOf, setAsOf] = useState(today());
  const { data, reload, error } = useApi<Valuation>(`${base}/inventory/valuation?asOf=${asOf}`);
  const { data: moves, reload: reloadMoves } = useApi<Move[]>(`${base}/inventory/detail?from=${today().slice(0, 4)}-01-01&to=${today()}`);
  const { data: accounts } = useApi<Account[]>(can('accounts:view') ? `${base}/accounts` : null);
  // Expense accounts first (shrinkage, damage); equity for opening stock.
  const offset = [...(accounts ?? []).filter((a) => !a.role && a.type === 'EXPENSE'), ...(accounts ?? []).filter((a) => !a.role && a.type === 'EQUITY')];
  const [f, setF] = useState({ itemId: params.get('item') ?? '', date: today(), quantityChange: '', valueChange: '', accountId: '', memo: '' });
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  async function adjust() {
    setErr(null); setMsg(null);
    try {
      const r = await api<{ qtyOnHand: string; value: string }>(`${base}/inventory/adjustments`, { method: 'POST', body: { itemId: f.itemId, date: f.date, quantityChange: f.quantityChange || '0', ...(f.valueChange ? { valueChange: f.valueChange } : {}), accountId: f.accountId || offset[0]?.id, ...(f.memo ? { memo: f.memo } : {}) } });
      setMsg(`Adjusted: ${Number(r.qtyOnHand)} on hand, valued at ${fmtMoney(r.value)}.`); setF({ ...f, quantityChange: '', valueChange: '', memo: '' }); await reload(); await reloadMoves();
    } catch (x) { setErr(errorMessage(x)); }
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>
        <div className="ml-auto"><Field label="As of" htmlFor="iv-asof"><Input id="iv-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field></div>
      </div>
      <FormError message={err ?? (error ? errorMessage(error) : null)} />
      {msg && <p role="status" className="rounded-md border border-primary/30 bg-accent px-3 py-2 text-sm">{msg}</p>}
      {data && data.rows.length === 0 ? <Card><EmptyState title="No inventory items">Create a product of type Inventory under Sales → Products & services. Quantities then move with bills, invoices and sales receipts.</EmptyState></Card> : data && (
        <Card>
          <CardHeader><CardTitle>Inventory valuation summary · weighted-average cost</CardTitle></CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground"><tr><th className="py-2">Product</th><th>SKU</th><th className="text-right">Qty on hand</th><th className="text-right">Avg. cost</th><th className="text-right">Asset value</th><th /></tr></thead>
              <tbody>{data.rows.map((r) => <tr key={r.itemId} className="border-t"><td className="py-2 font-medium">{r.name}</td><td className="font-mono text-xs">{r.sku}</td><td className="text-right tabular-nums">{Number(r.qtyOnHand)}</td><td className="text-right tabular-nums">{fmtMoney(r.avgCost)}</td><td className="text-right tabular-nums">{fmtMoney(r.value)}</td><td className="pl-3">{r.low && <Badge tone="warning">low stock</Badge>}</td></tr>)}</tbody>
              <tfoot><tr className="border-t font-semibold"><td className="py-2" colSpan={4}>Total</td><td className="text-right tabular-nums">{fmtMoney(data.total)}</td><td /></tr></tfoot>
            </table>
            <p className="mt-3 text-sm">{data.reconciled ? <Badge tone="success">Agrees with the ledger</Badge> : <Badge tone="danger">Differs from the ledger by {fmtMoney(data.difference)}</Badge>} <span className="text-muted-foreground">Inventory asset accounts: {fmtMoney(data.ledgerBalance)}. A difference means an entry was posted to an inventory account directly (e.g. a journal entry).</span></p>
          </CardContent>
        </Card>
      )}
      {can('journal:post') && data && data.rows.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Adjust quantity or value</CardTitle></CardHeader>
          <CardContent>
            <form className="grid gap-4 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); void adjust(); }}>
              <Field label="Product" htmlFor="ad-item"><Select id="ad-item" required value={f.itemId} onChange={(e) => setF({ ...f, itemId: e.target.value })}><option value="">Select…</option>{data.rows.map((r) => <option key={r.itemId} value={r.itemId}>{r.name}</option>)}</Select></Field>
              <Field label="Date" htmlFor="ad-date"><Input id="ad-date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
              <Field label="Offset account" htmlFor="ad-acct" hint="e.g. an Inventory shrinkage expense, or equity for opening stock"><Select id="ad-acct" value={f.accountId || offset[0]?.id || ''} onChange={(e) => setF({ ...f, accountId: e.target.value })}>{offset.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
              <Field label="Change in quantity" htmlFor="ad-qty" hint="Negative to remove (e.g. -2)"><Input id="ad-qty" inputMode="decimal" value={f.quantityChange} onChange={(e) => setF({ ...f, quantityChange: e.target.value })} /></Field>
              <Field label="Change in value (optional)" htmlFor="ad-val" hint="Blank = quantity × average cost. For opening stock, its total cost."><Input id="ad-val" inputMode="decimal" value={f.valueChange} onChange={(e) => setF({ ...f, valueChange: e.target.value })} /></Field>
              <Field label="Memo" htmlFor="ad-memo"><Input id="ad-memo" value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} /></Field>
              <div className="sm:col-span-3"><Button type="submit" disabled={!f.itemId}>Post adjustment</Button></div>
            </form>
          </CardContent>
        </Card>
      )}
      {moves && moves.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Stock movements this year</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground"><tr><th className="py-2">Date</th><th>Product</th><th>Source</th><th className="text-right">Qty</th><th className="text-right">Value</th><th className="text-right">On hand after</th><th className="text-right">Avg. cost after</th></tr></thead>
              <tbody>{moves.map((m) => <tr key={m.id} className="border-t"><td className="py-1.5">{m.date}</td><td>{m.item}</td><td>{SOURCE[m.sourceType] ?? m.sourceType}{m.memo ? ` · ${m.memo}` : ''}</td><td className="text-right tabular-nums">{Number(m.quantity)}</td><td className="text-right tabular-nums">{fmtMoney(m.value)}</td><td className="text-right tabular-nums">{Number(m.qtyAfter)}</td><td className="text-right tabular-nums">{fmtMoney(m.avgCostAfter)}</td></tr>)}</tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
export default function InventoryPage() {
  return <Suspense><Inventory /></Suspense>;
}
