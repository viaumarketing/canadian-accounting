'use client';
import { useState, type FormEvent } from 'react';
import { PageTitle, Table, Td } from '@/components/accounting/bits';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney, today, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Account { id: string; code: string; name: string; type: string; role: string | null; cashFlow: 'OPERATING' | 'INVESTING' | 'FINANCING' | null }
interface Journal { id: string; number: number | null; date: string; memo: string | null; status: string; sourceType: string; lines: { id: string; debit: string; credit: string; account: { code: string; name: string } }[] }

function Chart({ companyId, canEdit }: { companyId: string; canEdit: boolean }) {
  const { data, reload, error } = useApi<Account[]>(`/companies/${companyId}/accounts`);
  const [f, setF] = useState({ code: '', name: '', type: 'EXPENSE' });
  const [err, setErr] = useState<string | null>(null);
  async function add(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try { await api(`/companies/${companyId}/accounts`, { method: 'POST', body: f }); setF({ ...f, code: '', name: '' }); await reload(); } catch (x) { setErr(errorMessage(x)); }
  }
  async function setCashFlow(a: Account, v: string) {
    setErr(null);
    try { await api(`/companies/${companyId}/accounts/${a.id}`, { method: 'PATCH', body: { cashFlow: v || null } }); await reload(); } catch (x) { setErr(errorMessage(x)); }
  }
  const flowDefault = (a: Account) => (a.type === 'EQUITY' ? 'financing' : 'operating');
  return (
    <div className="space-y-4">
      <FormError message={err ?? (error ? errorMessage(error) : null)} />
      <Table head={['Code', 'Name', 'Type', 'Cash-flow section', '']}>
        {(data ?? []).map((a) => (
          <tr key={a.id}>
            <Td mono>{a.code}</Td><Td>{a.name}</Td><Td>{a.type.toLowerCase()}</Td>
            <Td>
              {a.type === 'REVENUE' || a.type === 'EXPENSE' ? <span className="text-xs text-muted-foreground">in net income</span>
                : canEdit ? (
                  <Select aria-label={`Cash-flow section for ${a.code} ${a.name}`} value={a.cashFlow ?? ''} onChange={(e) => void setCashFlow(a, e.target.value)} className="h-8 text-xs">
                    <option value="">Default ({flowDefault(a)})</option><option value="OPERATING">Operating</option><option value="INVESTING">Investing</option><option value="FINANCING">Financing</option>
                  </Select>
                ) : <span className="text-xs">{a.cashFlow ? a.cashFlow.toLowerCase() : `default (${flowDefault(a)})`}</span>}
            </Td>
            <Td>{a.role && <Badge>system</Badge>}</Td>
          </tr>
        ))}
      </Table>
      {canEdit && (
        <Card><CardHeader><CardTitle>Add account</CardTitle></CardHeader><CardContent>
          <form onSubmit={add} className="grid gap-4 sm:grid-cols-4">
            <Field label="Code" htmlFor="a-code"><Input id="a-code" required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
            <Field label="Name" htmlFor="a-name"><Input id="a-name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Type" htmlFor="a-type"><Select id="a-type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'].map((t) => <option key={t}>{t}</option>)}</Select></Field>
            <div className="flex items-end"><Button type="submit">Add</Button></div>
          </form></CardContent></Card>
      )}
    </div>
  );
}

