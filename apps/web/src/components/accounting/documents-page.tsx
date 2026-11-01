'use client';
import { useState } from 'react';
import { PageTitle, Table, Td } from '@/components/accounting/bits';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney, today, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Doc { id: string; contactId: string; number: string | null; kind: string; status: string; issueDate: string; dueDate: string; total: string; amountPaid: string; taxTotal: string; contact: { name: string } }
interface Opt { id: string; name?: string; code?: string; type?: string; kind?: string; role?: string | null }

/** Shared screen for invoices (sales) and bills (purchases). */
export function DocumentsPage({ kind }: { kind: 'invoice' | 'bill' }) {
  const sales = kind === 'invoice';
  const { companyId, can } = useCompany();
  const base = `/companies/${companyId}`;
  const area = sales ? 'sales' : 'purchases';
  const { data, reload, error } = useApi<Doc[]>(`${base}/${sales ? 'invoices' : 'bills'}`);
  const { data: contacts } = useApi<Opt[]>(`${base}/contacts?kind=${sales ? 'CUSTOMER' : 'VENDOR'}`);
  const { data: accounts } = useApi<Opt[]>(can('accounts:view') ? `${base}/accounts` : null);
  const { data: taxCodes } = useApi<Opt[]>(can('taxes:view') ? `${base}/tax-codes` : null);
  const [f, setF] = useState({ contactId: '', issueDate: today(), dueDate: today(), taxInclusive: false, credit: false, description: '', quantity: '1', unitPrice: '', accountId: '', taxCodeId: '' });
  const [payFor, setPayFor] = useState<Doc | null>(null);
  const [pay, setPay] = useState({ bankAccountId: '', amount: '', date: today() });
  const [err, setErr] = useState<string | null>(null);
  const lineAccounts = (accounts ?? []).filter((a) => !a.role && (sales ? a.type === 'REVENUE' : ['EXPENSE', 'ASSET'].includes(a.type!)));
  const bankAccounts = (accounts ?? []).filter((a) => !a.role && ['ASSET', 'LIABILITY'].includes(a.type!));
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); await reload(); } catch (x) { setErr(errorMessage(x)); } };

  return (
    <div className="space-y-4">
      <PageTitle>{sales ? 'Sales' : 'Purchases'}</PageTitle>
      <FormError message={err ?? (error ? errorMessage(error) : null)} />
      {data && data.length === 0 ? <Card><EmptyState title={sales ? 'No invoices yet' : 'No bills yet'}>Create one below; posting it records the entry in the ledger.</EmptyState></Card> : (
        <Table head={['Number', 'Contact', 'Issued', 'Total', 'Paid', 'Status', '']} right={[3, 4]}>
          {(data ?? []).map((d) => (
            <tr key={d.id}>
              <Td mono>{d.number ?? 'draft'}{d.kind === 'CREDIT' && ' (credit)'}</Td><Td>{d.contact.name}</Td><Td>{d.issueDate.slice(0, 10)}</Td>
              <Td right>{fmtMoney(d.total)}</Td><Td right>{fmtMoney(d.amountPaid)}</Td>
              <Td><Badge tone={d.status === 'PAID' ? 'success' : d.status === 'VOID' ? 'danger' : d.status === 'DRAFT' ? 'neutral' : 'warning'}>{d.status.toLowerCase()}</Badge></Td>
              <Td>
                <div className="flex gap-1">
                  {d.status === 'DRAFT' && can(`${area}:post`) && <Button size="sm" onClick={() => void run(() => api(`${base}/${sales ? 'invoices' : 'bills'}/${d.id}/post`, { method: 'POST' }))}>Post</Button>}
                  {['POSTED', 'PARTIAL'].includes(d.status) && d.kind === 'STANDARD' && can(`${area}:post`) && <Button size="sm" variant="outline" onClick={() => { setPayFor(d); setPay({ ...pay, amount: (parseFloat(d.total) - parseFloat(d.amountPaid)).toFixed(2) }); }}>{sales ? 'Receive payment' : 'Pay'}</Button>}
                  {['DRAFT', 'POSTED'].includes(d.status) && can(`${area}:reverse`) && <Button size="sm" variant="ghost" onClick={() => void run(() => api(`${base}/${sales ? 'invoices' : 'bills'}/${d.id}/void`, { method: 'POST' }))}>{d.status === 'DRAFT' ? 'Delete' : 'Void'}</Button>}
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {payFor && (
        <Card><CardHeader><CardTitle>{sales ? 'Receive payment' : 'Pay'} for {payFor.number}</CardTitle></CardHeader><CardContent>
          <form className="grid gap-4 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`${base}/payments`, { method: 'POST', body: { direction: sales ? 'RECEIPT' : 'DISBURSEMENT', contactId: payFor.contactId, bankAccountId: pay.bankAccountId, date: pay.date, amount: pay.amount, allocations: [{ documentId: payFor.id, amount: pay.amount }] } }); setPayFor(null); }); }}>
            <Field label="Bank account" htmlFor="p-bank"><Select id="p-bank" required value={pay.bankAccountId} onChange={(e) => setPay({ ...pay, bankAccountId: e.target.value })}><option value="">Select…</option>{bankAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
            <Field label="Amount" htmlFor="p-amt"><Input id="p-amt" required inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></Field>
            <Field label="Date" htmlFor="p-date"><Input id="p-date" type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} /></Field>
            <div className="flex items-end gap-2"><Button type="submit">Record</Button><Button type="button" variant="ghost" onClick={() => setPayFor(null)}>Cancel</Button></div>
          </form></CardContent></Card>
      )}
      {can(`${area}:create`) && (
        <Card><CardHeader><CardTitle>New {sales ? 'invoice' : 'bill'} (one line; more via API for now)</CardTitle></CardHeader><CardContent>
          <form className="grid gap-4 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`${base}/${sales ? 'invoices' : 'bills'}`, { method: 'POST', body: { contactId: f.contactId, issueDate: f.issueDate, dueDate: f.dueDate, taxInclusive: f.taxInclusive, kind: f.credit ? 'CREDIT' : 'STANDARD', lines: [{ description: f.description, quantity: f.quantity, unitPrice: f.unitPrice, accountId: f.accountId, taxCodeId: f.taxCodeId }] } }); setF({ ...f, description: '', unitPrice: '' }); }); }}>
            <Field label={sales ? 'Customer' : 'Supplier'} htmlFor="d-contact"><Select id="d-contact" required value={f.contactId} onChange={(e) => setF({ ...f, contactId: e.target.value })}><option value="">Select…</option>{(contacts ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
            <Field label="Issue date" htmlFor="d-issue"><Input id="d-issue" type="date" value={f.issueDate} onChange={(e) => setF({ ...f, issueDate: e.target.value })} /></Field>
            <Field label="Due date" htmlFor="d-due"><Input id="d-due" type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
            <Field label="Description" htmlFor="d-desc"><Input id="d-desc" required value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
            <Field label="Quantity" htmlFor="d-qty"><Input id="d-qty" required inputMode="decimal" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></Field>
            <Field label="Unit price" htmlFor="d-price"><Input id="d-price" required inputMode="decimal" value={f.unitPrice} onChange={(e) => setF({ ...f, unitPrice: e.target.value })} /></Field>
            <Field label={sales ? 'Revenue account' : 'Expense account'} htmlFor="d-acct"><Select id="d-acct" required value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}><option value="">Select…</option>{lineAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
            <Field label="Tax code" htmlFor="d-tax"><Select id="d-tax" required value={f.taxCodeId} onChange={(e) => setF({ ...f, taxCodeId: e.target.value })}><option value="">Select…</option>{(taxCodes ?? []).map((t) => <option key={t.id} value={t.id}>{t.code} · {t.name}</option>)}</Select></Field>
            <div className="flex flex-col justify-end gap-2 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={f.taxInclusive} onChange={(e) => setF({ ...f, taxInclusive: e.target.checked })} /> Prices include tax</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={f.credit} onChange={(e) => setF({ ...f, credit: e.target.checked })} /> {sales ? 'Credit note' : 'Vendor credit'}</label>
            </div>
            <div className="sm:col-span-3"><Button type="submit">Save draft</Button></div>
          </form></CardContent></Card>
      )}
    </div>
  );
}
