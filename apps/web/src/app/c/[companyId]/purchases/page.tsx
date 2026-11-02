'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PurchasesHeader } from '@/components/purchases/header';
import { StatusPill } from '@/components/sales/common';
import { Field, FormError, Select } from '@/components/ui/form';
import { errorMessage } from '@/lib/api';
import { fmtMoney, today, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Bill { id: string; number: string | null; supplierRef: string | null; kind: string; status: string; issueDate: string; dueDate: string; total: string; amountPaid: string; contact: { name: string } }

/** Bills and supplier credits, with what is owed and what is overdue. */
export default function BillsPage() {
  const { companyId } = useCompany();
  const router = useRouter();
  const [status, setStatus] = useState('');
  const { data, error } = useApi<Bill[]>(`/companies/${companyId}/bills${status ? `?status=${status}` : ''}`);
  const now = today();
  const rows = data ?? [];
  const open = rows.filter((b) => b.kind === 'STANDARD' && ['POSTED', 'PARTIAL'].includes(b.status));
  const bal = (b: Bill) => Math.round(Number(b.total) * 100) - Math.round(Number(b.amountPaid) * 100);
  const overdue = open.filter((b) => b.dueDate.slice(0, 10) < now).reduce((s, b) => s + bal(b), 0);
  const unpaid = open.reduce((s, b) => s + bal(b), 0);
  const state = (b: Bill) => b.status === 'DRAFT' ? 'draft' : b.status === 'VOID' ? 'void' : b.status === 'PAID' ? 'paid' : b.dueDate.slice(0, 10) < now && b.kind === 'STANDARD' ? 'overdue' : 'open';
  const label = (b: Bill) => b.status === 'DRAFT' ? 'Draft' : b.status === 'VOID' ? 'Voided' : b.status === 'PAID' ? (b.kind === 'CREDIT' ? 'Applied' : 'Paid') : b.kind === 'CREDIT' ? 'Unapplied' : b.status === 'PARTIAL' ? 'Partially paid' : b.dueDate.slice(0, 10) < now ? 'Overdue' : 'Open';
  return (
    <div className="space-y-5">
      <PurchasesHeader title="Bills" />
      <section className="grid gap-4 rounded-md border bg-card p-4 shadow-sm sm:grid-cols-3">
        <div><div className="text-xl font-semibold tabular-nums">{fmtMoney((unpaid / 100).toFixed(2))}</div><div className="text-xs uppercase tracking-wide text-muted-foreground">Unpaid · {open.length} bill{open.length === 1 ? '' : 's'}</div></div>
        <div><div className="text-xl font-semibold tabular-nums text-orange-600">{fmtMoney((overdue / 100).toFixed(2))}</div><div className="text-xs uppercase tracking-wide text-muted-foreground">Overdue</div></div>
        <div><div className="text-xl font-semibold tabular-nums">{rows.filter((b) => b.status === 'DRAFT').length}</div><div className="text-xs uppercase tracking-wide text-muted-foreground">Drafts to post</div></div>
      </section>
      <div className="flex items-end gap-3"><Field label="Status" htmlFor="b-st"><Select id="b-st" className="w-44" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="DRAFT">Draft</option><option value="POSTED">Open</option><option value="PARTIAL">Partially paid</option><option value="PAID">Paid</option><option value="VOID">Voided</option></Select></Field></div>
      <FormError message={error ? errorMessage(error) : null} />
      <div className="overflow-x-auto rounded-md border bg-card shadow-sm">
        <table className="w-full min-w-[52rem] text-sm">
          <thead className="border-b bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr>{['Date', 'No.', 'Supplier', 'Bill no.', 'Due date', 'Open balance', 'Total', 'Status'].map((h, i) => <th key={h} className={`px-3 py-2.5 ${i === 5 || i === 6 ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
          <tbody>
            {data && rows.length === 0 && <tr><td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">No bills yet. Enter supplier bills here to track what you owe and pay several at once.</td></tr>}
            {rows.map((b) => (
              <tr key={b.id} className="cursor-pointer border-b last:border-0 hover:bg-accent/50" onClick={() => router.push(`/c/${companyId}/purchases/${b.id}`)}>
                <td className="px-3 py-2.5">{b.issueDate.slice(0, 10)}</td><td className="px-3 py-2.5 font-mono text-xs">{b.number ?? '—'}{b.kind === 'CREDIT' && ' (credit)'}</td><td className="px-3 py-2.5">{b.contact.name}</td><td className="px-3 py-2.5">{b.supplierRef}</td>
                <td className="px-3 py-2.5">{b.kind === 'STANDARD' ? b.dueDate.slice(0, 10) : ''}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{['POSTED', 'PARTIAL'].includes(b.status) ? fmtMoney((bal(b) / 100).toFixed(2)) : ''}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(b.kind === 'CREDIT' ? `-${b.total}` : b.total)}</td>
                <td className="px-3 py-2.5"><StatusPill row={{ state: state(b), status: label(b) }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