function Journals({ companyId, accounts, canCreate, canPost, canReverse }: { companyId: string; accounts: Account[]; canCreate: boolean; canPost: boolean; canReverse: boolean }) {
  const { data, reload } = useApi<{ items: Journal[] }>(`/companies/${companyId}/journals?take=50`);
  const [date, setDate] = useState(today());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([{ accountId: '', debit: '', credit: '' }, { accountId: '', debit: '', credit: '' }]);
  const [err, setErr] = useState<string | null>(null);
  const sum = (k: 'debit' | 'credit') => lines.reduce((s, l) => s + Math.round(parseFloat(l[k] || '0') * 100), 0); // UI hint only; the server is authoritative
  const diff = sum('debit') - sum('credit');
  async function submit(post: boolean) {
    setErr(null);
    try {
      await api(`/companies/${companyId}/journals`, { method: 'POST', body: { date, memo: memo || undefined, post, lines: lines.filter((l) => l.accountId).map((l) => ({ accountId: l.accountId, debit: l.debit || '0', credit: l.credit || '0' })) } });
      setMemo(''); setLines(lines.map(() => ({ accountId: '', debit: '', credit: '' }))); await reload();
    } catch (x) { setErr(errorMessage(x)); }
  }
  const act = async (path: string, method = 'POST') => { setErr(null); try { await api(`/companies/${companyId}/journals/${path}`, { method, body: method === 'POST' ? {} : undefined }); await reload(); } catch (x) { setErr(errorMessage(x)); } };
  return (
    <div className="space-y-4">
      <FormError message={err} />
      {canCreate && (
        <Card><CardHeader><CardTitle>New journal entry</CardTitle></CardHeader><CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Date" htmlFor="j-date"><Input id="j-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <div className="sm:col-span-2"><Field label="Memo" htmlFor="j-memo"><Input id="j-memo" value={memo} onChange={(e) => setMemo(e.target.value)} /></Field></div>
          </div>
          {lines.map((l, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_8rem_8rem]">
              <Select aria-label={`Account, line ${i + 1}`} value={l.accountId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, accountId: e.target.value } : x)))}>
                <option value="">Select account…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
              </Select>
              <Input aria-label={`Debit, line ${i + 1}`} placeholder="Debit" inputMode="decimal" value={l.debit} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, debit: e.target.value, credit: '' } : x)))} />
              <Input aria-label={`Credit, line ${i + 1}`} placeholder="Credit" inputMode="decimal" value={l.credit} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, credit: e.target.value, debit: '' } : x)))} />
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setLines([...lines, { accountId: '', debit: '', credit: '' }])}>Add line</Button>
            <span className={`text-sm ${diff === 0 ? 'text-success' : 'text-warning'}`} role="status">{diff === 0 ? 'Balanced' : `Out of balance by ${(Math.abs(diff) / 100).toFixed(2)}`}</span>
            <div className="ml-auto flex gap-2">
              <Button variant="secondary" onClick={() => void submit(false)}>Save draft</Button>
              {canPost && <Button onClick={() => void submit(true)}>Post</Button>}
            </div>
          </div>
        </CardContent></Card>
      )}
      {data && data.items.length === 0 ? <Card><EmptyState title="No journal entries yet" /></Card> : (
        <Table head={['#', 'Date', 'Memo', 'Source', 'Debit', 'Status', '']} right={[4]}>
          {(data?.items ?? []).map((j) => (
            <tr key={j.id}>
              <Td mono>{j.number ?? '—'}</Td><Td>{j.date.slice(0, 10)}</Td><Td>{j.memo}</Td><Td>{j.sourceType}</Td>
              <Td right>{fmtMoney(j.lines.reduce((s, l) => s + Math.round(parseFloat(l.debit) * 100), 0) / 100)}</Td>
              <Td><Badge tone={j.status === 'POSTED' ? 'success' : 'warning'}>{j.status.toLowerCase()}</Badge></Td>
              <Td>
                {j.status === 'DRAFT' && canPost && <Button size="sm" variant="outline" onClick={() => void act(`${j.id}/post`)}>Post</Button>}
                {j.status === 'POSTED' && j.sourceType === 'manual' && canReverse && <Button size="sm" variant="outline" onClick={() => void act(`${j.id}/reverse`)}>Reverse</Button>}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

interface FiscalYear { id: string; label: string; startDate: string; endDate: string; status: 'OPEN' | 'CLOSED'; closedAt: string | null }
interface ClosePreview { netIncome: string; lines: { accountId: string; debit: string; credit: string; account: { code: string; name: string } }[]; blockers: { code: string; message: string }[] }

/** Year-end close: review what will be posted, close (locks the year), or reopen the most recent closed year. */
function YearEnd({ companyId, canClose, canReopen }: { companyId: string; canClose: boolean; canReopen: boolean }) {
  const { data, reload, error } = useApi<FiscalYear[]>(`/companies/${companyId}/fiscal-years`);
  const [sel, setSel] = useState<string | null>(null);
  const { data: pv, reload: reloadPv } = useApi<ClosePreview>(sel ? `/companies/${companyId}/fiscal-years/${sel}/close-preview` : null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const years = data ?? [];
  const lastClosed = [...years].reverse().find((y) => y.status === 'CLOSED');
  const firstOpen = years.find((y) => y.status === 'OPEN');
  async function run(id: string, action: 'close' | 'reopen') {
    const y = years.find((x) => x.id === id)!;
    const msg = action === 'close'
      ? `Close ${y.label}? A closing entry moves this year's profit to Retained Earnings and every period of the year is locked.`
      : `Reopen ${y.label}? The closing entry is reversed. Periods stay locked until you unlock the ones you need.`;
    if (!window.confirm(msg)) return;
    setErr(null); setBusy(true);
    try { await api(`/companies/${companyId}/fiscal-years/${id}/${action}`, { method: 'POST', body: {} }); setSel(null); await reload(); } catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Closing a year moves its revenue and expenses into Retained Earnings and locks it. Years close oldest first and reopen newest first. Reports still show a closed year's profit.</p>
      <FormError message={err ?? (error ? errorMessage(error) : null)} />
      <Table head={['Year', 'From', 'To', 'Status', '']}>
        {years.map((y) => (
          <tr key={y.id}>
            <Td>{y.label}</Td><Td>{y.startDate.slice(0, 10)}</Td><Td>{y.endDate.slice(0, 10)}</Td>
            <Td><Badge tone={y.status === 'CLOSED' ? 'neutral' : 'success'}>{y.status === 'CLOSED' ? `closed ${y.closedAt?.slice(0, 10) ?? ''}` : 'open'}</Badge></Td>
            <Td>
              {y.status === 'OPEN' && y.id === firstOpen?.id && <Button size="sm" variant="outline" onClick={() => { setSel(y.id); void reloadPv(); }}>Review close</Button>}
              {y.status === 'CLOSED' && y.id === lastClosed?.id && canReopen && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(y.id, 'reopen')}>Reopen</Button>}
            </Td>
          </tr>
        ))}
      </Table>
      {sel && pv && (
        <Card><CardHeader><CardTitle>Closing entry for {years.find((y) => y.id === sel)?.label}</CardTitle></CardHeader><CardContent className="space-y-3">
          {pv.blockers.length > 0 && <ul className="list-disc pl-5 text-sm text-destructive">{pv.blockers.map((b) => <li key={b.code}>{b.message}</li>)}</ul>}
          {pv.lines.length === 0 ? <p className="text-sm text-muted-foreground">No revenue or expenses in this year: it closes without a journal entry.</p> : (
            <Table head={['Account', 'Debit', 'Credit']} right={[1, 2]}>
              {pv.lines.map((l) => <tr key={l.accountId}><Td>{l.account.code} · {l.account.name}</Td><Td right>{l.debit !== '0' ? fmtMoney(l.debit) : ''}</Td><Td right>{l.credit !== '0' ? fmtMoney(l.credit) : ''}</Td></tr>)}
            </Table>
          )}
          <p className="text-sm">Net {Number(pv.netIncome) < 0 ? 'loss' : 'income'} moved to Retained Earnings: <strong>{fmtMoney(pv.netIncome.replace('-', ''))}</strong></p>
          <div className="flex gap-2">
            {canClose && <Button disabled={busy || pv.blockers.length > 0} onClick={() => void run(sel, 'close')}>Close year</Button>}
            <Button variant="outline" onClick={() => setSel(null)}>Cancel</Button>
          </div>
        </CardContent></Card>
      )}
    </div>
  );
}

interface TB { rows: { accountId: string; code: string; name: string; debit: string; credit: string }[]; totals: { debit: string; credit: string; balanced: boolean } }
function TrialBalance({ companyId }: { companyId: string }) {
  const [asOf, setAsOf] = useState(today());
  const { data, error } = useApi<TB>(`/companies/${companyId}/reports/trial-balance?asOf=${asOf}`);
  return (
    <div className="space-y-4">
      <div className="max-w-xs"><Field label="As of" htmlFor="tb-date"><Input id="tb-date" type="date" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></Field></div>
      <FormError message={error ? errorMessage(error) : null} />
      {data && (data.rows.length === 0 ? <Card><EmptyState title="Nothing posted yet">Posted journals, invoices, bills and payments appear here.</EmptyState></Card> : (
        <Table head={['Code', 'Account', 'Debit', 'Credit']} right={[2, 3]}>
          {data.rows.map((r) => <tr key={r.accountId}><Td mono>{r.code}</Td><Td>{r.name}</Td><Td right>{r.debit !== '0.00' ? fmtMoney(r.debit) : ''}</Td><Td right>{r.credit !== '0.00' ? fmtMoney(r.credit) : ''}</Td></tr>)}
          <tr className="font-semibold"><Td /><Td>Total {data.totals.balanced ? <Badge tone="success">balanced</Badge> : <Badge tone="danger">OUT OF BALANCE</Badge>}</Td><Td right>{fmtMoney(data.totals.debit)}</Td><Td right>{fmtMoney(data.totals.credit)}</Td></tr>
        </Table>
      ))}
    </div>
  );
}

export default function AccountingPage() {
  const { companyId, can } = useCompany();
  const { data: accounts } = useApi<Account[]>(`/companies/${companyId}/accounts`);
  return (
    <div className="space-y-4">
      <PageTitle>Accounting</PageTitle>
      <Tabs defaultValue="journal">
        <TabsList><TabsTrigger value="journal">Journal</TabsTrigger><TabsTrigger value="chart">Chart of accounts</TabsTrigger><TabsTrigger value="tb">Trial balance</TabsTrigger><TabsTrigger value="year-end">Year-end</TabsTrigger></TabsList>
        <TabsContent value="journal"><Journals companyId={companyId} accounts={accounts ?? []} canCreate={can('journal:create')} canPost={can('journal:post')} canReverse={can('journal:reverse')} /></TabsContent>
        <TabsContent value="chart"><Chart companyId={companyId} canEdit={can('accounts:create')} /></TabsContent>
        <TabsContent value="tb">{can('reports:view') ? <TrialBalance companyId={companyId} /> : <FormError message="You do not have access to reports." />}</TabsContent>
        <TabsContent value="year-end"><YearEnd companyId={companyId} canClose={can('journal:approve')} canReopen={can('journal:reverse')} /></TabsContent>
      </Tabs>
    </div>
  );
}
