'use client';
import { Printer } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { SalesHeader, StatusPill } from '@/components/sales/common';
import { Button } from '@/components/ui/button';
import { Field, FormError, Select } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Est { id: string; number: string; status: string; issueDate: string; expiryDate: string | null; total: string; contact: { name: string }; invoiceId: string | null }
const LABEL: Record<string, string> = { PENDING: 'Pending', ACCEPTED: 'Accepted', DECLINED: 'Declined', CLOSED: 'Converted', VOID: 'Voided' };
const STATE: Record<string, 'open' | 'paid' | 'overdue' | 'void'> = { PENDING: 'open', ACCEPTED: 'paid', DECLINED: 'overdue', CLOSED: 'paid', VOID: 'void' };

export default function EstimatesPage() {
  const { companyId, can } = useCompany();
  const router = useRouter();
  const [status, setStatus] = useState('');
  const { data, error } = useApi<Est[]>(`/companies/${companyId}/estimates${status ? `?status=${status}` : ''}`);
  const [err, setErr] = useState<string | null>(null);
  async function convert(e: Est) {
    setErr(null);
    try { const inv = await api<{ id: string }>(`/companies/${companyId}/estimates/${e.id}/convert`, { method: 'POST', body: {} }); router.push(`/c/${companyId}/sales/invoices/${inv.id}`); } catch (x) { setErr(errorMessage(x)); }
  }
  const rows = data ?? [];
  const open = rows.filter((r) => r.status === 'PENDING' || r.status === 'ACCEPTED');
  return (
    <div className="space-y-5">
      <SalesHeader title="Estimates" actions={can('sales:create') ? <Button variant="outline" onClick={() => router.push(`/c/${companyId}/sales/estimates/new`)}>New estimate</Button> : undefined} />
      <section className="grid gap-4 rounded-md border bg-card p-4 shadow-sm sm:grid-cols-3">
        <div><div className="text-xl font-semibold tabular-nums">{rows.filter((r) => r.status === 'PENDING').length}</div><div className="text-xs uppercase tracking-wide text-muted-foreground">Pending</div></div>
        <div><div className="text-xl font-semibold tabular-nums">{rows.filter((r) => r.status === 'ACCEPTED').length}</div><div className="text-xs uppercase tracking-wide text-muted-foreground">Accepted, not invoiced</div></div>
        <div><div className="text-xl font-semibold tabular-nums">{fmtMoney(open.reduce((s, r) => s + Math.round(Number(r.total) * 100), 0) / 100)}</div><div className="text-xs uppercase tracking-wide text-muted-foreground">Open estimate value</div></div>
      </section>
      <div className="flex items-end gap-3">
        <Field label="Status" htmlFor="e-status"><Select id="e-status" className="w-44" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{Object.entries(LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
      </div>
      <FormError message={err ?? (error ? errorMessage(error) : null)} />
      <div className="overflow-x-auto rounded-md border bg-card shadow-sm">
        <table className="w-full min-w-[48rem] text-sm">
          <thead className="border-b bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr>{['Date', 'No.', 'Customer', 'Expires', 'Total', 'Status', 'Action'].map((h, i) => <th key={h} className={`px-3 py-2.5 ${i === 4 || i === 6 ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
          <tbody>
            {data && rows.length === 0 && <tr><td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">No estimates yet. Create one and send it; when the customer accepts, convert it to an invoice in one click.</td></tr>}
            {rows.map((e) => (
              <tr key={e.id} className="cursor-pointer border-b last:border-0 hover:bg-accent/50" onClick={() => router.push(`/c/${companyId}/sales/estimates/${e.id}`)}>
                <td className="px-3 py-2.5">{e.issueDate.slice(0, 10)}</td><td className="px-3 py-2.5 font-mono text-xs">{e.number}</td><td className="px-3 py-2.5">{e.contact.name}</td>
                <td className="px-3 py-2.5">{e.expiryDate?.slice(0, 10) ?? ''}</td><td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(e.total)}</td>
                <td className="px-3 py-2.5"><StatusPill row={{ state: STATE[e.status], status: LABEL[e.status] }} /></td>
                <td className="px-3 py-2.5 text-right" onClick={(x) => x.stopPropagation()}>
                  {['PENDING', 'ACCEPTED'].includes(e.status) && can('sales:create') ? <Button size="sm" variant="ghost" className="text-primary" onClick={() => void convert(e)}>Convert to invoice</Button>
                    : e.status === 'CLOSED' && e.invoiceId ? <Link className="text-xs font-medium text-primary hover:underline" href={`/c/${companyId}/sales/invoices/${e.invoiceId}`}>View invoice</Link>
                    : <a className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" target="_blank" rel="noreferrer" href={`/api/companies/${companyId}/estimates/${e.id}/pdf`}><Printer className="h-3.5 w-3.5" aria-hidden />Print</a>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
