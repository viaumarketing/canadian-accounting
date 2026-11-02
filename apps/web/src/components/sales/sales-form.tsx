'use client';
import { Printer, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FormError, Input, Select } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney, today, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';
import { ReceivePayment, StatusPill, type Account } from './common';

export type FormKind = 'invoice' | 'credit' | 'receipt';
interface Contact { id: string; name: string; email: string | null; billingAddress: string | null; defaultTerms: string | null }
interface Item { id: string; name: string; description: string | null; rate: string | null; incomeAccountId: string; taxCodeId: string | null }
interface TaxCode { id: string; code: string; name: string; rates: { component: string; rate: string; effectiveFrom: string; effectiveTo: string | null }[] }
interface SavedLine { itemId: string | null; serviceDate: string | null; description: string; quantity: string; unitPrice: string; accountId: string; taxCodeId: string; net: string; taxDetail: { component: string; rate: string; amount: string }[] }
interface SavedDoc {
  id: string; number: string | null; status: string; kind?: string; contactId: string; billingAddress: string | null; message: string | null; memo: string | null; taxInclusive: boolean;
  subtotal: string; taxTotal: string; total: string; amountPaid?: string; lines: SavedLine[];
  issueDate?: string; dueDate?: string; terms?: string | null; date?: string; paymentMethod?: string; referenceNo?: string | null; depositAccountId?: string; contact: { name: string };
}
interface Line { key: number; sel: string; serviceDate: string; description: string; quantity: string; rate: string; taxCodeId: string }

