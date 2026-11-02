'use client';
import { Mail, Printer, Repeat, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FormError, Input, Select } from '@/components/ui/form';
import { StatusPill, type Account } from '@/components/sales/common';
import { SendDialog } from '@/components/shared/send-dialog';
import { RecurringDialog } from '@/components/shared/recurring-dialog';
import { useTracking } from '@/components/shared/tracking';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney, today, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';

export type PurchaseKind = 'bill' | 'credit' | 'po';
interface Contact { id: string; name: string; email: string | null; kind: string }
interface Item { id: string; name: string; purchaseDescription: string | null; description: string | null; purchaseCost: string | null; taxCodeId: string | null; trackInventory: boolean; inventoryAccountId: string | null }
interface TaxCode { id: string; code: string; rates: { component: string; rate: string; recoverable: boolean; effectiveFrom: string; effectiveTo: string | null }[] }
interface SavedLine { itemId: string | null; description: string; quantity: string; unitPrice: string; accountId: string; taxCodeId: string; classId: string | null; projectId: string | null; billable?: boolean; billableToId?: string | null }
interface Saved { id: string; number: string | null; status: string; kind?: string; contactId: string; issueDate: string; dueDate?: string; expectedDate?: string | null; supplierRef?: string | null; shipTo?: string | null; message?: string | null; memo: string | null; taxInclusive: boolean; subtotal: string; taxTotal: string; total: string; amountPaid?: string; billId?: string | null; locationId?: string | null; lines: SavedLine[]; contact: { name: string } }
interface Line { key: number; itemId: string; accountId: string; description: string; quantity: string; rate: string; taxCodeId: string; classId: string; projectId: string; billableToId: string }

const DEFAULT_CODE: Record<string, string> = { ON: 'HST_ON', NS: 'HST_NS', NB: 'HST_NB', NL: 'HST_NL', PE: 'HST_PE', QC: 'GST_QST', BC: 'GST_PST_BC', SK: 'GST_PST_SK', MB: 'GST_PST_MB' };
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const cents = (v: string) => Math.round(parseFloat(v || '0') * 100) || 0;
const areaCls = 'w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
let seq = 0;

