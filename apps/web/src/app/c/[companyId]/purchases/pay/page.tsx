'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { PurchasesHeader } from '@/components/purchases/header';
import type { Account } from '@/components/sales/common';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney, today, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Bill { id: string; number: string | null; supplierRef: string | null; kind: string; status: string; dueDate: string; total: string; amountPaid: string; contactId: string; contact: { name: string } }
const cents = (v: string) => Math.round(parseFloat(v || '0') * 100) || 0;

/** Pay bills: tick the bills, adjust amounts, pick the account; one payment per supplier is recorded. */
function PayBills() {
  const { companyId, can } = useCompany();
  const params = useSearchParams();
  const base = `/companies/${companyId}`;
  const { data, reload } = useApi<Bill[]>(`${base}/bills`);
  const { data: accounts } = useApi<Account[]>(can('accounts:view') ? `${base}/accounts` : null);
  const banks = (accounts ?? []).filter((a) => ['ASSET', 'LIABILITY'].includes(a.type) && !a.role && !(a as Account & { special?: string | null }).special);
  const open = (data ?? []).filter((b) => b.kind === 'STANDARD' && ['POSTED', 'PARTIAL'].includes(b.status)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [bank, setBank] = useState('');
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const balance = (b: Bill) => ((cents(b.total) - cents(b.amountPaid)) / 100).toFixed(2);
  useEffect(() => { const pre = params.get('bill'); const b = open.find((x) => x.id === pre); if (b && !(pre! in amounts)) setAmounts({ [b.id]: balance(b) }); }, [data]);
  const picked = Object.entries(amounts).filter(([, v]) => cents(v) > 0);
  const total = useMemo(() => picked.reduce((s, [, v]) => s + cents(v), 0), [picked]);
  async function pay() {
    setErr(null); setDone(null);
    try {
      const r = await api<unknown[]>(`${base}/bills/pay`, { method: 'POST', body: { bankAccountId: bank || banks[0]?.id, date, ...(reference ? { reference } : {}), bills: picked.map(([billId, amount]) => ({ billId, amount })) } });
      setDone(`Recorded ${r.length} payment${r.length === 1 ? '' : 's'} totalling ${fmtMoney((total / 100).toFixed(2))}.`); setAmounts({}); await reload();
    } catch (x) { setErr(errorMessage(x)); }
  }
  return (
    <div className="space-y-5">
      <PurchasesHeader title="Pay bills" />
      <div className="flex flex-wrap items-end gap-4 rounded-md border bg-card p-4 shadow-sm">
        <Field label="Payment account" htmlFor="pb-bank"><Select id="pb-bank" className="w-64" value={bank || banks[0]?.id || ''} onChange={(e) => setBank(e.target.value)}>{banks.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
        <Field label="Payment date" htmlFor="pb-date"><Input id="pb-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Reference (cheque no.)" htmlFor="pb-ref"><Input id="pb-ref" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        <div className="ml-auto text-right"><div className="text-xs uppercase tracking-wide text-muted-foreground">Total payment</div><div className="text-2xl font-semibold tabular-nums">{fmtMoney((total / 100).toFixed(2))}</div></div>
      </div>
      <FormError message={err} />
      {done && <p role="status" className="rounded-md border border-primary/30 bg-accent px-3 py-2 text-sm">{done}</p>}
      <div className="overflow-x-auto rounded-md border bg-card shadow-sm">
        <table className="w-full min-w-[48rem] text-sm">
          <thead className="border-b bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="w-10 px-3 py-2.5" /><th className="px-3 py-2.5">Supplier</th><th className="px-3 py-2.5">Bill</th><th className="px-3 py-2.5">Due date</th><th className="px-3 py-2.5 text-right">Open balance</th><th className="w-40 px-3 py-2.5 text-right">Payment</th></tr></thead>
          <tbody>
            {data && open.length === 0 && <tr><td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">No open bills.</td></tr>}
            {open.map((b) => (
              <tr key={b.id} className={`border-b last:border-0 ${b.dueDate.slice(0, 10) < today() ? 'bg-orange-50/40 dark:bg-orange-950/20' : ''}`}>
                <td className="px-3 py-2"><input type="checkbox" aria-label={`Pay ${b.number}`} checked={b.id in amounts} onChange={(e) => setAmounts((a) => { const n = { ...a }; if (e.target.checked) n[b.id] = balance(b); else delete n[b.id]; return n; })} /></td>
                <td className="px-3 py-2">{b.contact.name}</td><td className="px-3 py-2 font-mono text-xs">{b.number}{b.supplierRef ? ` · ${b.supplierRef}` : ''}</td><td className="px-3 py-2">{b.dueDate.slice(0, 10)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(balance(b))}</td>
                <td className="px-3 py-2"><Input aria-label={`Payment for ${b.number}`} inputMode="decimal" className="h-8 text-right" value={amounts[b.id] ?? ''} onChange={(e) => setAmounts((a) => ({ ...a, [b.id]: e.target.value }))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end"><Button disabled={!picked.length || !can('purchases:post')} onClick={() => void pay()}>Save and record payments</Button></div>
    </div>
  );
}
export default function PayBillsPage() {
  return <Suspense><PayBills /></Suspense>;
}