const TERMS: [string, string, number][] = [['DUE_ON_RECEIPT', 'Due on receipt', 0], ['NET_15', 'Net 15', 15], ['NET_30', 'Net 30', 30], ['NET_60', 'Net 60', 60]];
const METHODS: [string, string][] = [['CASH', 'Cash'], ['CHEQUE', 'Cheque'], ['CREDIT_CARD', 'Credit card'], ['DEBIT_CARD', 'Debit card'], ['E_TRANSFER', 'Interac e-Transfer'], ['OTHER', 'Other']];
const DEFAULT_CODE: Record<string, string> = { ON: 'HST_ON', NS: 'HST_NS', NB: 'HST_NB', NL: 'HST_NL', PE: 'HST_PE', QC: 'GST_QST', BC: 'GST_PST_BC', SK: 'GST_PST_SK', MB: 'GST_PST_MB' };
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
let seq = 0;
const blank = (taxCodeId = ''): Line => ({ key: ++seq, sel: '', serviceDate: '', description: '', quantity: '1', rate: '', taxCodeId });
/** Browser-side estimate only (integer cents); the server recomputes every amount when the document is saved. */
const cents = (v: string) => Math.round(parseFloat(v || '0') * 100) || 0;
const areaCls = 'w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function SalesForm({ kind, id, presetCustomer }: { kind: FormKind; id?: string; presetCustomer?: string | null }) {
  const { companyId, can, me } = useCompany();
  const router = useRouter();
  const base = `/companies/${companyId}`;
  const receipt = kind === 'receipt';
  const { data: saved, reload } = useApi<SavedDoc>(id ? `${base}/${receipt ? 'sales-receipts' : 'invoices'}/${id}` : null);
  const { data: contacts, reload: reloadContacts } = useApi<Contact[]>(`${base}/contacts?kind=CUSTOMER`);
  const { data: items } = useApi<Item[]>(`${base}/items`);
  const { data: accounts } = useApi<Account[]>(can('accounts:view') ? `${base}/accounts` : null);
  const { data: taxCodes } = useApi<TaxCode[]>(can('taxes:view') ? `${base}/tax-codes` : null);
  const income = (accounts ?? []).filter((a) => a.type === 'REVENUE' && !a.role);
  const depositAccounts = (accounts ?? []).filter((a) => a.type === 'ASSET' && !a.role);
  const province = me.companies.find((c) => c.id === companyId)?.province ?? '';
  const defaultTax = (taxCodes ?? []).find((t) => t.code === (DEFAULT_CODE[province] ?? 'GST'))?.id ?? '';

  const isCredit = kind === 'credit' || saved?.kind === 'CREDIT';
  const title = receipt ? 'Sales receipt' : isCredit ? 'Credit note' : 'Invoice';
  const editable = !saved || saved.status === 'DRAFT';

  const [contactId, setContactId] = useState(presetCustomer ?? '');
  const [billingAddress, setBillingAddress] = useState('');
  const [terms, setTerms] = useState('NET_30');
  const [issueDate, setIssueDate] = useState(today());
  const [dueDate, setDueDate] = useState(addDays(today(), 30));
  const [method, setMethod] = useState('E_TRANSFER');
  const [referenceNo, setReferenceNo] = useState('');
  const [depositId, setDepositId] = useState('');
  const [inclusive, setInclusive] = useState(false);
  const [lines, setLines] = useState<Line[]>([blank(), blank()]);
  const [message, setMessage] = useState('');
  const [memo, setMemo] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newCustomer, setNewCustomer] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  // Load a saved document into the form.
  useEffect(() => {
    if (!saved) return;
    setContactId(saved.contactId); setBillingAddress(saved.billingAddress ?? ''); setInclusive(saved.taxInclusive); setMessage(saved.message ?? ''); setMemo(saved.memo ?? '');
    if (receipt) { setIssueDate(saved.date!.slice(0, 10)); setMethod(saved.paymentMethod!); setReferenceNo(saved.referenceNo ?? ''); setDepositId(saved.depositAccountId!); }
    else { setIssueDate(saved.issueDate!.slice(0, 10)); setDueDate(saved.dueDate!.slice(0, 10)); setTerms(saved.terms ?? ''); }
    setLines(saved.lines.map((l) => ({ key: ++seq, sel: l.itemId ? `item:${l.itemId}` : `acct:${l.accountId}`, serviceDate: l.serviceDate?.slice(0, 10) ?? '', description: l.description, quantity: String(Number(l.quantity)), rate: Number(l.unitPrice).toFixed(2), taxCodeId: l.taxCodeId })));
  }, [saved, receipt]);
  // New documents: default tax code on empty lines once tax codes load.
  useEffect(() => { if (!id && defaultTax) setLines((ls) => ls.map((l) => (l.taxCodeId ? l : { ...l, taxCodeId: defaultTax }))); }, [defaultTax, id]);
  // A preset customer (from "Create invoice" on the customer list) fills its details.
  useEffect(() => { if (!id && presetCustomer && contacts) pickCustomer(presetCustomer); }, [contacts]);

  const customer = (contacts ?? []).find((c) => c.id === contactId);
  function pickCustomer(cid: string) {
    if (cid === '__new') { setNewCustomer(''); return; }
    setContactId(cid);
    const c = (contacts ?? []).find((x) => x.id === cid);
    if (!c) return;
    setBillingAddress(c.billingAddress ?? '');
    if (!receipt && c.defaultTerms) { setTerms(c.defaultTerms); setDueDate(addDays(issueDate, TERMS.find((t) => t[0] === c.defaultTerms)?.[2] ?? 30)); }
  }
  async function addCustomer() {
    if (!newCustomer?.trim()) return;
    try {
      const c = await api<Contact>(`${base}/contacts`, { method: 'POST', body: { kind: 'CUSTOMER', name: newCustomer.trim() } });
      await reloadContacts(); setContactId(c.id); setNewCustomer(null);
    } catch (x) { setErr(errorMessage(x)); }
  }
  const pickTerms = (t: string) => { setTerms(t); const d = TERMS.find((x) => x[0] === t)?.[2]; if (d !== undefined) setDueDate(addDays(issueDate, d)); };
  const pickDate = (d: string) => { setIssueDate(d); const n = TERMS.find((x) => x[0] === terms)?.[2]; if (!receipt && n !== undefined) setDueDate(addDays(d, n)); };

  const setLine = (k: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  function pickProduct(k: number, sel: string) {
    if (sel.startsWith('item:')) {
      const it = (items ?? []).find((i) => i.id === sel.slice(5));
      if (it) { setLine(k, { sel, description: it.description ?? it.name, rate: it.rate ? Number(it.rate).toFixed(2) : '', taxCodeId: it.taxCodeId ?? defaultTax }); return; }
    }
    setLine(k, { sel });
  }

  // Totals (estimate while editing; the saved figures once the document exists and is unchanged).
  const est = useMemo(() => {
    const at = issueDate;
    const rateOf = (codeId: string) => (taxCodes ?? []).find((t) => t.id === codeId)?.rates.filter((r) => r.effectiveFrom.slice(0, 10) <= at && (!r.effectiveTo || r.effectiveTo.slice(0, 10) >= at)) ?? [];
    let sub = 0; const tax = new Map<string, number>();
    for (const l of lines) {
      const amt = Math.round(cents(l.rate) * parseFloat(l.quantity || '0'));
      if (!amt) continue;
      const rs = rateOf(l.taxCodeId);
      const total = rs.reduce((s, r) => s + parseFloat(r.rate), 0);
      const net = inclusive ? Math.round(amt / (1 + total)) : amt;
      sub += net;
      for (const r of rs) { const label = `${r.component} ${+(parseFloat(r.rate) * 100).toFixed(3)}%`; tax.set(label, (tax.get(label) ?? 0) + Math.round(net * parseFloat(r.rate))); }
    }
    const taxTotal = [...tax.values()].reduce((s, v) => s + v, 0);
    return { sub, tax: [...tax], total: sub + taxTotal };
  }, [lines, taxCodes, issueDate, inclusive]);
  const savedTaxes = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of saved?.lines ?? []) for (const t of l.taxDetail) { const label = `${t.component} ${+(parseFloat(t.rate) * 100).toFixed(3)}%`; m.set(label, (m.get(label) ?? 0) + cents(t.amount)); }
    return [...m];
  }, [saved]);
  const showSaved = !!saved && !editable;
  const money = (c: number) => fmtMoney((c / 100).toFixed(2));
  const totalC = showSaved ? cents(saved!.total) : est.total;
  const balanceC = showSaved && !receipt && !isCredit ? cents(saved!.total) - cents(saved!.amountPaid ?? '0') : totalC;

  function payload(post: boolean) {
    const ls = lines.filter((l) => l.description.trim() || l.rate).map((l) => {
      const item = l.sel.startsWith('item:') ? (items ?? []).find((i) => i.id === l.sel.slice(5)) : undefined;
      const accountId = item?.incomeAccountId ?? (l.sel.startsWith('acct:') ? l.sel.slice(5) : income[0]?.id);
      return { ...(item ? { itemId: item.id } : {}), ...(l.serviceDate ? { serviceDate: l.serviceDate } : {}), description: l.description.trim() || item?.name || 'Sale', quantity: l.quantity || '1', unitPrice: l.rate || '0', accountId, taxCodeId: l.taxCodeId || defaultTax };
    });
    const common = { contactId, taxInclusive: inclusive, lines: ls, ...(billingAddress.trim() ? { billingAddress: billingAddress.trim() } : {}), ...(message.trim() ? { message: message.trim() } : {}), ...(memo.trim() ? { memo: memo.trim() } : {}) };
    return receipt
      ? { ...common, date: issueDate, paymentMethod: method, depositAccountId: depositId || depositAccounts[0]?.id, ...(referenceNo.trim() ? { referenceNo: referenceNo.trim() } : {}), post }
      : { ...common, kind: isCredit ? 'CREDIT' : 'STANDARD', issueDate, dueDate: isCredit ? issueDate : dueDate, ...(terms && !isCredit ? { terms } : {}) };
  }
  async function save(post: boolean) {
    setErr(null);
    if (!contactId) { setErr('Choose a customer.'); return; }
    if (!lines.some((l) => l.description.trim() || l.rate)) { setErr('Add at least one line.'); return; }
    setBusy(true);
    try {
      const path = receipt ? 'sales-receipts' : 'invoices';
      const body = payload(post);
      let docId = id;
      if (id) await api(`${base}/${path}/${id}`, { method: 'PUT', body });
      else docId = (await api<{ id: string }>(`${base}/${path}`, { method: 'POST', body })).id;
      if (post && !receipt) await api(`${base}/invoices/${docId}/post`, { method: 'POST' });
      if (id) await reload();
      router.replace(`/c/${companyId}/sales/${receipt ? 'receipts' : 'invoices'}/${docId}`);
    } catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  }
  async function voidDoc() {
    if (!saved || !window.confirm(saved.status === 'DRAFT' ? `Delete this draft ${title.toLowerCase()}?` : `Void ${title.toLowerCase()} ${saved.number}? A reversing entry is posted; the document stays on file as void.`)) return;
    setErr(null);
    try {
      await api(`${base}/${receipt ? 'sales-receipts' : 'invoices'}/${saved.id}/void`, { method: 'POST' });
      if (saved.status === 'DRAFT') router.replace(`/c/${companyId}/sales${receipt ? '/receipts' : '/invoices'}`); else await reload();
    } catch (x) { setErr(errorMessage(x)); }
  }
  const close = () => router.push(`/c/${companyId}/sales${receipt ? '/receipts' : '/invoices'}`);
  const pdf = saved ? `/api${base}/${receipt ? 'sales-receipts' : 'invoices'}/${saved.id}/pdf` : null;
  const state = !saved ? null : saved.status === 'DRAFT' ? 'draft' : saved.status === 'VOID' ? 'void' : saved.status === 'PAID' ? 'paid' : 'open';
  const ro = !editable;

  return (
    <div className="-m-4 flex min-h-[calc(100vh-3.5rem)] flex-col bg-background sm:-m-6">
      {/* title bar */}
      <div className="flex items-center gap-3 border-b bg-card px-6 py-3">
        <h1 className="text-xl font-semibold">{title}{saved?.number ? <span className="ml-2 font-mono text-base text-muted-foreground">{saved.number}</span> : <span className="ml-2 text-base font-normal text-muted-foreground">{saved ? 'draft' : 'new'}</span>}</h1>
        {state && <StatusPill row={{ state, status: { draft: 'Draft', void: 'Voided', paid: receipt ? 'Paid' : 'Paid', open: saved!.status === 'PARTIAL' ? 'Partially paid' : 'Open' }[state] }} />}
        <button onClick={close} className="ml-auto rounded p-1.5 hover:bg-accent" aria-label="Close"><X className="h-5 w-5" /></button>
      </div>

      <div className="flex-1 space-y-6 p-6">
        <FormError message={err} />
        {/* customer block + amount */}
        <div className="flex flex-wrap items-start gap-6">
          <div className="grid flex-1 gap-4 sm:grid-cols-2 lg:max-w-2xl">
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Customer</span>
              {newCustomer !== null ? (
                <span className="flex gap-2"><Input autoFocus aria-label="New customer name" placeholder="Customer name" value={newCustomer} onChange={(e) => setNewCustomer(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addCustomer(); } }} /><Button type="button" size="sm" onClick={() => void addCustomer()}>Add</Button><Button type="button" size="sm" variant="ghost" onClick={() => setNewCustomer(null)}>Cancel</Button></span>
              ) : (
                <Select aria-label="Customer" disabled={ro} value={contactId} onChange={(e) => pickCustomer(e.target.value)}>
                  <option value="">Choose a customer</option>
                  {can('sales:create') && <option value="__new">+ Add new customer</option>}
                  {(contacts ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              )}
            </label>
            <label className="block space-y-1.5 text-sm"><span className="font-medium">Customer email</span><Input disabled value={customer?.email ?? ''} placeholder="(none on file)" readOnly /></label>
          </div>
          <div className="ml-auto text-right">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{receipt ? 'Amount' : isCredit ? 'Credit amount' : 'Balance due'}</div>
            <div className="text-4xl font-semibold tabular-nums">{money(receipt || isCredit ? totalC : balanceC)}</div>
          </div>
        </div>

        {/* billing + dates */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <label className="block space-y-1.5 text-sm lg:row-span-2"><span className="font-medium">Billing address</span><textarea rows={4} disabled={ro} className={areaCls} value={billingAddress} onChange={(e) => setBillingAddress(e.target.value)} /></label>
          {receipt ? (
            <>
              <label className="block space-y-1.5 text-sm"><span className="font-medium">Sales receipt date</span><Input type="date" disabled={ro} value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></label>
              <label className="block space-y-1.5 text-sm"><span className="font-medium">Payment method</span><Select disabled={ro} value={method} onChange={(e) => setMethod(e.target.value)}>{METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></label>
              <label className="block space-y-1.5 text-sm"><span className="font-medium">Reference no.</span><Input disabled={ro} value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} /></label>
              <label className="block space-y-1.5 text-sm"><span className="font-medium">Deposit to</span><Select disabled={ro} value={depositId || depositAccounts[0]?.id || ''} onChange={(e) => setDepositId(e.target.value)}>{depositAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></label>
            </>
          ) : (
            <>
              {!isCredit && <label className="block space-y-1.5 text-sm"><span className="font-medium">Terms</span><Select disabled={ro} value={terms} onChange={(e) => pickTerms(e.target.value)}><option value="">None</option>{TERMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></label>}
              <label className="block space-y-1.5 text-sm"><span className="font-medium">{isCredit ? 'Credit note date' : 'Invoice date'}</span><Input type="date" disabled={ro} value={issueDate} onChange={(e) => pickDate(e.target.value)} /></label>
              {!isCredit && <label className="block space-y-1.5 text-sm"><span className="font-medium">Due date</span><Input type="date" disabled={ro} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>}
            </>
          )}
          <label className="block space-y-1.5 text-sm"><span className="font-medium">Amounts are</span><Select disabled={ro} value={inclusive ? 'in' : 'ex'} onChange={(e) => setInclusive(e.target.value === 'in')}><option value="ex">Exclusive of tax</option><option value="in">Inclusive of tax</option></Select></label>
        </div>

        {/* lines */}
        <div className="overflow-x-auto rounded-md border bg-card shadow-sm">
          <table className="w-full min-w-[56rem] text-sm">
            <thead className="border-b bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr><th className="w-8 px-2 py-2.5">#</th><th className="w-36 px-2 py-2.5">Service date</th><th className="w-56 px-2 py-2.5">Product/service</th><th className="px-2 py-2.5">Description</th><th className="w-20 px-2 py-2.5 text-right">Qty</th><th className="w-28 px-2 py-2.5 text-right">Rate</th><th className="w-28 px-2 py-2.5 text-right">Amount</th><th className="w-36 px-2 py-2.5">Sales tax</th><th className="w-8" /></tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const amt = Math.round(cents(l.rate) * parseFloat(l.quantity || '0'));
                return (
                  <tr key={l.key} className="border-b last:border-0 align-top">
                    <td className="px-2 py-2 text-muted-foreground">{i + 1}</td>
                    <td className="px-2 py-1.5"><Input type="date" aria-label={`Service date, line ${i + 1}`} disabled={ro} value={l.serviceDate} onChange={(e) => setLine(l.key, { serviceDate: e.target.value })} className="h-8" /></td>
                    <td className="px-2 py-1.5">
                      <Select aria-label={`Product or service, line ${i + 1}`} disabled={ro} value={l.sel} onChange={(e) => pickProduct(l.key, e.target.value)} className="h-8">
                        <option value="">{income[0] ? `(no product) ${income[0].name}` : 'Choose…'}</option>
                        {(items ?? []).length > 0 && <optgroup label="Products and services">{(items ?? []).map((it) => <option key={it.id} value={`item:${it.id}`}>{it.name}</option>)}</optgroup>}
                        <optgroup label="Income accounts">{income.map((a) => <option key={a.id} value={`acct:${a.id}`}>{a.code} · {a.name}</option>)}</optgroup>
                      </Select>
                    </td>
                    <td className="px-2 py-1.5"><Input aria-label={`Description, line ${i + 1}`} disabled={ro} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} className="h-8" /></td>
                    <td className="px-2 py-1.5"><Input aria-label={`Quantity, line ${i + 1}`} inputMode="decimal" disabled={ro} value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} className="h-8 text-right" /></td>
                    <td className="px-2 py-1.5"><Input aria-label={`Rate, line ${i + 1}`} inputMode="decimal" disabled={ro} value={l.rate} onChange={(e) => setLine(l.key, { rate: e.target.value })} className="h-8 text-right" /></td>
                    <td className="px-2 py-2 text-right tabular-nums">{amt ? money(amt) : ''}</td>
                    <td className="px-2 py-1.5"><Select aria-label={`Sales tax, line ${i + 1}`} disabled={ro} value={l.taxCodeId} onChange={(e) => setLine(l.key, { taxCodeId: e.target.value })} className="h-8">{(taxCodes ?? []).map((t) => <option key={t.id} value={t.id}>{t.code}</option>)}</Select></td>
                    <td className="px-1 py-1.5">{!ro && <button type="button" aria-label={`Delete line ${i + 1}`} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [blank(defaultTax)]))}><Trash2 className="h-4 w-4" /></button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!ro && (
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, blank(defaultTax)])}>Add lines</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setLines([blank(defaultTax), blank(defaultTax)])}>Clear all lines</Button>
          </div>
        )}

        {/* message, memo, totals */}
        <div className="flex flex-wrap gap-8">
          <div className="flex-1 space-y-4 lg:max-w-xl">
            <label className="block space-y-1.5 text-sm"><span className="font-medium">{receipt ? 'Message displayed on sales receipt' : isCredit ? 'Message displayed on credit note' : 'Message displayed on invoice'}</span><textarea rows={3} disabled={ro} className={areaCls} value={message} onChange={(e) => setMessage(e.target.value)} /></label>
            <label className="block space-y-1.5 text-sm"><span className="font-medium">Memo (internal, not printed)</span><textarea rows={2} disabled={ro} className={areaCls} value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
          </div>
          <dl className="ml-auto w-full max-w-sm space-y-2 text-sm">
            <div className="flex justify-between"><dt>Subtotal</dt><dd className="tabular-nums">{money(showSaved ? cents(saved!.subtotal) : est.sub)}</dd></div>
            {(showSaved ? savedTaxes : est.tax).map(([label, v]) => <div key={label} className="flex justify-between text-muted-foreground"><dt>{label}</dt><dd className="tabular-nums">{money(v)}</dd></div>)}
            <div className="flex justify-between border-t pt-2 text-base font-semibold"><dt>Total</dt><dd className="tabular-nums">{money(totalC)}</dd></div>
            {showSaved && !receipt && !isCredit && <>
              <div className="flex justify-between"><dt>Payments received</dt><dd className="tabular-nums">{fmtMoney(saved!.amountPaid ?? '0')}</dd></div>
              <div className="flex justify-between text-base font-semibold"><dt>Balance due</dt><dd className="tabular-nums">{money(balanceC)}</dd></div>
            </>}
            {!showSaved && <p className="text-xs text-muted-foreground">Tax is an estimate while you edit; exact amounts are calculated when you save.</p>}
          </dl>
        </div>
      </div>

      {/* action bar */}
      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t bg-sidebar px-6 py-3 text-sidebar-foreground">
        <Button variant="ghost" className="text-sidebar-foreground hover:bg-white/10 hover:text-white" onClick={close}>{ro ? 'Close' : 'Cancel'}</Button>
        {saved && can('sales:reverse') && saved.status !== 'VOID' && (saved.status === 'DRAFT' || saved.status === 'POSTED' || receipt) && (
          <Button variant="ghost" className="text-sidebar-foreground hover:bg-white/10 hover:text-white" onClick={() => void voidDoc()}>{saved.status === 'DRAFT' ? 'Delete' : 'Void'}</Button>
        )}
        {pdf && <a href={pdf} target="_blank" rel="noreferrer" className="mx-auto inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-white/10 hover:text-white"><Printer className="h-4 w-4" aria-hidden /> Print or download</a>}
        <div className="ml-auto flex gap-2">
          {ro && !receipt && !isCredit && saved && ['POSTED', 'PARTIAL'].includes(saved.status) && can('sales:post') && <Button onClick={() => setPaying(true)}>Receive payment</Button>}
          {!ro && <Button variant="outline" className="border-white/30 bg-transparent text-white hover:bg-white/10 hover:text-white" disabled={busy} onClick={() => void save(false)}>Save draft</Button>}
          {!ro && can('sales:post') && <Button disabled={busy} onClick={() => void save(true)}>{busy ? 'Saving…' : receipt ? 'Save and record' : 'Save and post'}</Button>}
          {ro && <Link href={`/c/${companyId}/sales/${receipt ? 'receipts' : 'invoices'}/new`} className={cn('inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90')}>New {receipt ? 'sales receipt' : 'invoice'}</Link>}
        </div>
      </div>
      {paying && saved && <ReceivePayment row={{ id: saved.id, contactId: saved.contactId, number: saved.number, customer: saved.contact.name, balance: ((cents(saved.total) - cents(saved.amountPaid ?? '0')) / 100).toFixed(2) }} onClose={(done) => { setPaying(false); if (done) void reload(); }} />}
    </div>
  );
}