/** Bills, supplier credits and purchase orders: the full-page editor (same layout as invoices). */
export function PurchaseForm({ kind, id }: { kind: PurchaseKind; id?: string }) {
  const { companyId, can, me } = useCompany();
  const router = useRouter();
  const base = `/companies/${companyId}`;
  const po = kind === 'po';
  const path = po ? 'purchase-orders' : 'bills';
  const listHref = `/c/${companyId}/${po ? 'purchases/orders' : 'purchases'}`;
  const { data: saved, reload } = useApi<Saved>(id ? `${base}/${path}/${id}` : null);
  const { data: vendors, reload: reloadVendors } = useApi<Contact[]>(`${base}/contacts?kind=VENDOR`);
  const { data: customers } = useApi<Contact[]>(`${base}/contacts?kind=CUSTOMER`);
  const { data: items } = useApi<Item[]>(`${base}/items`);
  const { data: accounts } = useApi<Account[]>(can('accounts:view') ? `${base}/accounts` : null);
  const { data: taxCodes } = useApi<TaxCode[]>(can('taxes:view') ? `${base}/tax-codes` : null);
  const tracking = useTracking(companyId, { projects: can('sales:view') });
  const cost = (accounts ?? []).filter((a) => (a.type === 'EXPENSE' || a.type === 'ASSET') && !a.role && !(a as Account & { special?: string | null }).special);
  const province = me.companies.find((c) => c.id === companyId)?.province ?? '';
  const defaultTax = (taxCodes ?? []).find((t) => t.code === (DEFAULT_CODE[province] ?? 'GST'))?.id ?? '';
  const defaultAccount = cost.find((a) => a.code === '6050')?.id ?? cost.find((a) => a.type === 'EXPENSE')?.id ?? '';

  const isCredit = kind === 'credit' || saved?.kind === 'CREDIT';
  const title = po ? 'Purchase order' : isCredit ? 'Supplier credit' : 'Bill';
  const editable = !saved || (po ? saved.status === 'OPEN' : saved.status === 'DRAFT');
  const ro = !editable;
  const blank = (): Line => ({ key: ++seq, itemId: '', accountId: defaultAccount, description: '', quantity: '1', rate: '', taxCodeId: defaultTax, classId: '', projectId: '', billableToId: '' });

  const [contactId, setContactId] = useState('');
  const [issueDate, setIssueDate] = useState(today());
  const [dueDate, setDueDate] = useState(addDays(today(), 30));
  const [expectedDate, setExpectedDate] = useState('');
  const [supplierRef, setSupplierRef] = useState('');
  const [shipTo, setShipTo] = useState('');
  const [message, setMessage] = useState('');
  const [memo, setMemo] = useState('');
  const [inclusive, setInclusive] = useState(false);
  const [locationId, setLocationId] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | 'send' | 'recurring' | 'pay'>(null);
  const [newVendor, setNewVendor] = useState<string | null>(null);
  async function addVendor() {
    if (!newVendor?.trim()) return;
    try { const c = await api<Contact>(`${base}/contacts`, { method: 'POST', body: { kind: 'VENDOR', name: newVendor.trim() } }); await reloadVendors(); setContactId(c.id); setNewVendor(null); } catch (x) { setErr(errorMessage(x)); }
  }

  useEffect(() => { if (!id && !lines.length && taxCodes && accounts) setLines([blank(), blank()]); }, [taxCodes, accounts]);
  useEffect(() => {
    if (!saved) return;
    setContactId(saved.contactId); setIssueDate(saved.issueDate.slice(0, 10)); setMemo(saved.memo ?? ''); setInclusive(saved.taxInclusive); setLocationId(saved.locationId ?? '');
    if (po) { setExpectedDate(saved.expectedDate?.slice(0, 10) ?? ''); setShipTo(saved.shipTo ?? ''); setMessage(saved.message ?? ''); }
    else { setDueDate(saved.dueDate!.slice(0, 10)); setSupplierRef(saved.supplierRef ?? ''); }
    setLines(saved.lines.map((l) => ({ key: ++seq, itemId: l.itemId ?? '', accountId: l.accountId, description: l.description, quantity: String(Number(l.quantity)), rate: Number(l.unitPrice).toFixed(2), taxCodeId: l.taxCodeId, classId: l.classId ?? '', projectId: l.projectId ?? '', billableToId: l.billable ? l.billableToId ?? '' : '' })));
  }, [saved, po]);

  const setLine = (k: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  function pickItem(k: number, itemId: string) {
    const it = (items ?? []).find((i) => i.id === itemId);
    if (!it) { setLine(k, { itemId: '' }); return; }
    setLine(k, { itemId, description: it.purchaseDescription ?? it.description ?? it.name, rate: it.purchaseCost ? Number(it.purchaseCost).toFixed(2) : '', ...(it.taxCodeId ? { taxCodeId: it.taxCodeId } : {}), ...(it.trackInventory && it.inventoryAccountId ? { accountId: it.inventoryAccountId } : {}) });
  }
  const tracked = (l: Line) => (items ?? []).find((i) => i.id === l.itemId)?.trackInventory ?? false;

  const est = useMemo(() => {
    const rateOf = (codeId: string) => (taxCodes ?? []).find((t) => t.id === codeId)?.rates.filter((r) => r.effectiveFrom.slice(0, 10) <= issueDate && (!r.effectiveTo || r.effectiveTo.slice(0, 10) >= issueDate)) ?? [];
    let sub = 0, tax = 0;
    for (const l of lines) {
      const amt = Math.round(cents(l.rate) * parseFloat(l.quantity || '0'));
      if (!amt) continue;
      const total = rateOf(l.taxCodeId).reduce((s, r) => s + parseFloat(r.rate), 0);
      const net = inclusive ? Math.round(amt / (1 + total)) : amt;
      sub += net; tax += Math.round(net * total);
    }
    return { sub, tax, total: sub + tax };
  }, [lines, taxCodes, issueDate, inclusive]);
  const money = (c: number) => fmtMoney((c / 100).toFixed(2));
  const showSaved = !!saved && ro;
  const totalC = showSaved ? cents(saved!.total) : est.total;
  const balanceC = showSaved && !po && !isCredit ? cents(saved!.total) - cents(saved!.amountPaid ?? '0') : totalC;

  function linePayload() {
    return lines.filter((l) => l.description.trim() || l.rate).map((l) => ({
      description: l.description.trim() || 'Purchase', quantity: l.quantity || '1', unitPrice: l.rate || '0', accountId: l.accountId || defaultAccount, taxCodeId: l.taxCodeId || defaultTax,
      ...(l.itemId ? { itemId: l.itemId } : {}), ...(l.classId ? { classId: l.classId } : {}), ...(l.projectId ? { projectId: l.projectId } : {}),
      ...(!po && l.billableToId ? { billable: true, billableToId: l.billableToId } : {}),
    }));
  }
  function payload() {
    const common = { contactId, issueDate, taxInclusive: inclusive, lines: linePayload(), ...(memo.trim() ? { memo: memo.trim() } : {}) };
    if (po) return { ...common, ...(expectedDate ? { expectedDate } : {}), ...(shipTo.trim() ? { shipTo: shipTo.trim() } : {}), ...(message.trim() ? { message: message.trim() } : {}) };
    return { ...common, dueDate: isCredit ? issueDate : dueDate, kind: isCredit ? 'CREDIT' : 'STANDARD', ...(supplierRef.trim() ? { supplierRef: supplierRef.trim() } : {}), ...(locationId ? { locationId } : {}) };
  }
  async function save(post: boolean) {
    setErr(null);
    if (!contactId) { setErr('Choose a supplier.'); return; }
    if (!linePayload().length) { setErr('Add at least one line.'); return; }
    setBusy(true);
    try {
      let docId = id;
      if (id) await api(`${base}/${path}/${id}`, { method: 'PUT', body: payload() });
      else docId = (await api<{ id: string }>(`${base}/${path}`, { method: 'POST', body: payload() })).id;
      if (post && !po) await api(`${base}/bills/${docId}/post`, { method: 'POST' });
      router.replace(`${listHref}/${docId}`);
      if (docId === id) await reload();
    } catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  }
  async function act(fn: () => Promise<unknown>, done?: string) { setErr(null); setNotice(null); try { await fn(); await reload(); if (done) setNotice(done); } catch (x) { setErr(errorMessage(x)); } }
  async function voidDoc() {
    if (!saved || !window.confirm(saved.status === 'DRAFT' ? 'Delete this draft?' : `Void ${title.toLowerCase()} ${saved.number}?`)) return;
    try {
      await api(`${base}/${path}/${saved.id}/void`, { method: 'POST' });
      if (saved.status === 'DRAFT') router.replace(listHref); else await reload();
    } catch (x) { setErr(errorMessage(x)); }
  }
  const state = !saved ? null : saved.status === 'DRAFT' ? 'draft' : saved.status === 'VOID' ? 'void' : saved.status === 'PAID' || saved.status === 'CLOSED' ? 'paid' : 'open';
  const label = !saved ? '' : po ? { OPEN: 'Open', CLOSED: 'Closed', VOID: 'Voided' }[saved.status] ?? saved.status : { DRAFT: 'Draft', POSTED: 'Open', PARTIAL: 'Partially paid', PAID: 'Paid', VOID: 'Voided' }[saved.status] ?? saved.status;
  const showClass = tracking.classes.length > 0, showProject = tracking.projects.length > 0;
  const recurringPayload = () => { const p = payload() as Record<string, unknown>; delete p.issueDate; delete p.dueDate; return p; };

  return (
    <div className="-m-4 flex min-h-[calc(100vh-3.5rem)] flex-col bg-background sm:-m-6">
      <div className="flex items-center gap-3 border-b bg-card px-6 py-3">
        <h1 className="text-xl font-semibold">{title}{saved?.number ? <span className="ml-2 font-mono text-base text-muted-foreground">{saved.number}</span> : <span className="ml-2 text-base font-normal text-muted-foreground">{saved ? 'draft' : 'new'}</span>}</h1>
        {state && <StatusPill row={{ state, status: label }} />}
        <button onClick={() => router.push(listHref)} className="ml-auto rounded p-1.5 hover:bg-accent" aria-label="Close"><X className="h-5 w-5" /></button>
      </div>
      <div className="flex-1 space-y-6 p-6">
        <FormError message={err} />
        {notice && <p role="status" className="rounded-md border border-primary/30 bg-accent px-3 py-2 text-sm">{notice}</p>}
        {po && saved?.billId && <p className="rounded-md border bg-card px-3 py-2 text-sm">Converted to a bill. <Link className="font-medium text-primary hover:underline" href={`/c/${companyId}/purchases/${saved.billId}`}>Open the bill</Link></p>}
        <div className="flex flex-wrap items-start gap-6">
          <div className="grid flex-1 gap-4 sm:grid-cols-2 lg:max-w-2xl">
            <label className="block space-y-1.5 text-sm"><span className="font-medium">Supplier</span>
              {newVendor !== null ? (
                <span className="flex gap-2"><Input autoFocus aria-label="New supplier name" placeholder="Supplier name" value={newVendor} onChange={(e) => setNewVendor(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addVendor(); } }} /><Button type="button" size="sm" onClick={() => void addVendor()}>Add</Button><Button type="button" size="sm" variant="ghost" onClick={() => setNewVendor(null)}>Cancel</Button></span>
              ) : (
                <Select aria-label="Supplier" disabled={ro} value={contactId} onChange={(e) => (e.target.value === '__new' ? setNewVendor('') : setContactId(e.target.value))}><option value="">Choose a supplier</option>{can('purchases:create') && <option value="__new">+ Add new supplier</option>}{(vendors ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
              )}
            </label>
            {!po && <label className="block space-y-1.5 text-sm"><span className="font-medium">{isCredit ? 'Supplier credit no.' : 'Bill no. (from the supplier)'}</span><Input disabled={ro} value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} /></label>}
          </div>
          <div className="ml-auto text-right">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{po ? 'Amount' : isCredit ? 'Credit amount' : 'Balance due'}</div>
            <div className="text-4xl font-semibold tabular-nums">{money(po || isCredit ? totalC : balanceC)}</div>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {po && <label className="block space-y-1.5 text-sm lg:row-span-2"><span className="font-medium">Ship to</span><textarea rows={4} disabled={ro} className={areaCls} value={shipTo} onChange={(e) => setShipTo(e.target.value)} placeholder="Your address (default)" /></label>}
          <label className="block space-y-1.5 text-sm"><span className="font-medium">{po ? 'Order date' : isCredit ? 'Credit date' : 'Bill date'}</span><Input type="date" disabled={ro} value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></label>
          {!po && !isCredit && <label className="block space-y-1.5 text-sm"><span className="font-medium">Due date</span><Input type="date" disabled={ro} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>}
          {po && <label className="block space-y-1.5 text-sm"><span className="font-medium">Expected date</span><Input type="date" disabled={ro} value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} /></label>}
          {!po && tracking.locations.length > 0 && <label className="block space-y-1.5 text-sm"><span className="font-medium">Location</span><Select disabled={ro} value={locationId} onChange={(e) => setLocationId(e.target.value)}><option value="">None</option>{tracking.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></label>}
          <label className="block space-y-1.5 text-sm"><span className="font-medium">Amounts are</span><Select disabled={ro} value={inclusive ? 'in' : 'ex'} onChange={(e) => setInclusive(e.target.value === 'in')}><option value="ex">Exclusive of tax</option><option value="in">Inclusive of tax</option></Select></label>
        </div>

        <div className="overflow-x-auto rounded-md border bg-card shadow-sm">
          <table className="w-full min-w-[64rem] text-sm">
            <thead className="border-b bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr><th className="w-8 px-2 py-2.5">#</th><th className="w-48 px-2 py-2.5">Product/service</th><th className="w-52 px-2 py-2.5">Account</th><th className="px-2 py-2.5">Description</th><th className="w-20 px-2 py-2.5 text-right">Qty</th><th className="w-28 px-2 py-2.5 text-right">Cost</th><th className="w-28 px-2 py-2.5 text-right">Amount</th><th className="w-32 px-2 py-2.5">Tax</th>{!po && <th className="w-40 px-2 py-2.5">Billable to</th>}{showClass && <th className="w-32 px-2 py-2.5">Class</th>}{showProject && <th className="w-36 px-2 py-2.5">Project</th>}<th className="w-8" /></tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const amt = Math.round(cents(l.rate) * parseFloat(l.quantity || '0'));
                return (
                  <tr key={l.key} className="border-b align-top last:border-0">
                    <td className="px-2 py-2 text-muted-foreground">{i + 1}</td>
                    <td className="px-2 py-1.5"><Select aria-label={`Product, line ${i + 1}`} disabled={ro} value={l.itemId} onChange={(e) => pickItem(l.key, e.target.value)} className="h-8"><option value="">(none)</option>{(items ?? []).map((it) => <option key={it.id} value={it.id}>{it.name}{it.trackInventory ? ' (stock)' : ''}</option>)}</Select></td>
                    <td className="px-2 py-1.5"><Select aria-label={`Account, line ${i + 1}`} disabled={ro || tracked(l)} value={l.accountId} onChange={(e) => setLine(l.key, { accountId: e.target.value })} className="h-8">{cost.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></td>
                    <td className="px-2 py-1.5"><Input aria-label={`Description, line ${i + 1}`} disabled={ro} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} className="h-8" /></td>
                    <td className="px-2 py-1.5"><Input aria-label={`Quantity, line ${i + 1}`} inputMode="decimal" disabled={ro} value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} className="h-8 text-right" /></td>
                    <td className="px-2 py-1.5"><Input aria-label={`Cost, line ${i + 1}`} inputMode="decimal" disabled={ro} value={l.rate} onChange={(e) => setLine(l.key, { rate: e.target.value })} className="h-8 text-right" /></td>
                    <td className="px-2 py-2 text-right tabular-nums">{amt ? money(amt) : ''}</td>
                    <td className="px-2 py-1.5"><Select aria-label={`Tax, line ${i + 1}`} disabled={ro} value={l.taxCodeId} onChange={(e) => setLine(l.key, { taxCodeId: e.target.value })} className="h-8">{(taxCodes ?? []).map((t) => <option key={t.id} value={t.id}>{t.code}</option>)}</Select></td>
                    {!po && <td className="px-2 py-1.5"><Select aria-label={`Billable to, line ${i + 1}`} disabled={ro} value={l.billableToId} onChange={(e) => setLine(l.key, { billableToId: e.target.value })} className="h-8"><option value="">Not billable</option>{(customers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></td>}
                    {showClass && <td className="px-2 py-1.5"><Select aria-label={`Class, line ${i + 1}`} disabled={ro} value={l.classId} onChange={(e) => setLine(l.key, { classId: e.target.value })} className="h-8"><option value="" />{tracking.classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></td>}
                    {showProject && <td className="px-2 py-1.5"><Select aria-label={`Project, line ${i + 1}`} disabled={ro} value={l.projectId} onChange={(e) => setLine(l.key, { projectId: e.target.value })} className="h-8"><option value="" />{tracking.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></td>}
                    <td className="px-1 py-1.5">{!ro && <button type="button" aria-label={`Delete line ${i + 1}`} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [blank()]))}><Trash2 className="h-4 w-4" /></button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!ro && <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, blank()])}>Add lines</Button>}
        <div className="flex flex-wrap gap-8">
          <div className="flex-1 space-y-4 lg:max-w-xl">
            {po && <label className="block space-y-1.5 text-sm"><span className="font-medium">Message to supplier</span><textarea rows={3} disabled={ro} className={areaCls} value={message} onChange={(e) => setMessage(e.target.value)} /></label>}
            <label className="block space-y-1.5 text-sm"><span className="font-medium">Memo (internal)</span><textarea rows={2} disabled={ro} className={areaCls} value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
          </div>
          <dl className="ml-auto w-full max-w-sm space-y-2 text-sm">
            <div className="flex justify-between"><dt>Subtotal</dt><dd className="tabular-nums">{money(showSaved ? cents(saved!.subtotal) : est.sub)}</dd></div>
            <div className="flex justify-between text-muted-foreground"><dt>Tax</dt><dd className="tabular-nums">{money(showSaved ? cents(saved!.taxTotal) : est.tax)}</dd></div>
            <div className="flex justify-between border-t pt-2 text-base font-semibold"><dt>Total</dt><dd className="tabular-nums">{money(totalC)}</dd></div>
            {showSaved && !po && !isCredit && <div className="flex justify-between"><dt>Paid</dt><dd className="tabular-nums">{fmtMoney(saved!.amountPaid ?? '0')}</dd></div>}
          </dl>
        </div>
      </div>
      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t bg-sidebar px-6 py-3 text-sidebar-foreground">
        <Button variant="ghost" className="text-sidebar-foreground hover:bg-white/10 hover:text-white" onClick={() => router.push(listHref)}>{ro ? 'Close' : 'Cancel'}</Button>
        {saved && can('purchases:reverse') && (po ? saved.status === 'OPEN' : ['DRAFT', 'POSTED'].includes(saved.status)) && <Button variant="ghost" className="text-sidebar-foreground hover:bg-white/10 hover:text-white" onClick={() => void voidDoc()}>{saved.status === 'DRAFT' ? 'Delete' : 'Void'}</Button>}
        {!po && !isCredit && saved && can('purchases:create') && <Button variant="ghost" className="text-sidebar-foreground hover:bg-white/10 hover:text-white" onClick={() => setDialog('recurring')}><Repeat className="h-4 w-4" aria-hidden /> Make recurring</Button>}
        <div className="mx-auto flex items-center gap-1">
          {po && saved && <a href={`/api${base}/purchase-orders/${saved.id}/pdf`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-white/10 hover:text-white"><Printer className="h-4 w-4" aria-hidden /> Print or download</a>}
          {po && saved && saved.status !== 'VOID' && can('purchases:create') && <button type="button" onClick={() => setDialog('send')} className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-white/10 hover:text-white"><Mail className="h-4 w-4" aria-hidden /> Send</button>}
        </div>
        <div className="ml-auto flex gap-2">
          {po && saved?.status === 'OPEN' && can('purchases:create') && <Button variant="outline" className="border-white/30 bg-transparent text-white hover:bg-white/10 hover:text-white" onClick={() => void (async () => { try { const b = await api<{ id: string }>(`${base}/purchase-orders/${saved.id}/convert`, { method: 'POST', body: {} }); router.push(`/c/${companyId}/purchases/${b.id}`); } catch (x) { setErr(errorMessage(x)); } })()}>Convert to bill</Button>}
          {!po && ro && !isCredit && saved && ['POSTED', 'PARTIAL'].includes(saved.status) && can('purchases:post') && <Link href={`/c/${companyId}/purchases/pay?bill=${saved.id}`} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">Pay bill</Link>}
          {!ro && <Button variant={po ? 'default' : 'outline'} className={cn(!po && 'border-white/30 bg-transparent text-white hover:bg-white/10 hover:text-white')} disabled={busy} onClick={() => void save(false)}>{po ? (busy ? 'Saving…' : 'Save') : 'Save draft'}</Button>}
          {!ro && !po && can('purchases:post') && <Button disabled={busy} onClick={() => void save(true)}>{busy ? 'Saving…' : 'Save and post'}</Button>}
        </div>
      </div>
      {dialog === 'send' && saved && <SendDialog path={`${base}/purchase-orders/${saved.id}`} title={`Send purchase order ${saved.number}`} onClose={(sent) => { setDialog(null); if (sent) void act(async () => undefined, 'Sent.'); }} />}
      {dialog === 'recurring' && saved && <RecurringDialog companyId={companyId} kind="BILL" payload={recurringPayload()} defaultName={`${saved.contact.name} – monthly`} onClose={(ok) => { setDialog(null); if (ok) setNotice('Recurring schedule saved. Manage it under Sales → Recurring.'); }} />}
    </div>
  );
}
