'use client';
import { useState, type FormEvent } from 'react';
import { PageTitle, Table, Td } from '@/components/accounting/bits';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney, today, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Exp { id: string; date: string; description: string; status: string; total: string; taxTotal: string }
interface Opt { id: string; code: string; name: string; type?: string; role?: string | null }

export default function ExpensesPage() {
  const { companyId, can } = useCompany();
  const base = `/companies/${companyId}`;
  const { data, reload, error } = useApi<Exp[]>(`${base}/expenses`);
  const { data: accounts } = useApi<Opt[]>(can('accounts:view') ? `${base}/accounts` : null);
  const { data: codes } = useApi<Opt[]>(can('taxes:view') ? `${base}/tax-codes` : null);
  const [f, setF] = useState({ date: today(), description: '', amount: '', accountId: '', taxCodeId: '', paidFromAccountId: '' });
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); await reload(); } catch (x) { setErr(errorMessage(x)); } };
  const tone = (s: string) => (s === 'POSTED' ? 'success' : s === 'REJECTED' ? 'danger' : 'warning');
  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(() => api(`${base}/expenses`, { method: 'POST', body: { date: f.date, description: f.description, paidFromAccountId: f.paidFromAccountId, taxInclusive: true, lines: [{ description: f.description, amount: f.amount, accountId: f.accountId, taxCodeId: f.taxCodeId }] } }));
  }
  return (
    <div className="space-y-4">
      <PageTitle>Expenses</PageTitle>
      <FormError message={err ?? (error ? errorMessage(error) : null)} />
      {data && data.length === 0 ? <Card><EmptyState title="No expenses yet" /></Card> : (
        <Table head={['Date', 'Description', 'Total', 'Tax', 'Status', '']} right={[2, 3]}>
          {(data ?? []).map((x) => (
            <tr key={x.id}><Td>{x.date.slice(0, 10)}</Td><Td>{x.description}</Td><Td right>{fmtMoney(x.total)}</Td><Td right>{fmtMoney(x.taxTotal)}</Td><Td><Badge tone={tone(x.status)}>{x.status.toLowerCase()}</Badge></Td>
              <Td><div className="flex gap-1">
                {x.status === 'SUBMITTED' && can('expenses:approve') && <><Button size="sm" onClick={() => void run(() => api(`${base}/expenses/${x.id}/approve`, { method: 'POST', body: {} }))}>Approve</Button><Button size="sm" variant="outline" onClick={() => void run(() => api(`${base}/expenses/${x.id}/reject`, { method: 'POST', body: {} }))}>Reject</Button></>}
                {x.status === 'APPROVED' && can('expenses:post') && <Button size="sm" onClick={() => void run(() => api(`${base}/expenses/${x.id}/post`, { method: 'POST' }))}>Post to ledger</Button>}
              </div></Td></tr>
          ))}
        </Table>
      )}
      {can('expenses:create') && (
        <Card><CardHeader><CardTitle>Submit an expense (amount includes tax)</CardTitle></CardHeader><CardContent>
          {!accounts || !codes ? <p className="text-sm text-muted-foreground">Your role can submit expenses through the API; the form needs access to accounts and tax codes.</p> : (
            <form onSubmit={submit} className="grid gap-4 sm:grid-cols-3">
              <Field label="Date" htmlFor="x-date"><Input id="x-date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
              <Field label="Description" htmlFor="x-desc"><Input id="x-desc" required value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
              <Field label="Amount (incl. tax)" htmlFor="x-amt"><Input id="x-amt" required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
              <Field label="Expense account" htmlFor="x-acct"><Select id="x-acct" required value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}><option value="">Select…</option>{accounts.filter((a) => a.type === 'EXPENSE').map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
              <Field label="Tax code" htmlFor="x-tax"><Select id="x-tax" required value={f.taxCodeId} onChange={(e) => setF({ ...f, taxCodeId: e.target.value })}><option value="">Select…</option>{codes.map((t) => <option key={t.id} value={t.id}>{t.code} · {t.name}</option>)}</Select></Field>
              <Field label="Paid from" htmlFor="x-from"><Select id="x-from" required value={f.paidFromAccountId} onChange={(e) => setF({ ...f, paidFromAccountId: e.target.value })}><option value="">Select…</option>{accounts.filter((a) => !a.role && ['ASSET', 'LIABILITY'].includes(a.type ?? '')).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
              <div className="sm:col-span-3"><Button type="submit">Submit for approval</Button></div>
            </form>)}
        </CardContent></Card>
      )}
    </div>
  );
}
