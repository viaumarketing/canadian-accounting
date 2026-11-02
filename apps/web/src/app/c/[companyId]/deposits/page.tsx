'use client';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Account } from '@/components/sales/common';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney, today, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Item { type: 'payment' | 'sales_receipt'; id: string; date: string; customer: string; reference: string | null; method: string | null; accountId: string; amount: string }
interface Und { holdingAccounts: { id: string; code: string; name: string; special: string }[]; items: Item[] }
interface Dep { id: string; date: string; total: string; memo: string | null; voidedAt: string | null; _count: { lines: number } }
interface Other { key: number; accountId: string; amount: string; description: string }
const METHOD: Record<string, string> = { CASH: 'Cash', CHEQUE: 'Cheque', CREDIT_CARD: 'Card', DEBIT_CARD: 'Debit', E_TRANSFER: 'e-Transfer', OTHER: 'Other' };
const cents = (v: string) => Math.round(parseFloat(v || '0') * 100) || 0;
let seq = 0;

/** Bank deposit: pick the payments waiting in Undeposited Funds (or Stripe clearing), add fees or other lines, record one deposit. */
export default function DepositsPage() {
  const { companyId, can } = useCompany();
  const base = `/companies/${companyId}`;
  const { data, reload } = useApi<Und>(`${base}/deposits/undeposited`);
  const { data: deposits, reload: reloadDeposits } = useApi<Dep[]>(`${base}/deposits`);
  const { data: accounts } = useApi<Account[]>(can('accounts:view') ? `${base}/accounts` : null);
  const banks = (accounts ?? []).filter((a) => a.type === 'ASSET' && !a.role && !(a as Account & { special?: string | null }).special);
  const others = (accounts ?? []).filter((a) => !a.role && !(a as Account & { special?: string | null }).special && (a.type === 'EXPENSE' || a.type === 'REVENUE' || a.type === 'LIABILITY' || a.type === 'EQUITY'));
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [lines, setLines] = useState<Other[]>([]);
  const [f, setF] = useState({ bankAccountId: '', date: today(), memo: '' });
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const holdingName = (id: string) => data?.holdingAccounts.find((h) => h.id === id)?.name ?? '';
  const items = data?.items ?? [];
  const total = useMemo(() => items.filter((i) => sel.has(i.id)).reduce((s, i) => s + cents(i.amount), 0) + lines.reduce((s, l) => s + cents(l.amount), 0), [sel, lines, items]);
  async function save() {
    setErr(null); setMsg(null);
    try {
      await api(`${base}/deposits`, { method: 'POST', body: { bankAccountId: f.bankAccountId || banks[0]?.id, date: f.date, ...(f.memo ? { memo: f.memo } : {}), items: items.filter((i) => sel.has(i.id)).map((i) => ({ type: i.type, id: i.id })), otherLines: lines.filter((l) => l.accountId && cents(l.amount) !== 0).map((l) => ({ accountId: l.accountId, amount: l.amount, ...(l.description ? { description: l.description } : {}) })) } });
      setMsg(`Deposit of ${fmtMoney((total / 100).toFixed(2))} recorded.`); setSel(new Set()); setLines([]); await reload(); await reloadDeposits();
    } catch (x) { setErr(errorMessage(x)); }
  }
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3"><h1 className="text-2xl font-semibold tracking-tight">Bank deposit</h1><div className="ml-auto text-right"><div className="text-xs uppercase tracking-wide text-muted-foreground">Deposit total</div><div className="text-2xl font-semibold tabular-nums">{fmtMoney((total / 100).toFixed(2))}</div></div></div>
      <p className="text-sm text-muted-foreground">Payments you record to <strong>Undeposited Funds</strong> (and card payments in <strong>Stripe Clearing</strong>) wait here. Select the ones that went to the bank together, so the deposit matches the single line on your bank statement.</p>
      <FormError message={err} />
      {msg && <p role="status" className="rounded-md border border-primary/30 bg-accent px-3 py-2 text-sm">{msg}</p>}
      <div className="flex flex-wrap items-end gap-4 rounded-md border bg-card p-4 shadow-sm">
        <Field label="Deposit to" htmlFor="dp-bank"><Select id="dp-bank" className="w-64" value={f.bankAccountId || banks[0]?.id || ''} onChange={(e) => setF({ ...f, bankAccountId: e.target.value })}>{banks.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
        <Field label="Date" htmlFor="dp-date"><Input id="dp-date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Memo" htmlFor="dp-memo"><Input id="dp-memo" className="w-72" value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} /></Field>
      </div>
      <Card>
        <CardHeader><CardTitle>Select the payments included in this deposit</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground"><tr><th className="w-8 py-2"><input type="checkbox" aria-label="Select all" checked={items.length > 0 && sel.size === items.length} onChange={(e) => setSel(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())} /></th><th>Date</th><th>Received from</th><th>Type</th><th>Method</th><th>Reference</th><th>Held in</th><th className="text-right">Amount</th></tr></thead>
            <tbody>
              {data && items.length === 0 && <tr><td colSpan={8} className="py-8 text-center text-muted-foreground">Nothing waiting to be deposited.</td></tr>}
              {items.map((i) => <tr key={i.id} className="border-t"><td className="py-2"><input type="checkbox" aria-label={`Include ${i.customer} ${i.amount}`} checked={sel.has(i.id)} onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(i.id); else n.delete(i.id); return n; })} /></td><td>{i.date}</td><td>{i.customer}</td><td>{i.type === 'payment' ? 'Payment' : 'Sales receipt'}</td><td>{i.method ? METHOD[i.method] : ''}</td><td className="font-mono text-xs">{i.reference}</td><td>{holdingName(i.accountId)}</td><td className="text-right tabular-nums">{fmtMoney(i.amount)}</td></tr>)}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Other lines: fees as negative amounts (e.g. −3.20 to Payment Processing Fees), other money as positive</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {lines.map((l) => (
            <div key={l.key} className="flex gap-2">
              <Select aria-label="Account" className="w-72" value={l.accountId} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, accountId: e.target.value } : x)))}><option value="">Account…</option>{others.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select>
              <Input aria-label="Description" placeholder="Description" value={l.description} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, description: e.target.value } : x)))} />
              <Input aria-label="Amount" inputMode="decimal" className="w-32 text-right" placeholder="-0.00" value={l.amount} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, amount: e.target.value } : x)))} />
              <button type="button" aria-label="Remove line" className="rounded p-2 hover:bg-accent" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, { key: ++seq, accountId: others.find((a) => a.code === '6120')?.id ?? '', amount: '', description: '' }])}><Plus className="h-4 w-4" /> Add line</Button>
        </CardContent>
      </Card>
      <div className="flex justify-end"><Button disabled={!can('banking:post') || total <= 0} onClick={() => void save()}>Save deposit</Button></div>
      <Card>
        <CardHeader><CardTitle>Recent deposits</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm"><tbody>
            {(deposits ?? []).map((d) => <tr key={d.id} className="border-t"><td className="py-2">{d.date.slice(0, 10)}</td><td>{d.memo}</td><td>{d._count.lines} line{d._count.lines === 1 ? '' : 's'}</td><td className="text-right tabular-nums">{fmtMoney(d.total)}</td><td className="text-right">{d.voidedAt ? <Badge tone="danger">voided</Badge> : can('banking:reverse') && <Button size="sm" variant="ghost" onClick={() => window.confirm('Void this deposit? Its payments go back to waiting.') && void api(`${base}/deposits/${d.id}/void`, { method: 'POST' }).then(() => Promise.all([reload(), reloadDeposits()])).catch((x) => setErr(errorMessage(x)))}>Void</Button>}</td></tr>)}
            {deposits && deposits.length === 0 && <tr><td className="py-4 text-muted-foreground">No deposits yet.</td></tr>}
          </tbody></table>
        </CardContent>
      </Card>
    </div>
  );
}
