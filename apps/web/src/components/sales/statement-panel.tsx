'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney, today } from '@/lib/company';
import { useApi } from '@/lib/use-api';
import { SidePanel } from './common';

interface Statement { opening?: string; closing: string; rows: { id: string; date: string; type: string; number: string; dueDate: string | null; amount: string; balance: string }[]; aging: Record<'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'over90', string> }
const firstOfMonth = () => `${today().slice(0, 7)}-01`;

/** Customer statement: preview, PDF and e-mail (balance-forward or open items). */
export function StatementPanel({ companyId, customer, onClose }: { companyId: string; customer: { id: string; name: string; email: string | null }; onClose: () => void }) {
  const [q, setQ] = useState({ from: firstOfMonth(), to: today(), type: 'balance_forward' });
  const qs = new URLSearchParams({ contactId: customer.id, ...q }).toString();
  const { data, error } = useApi<Statement>(`/companies/${companyId}/statements?${qs}`);
  const [to, setTo] = useState(customer.email ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function send() {
    setErr(null); setMsg(null);
    try { await api(`/companies/${companyId}/statements/send`, { method: 'POST', body: { contactId: customer.id, ...q, recipients: to.split(/[,;\s]+/).filter(Boolean) } }); setMsg(`Statement sent to ${to}.`); } catch (e) { setErr(errorMessage(e)); }
  }
  return (
    <SidePanel title={`Statement – ${customer.name}`} onClose={onClose} footer={<><a className="mr-auto inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent" href={`/api/companies/${companyId}/statements/pdf?${qs}`} target="_blank" rel="noreferrer">View PDF</a><Button variant="outline" onClick={onClose}>Close</Button><Button disabled={!to.trim()} onClick={() => void send()}>Send</Button></>}>
      <FormError message={err ?? (error ? errorMessage(error) : null)} />
      {msg && <p role="status" className="rounded-md border border-primary/30 bg-accent px-3 py-2 text-sm">{msg}</p>}
      <div className="grid grid-cols-3 gap-3">
        <Field label="Type" htmlFor="st-type"><Select id="st-type" value={q.type} onChange={(e) => setQ({ ...q, type: e.target.value })}><option value="balance_forward">Balance forward</option><option value="open_item">Open items</option></Select></Field>
        <Field label="From" htmlFor="st-from"><Input id="st-from" type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} /></Field>
        <Field label="To" htmlFor="st-to"><Input id="st-to" type="date" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} /></Field>
      </div>
      {data && (
        <div className="space-y-3 text-sm">
          <table className="w-full">
            <thead className="text-left text-xs uppercase text-muted-foreground"><tr><th className="py-1">Date</th><th>Transaction</th><th className="text-right">Amount</th><th className="text-right">Balance</th></tr></thead>
            <tbody>
              {data.opening !== undefined && <tr className="border-t"><td className="py-1">{q.from}</td><td>Balance forward</td><td /><td className="text-right tabular-nums">{fmtMoney(data.opening)}</td></tr>}
              {data.rows.map((r) => <tr key={`${r.type}-${r.id}`} className="border-t"><td className="py-1">{r.date}</td><td>{r.type} {r.number}</td><td className="text-right tabular-nums">{fmtMoney(r.amount)}</td><td className="text-right tabular-nums">{fmtMoney(r.balance)}</td></tr>)}
            </tbody>
          </table>
          <p className="flex justify-between border-t pt-2 font-semibold"><span>Amount due</span><span className="tabular-nums">{fmtMoney(data.closing)}</span></p>
          <div className="grid grid-cols-5 gap-1 text-center text-xs">{([['Current', 'current'], ['1–30', 'd1_30'], ['31–60', 'd31_60'], ['61–90', 'd61_90'], ['90+', 'over90']] as const).map(([l, k]) => <div key={k} className="rounded border p-1"><div className="text-muted-foreground">{l}</div><div className="tabular-nums">{fmtMoney(data.aging[k])}</div></div>)}</div>
        </div>
      )}
      <Field label="E-mail to" htmlFor="st-email"><Input id="st-email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="customer@example.com" /></Field>
    </SidePanel>
  );
}
