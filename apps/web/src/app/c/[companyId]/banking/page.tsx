'use client';
import { CheckCircle2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { PageTitle, Table, Td } from '@/components/accounting/bits';
import { ImportPanel } from '@/components/banking/import-dialog';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney, today, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface BankAccount { id: string; name: string; kind: string; mask: string | null; ledgerAccountId: string; isActive: boolean; connection: { status: string; institutionName: string | null; lastError: string | null } | null; health: { unmatched: number; ledgerBalance: string; latestTransaction: string | null; lastReconciledThrough: string | null } }
interface Suggestion { id: string; confidence: number; reasons: string[]; entry: { number: number | null; date: string; memo: string | null; sourceType: string } | null }
interface Txn { id: string; bankAccountId: string; date: string; description: string; amount: string; status: string; suggestions: Suggestion[]; suggestedAccount: { code: string } | null; suggestedAccountId: string | null; matchedEntry: { number: number | null; sourceType: string } | null }
interface Acct { id: string; code: string; name: string; type: string; role: string | null }
interface Tax { id: string; code: string; name: string }
interface DocSuggestion { kind: string; documentId: string; number: string | null; contactId: string; contactName: string; outstanding: string; confidence: number; reasons: string[] }

const tone = (s: string) => (s === 'RECONCILED' ? 'success' : s === 'MATCHED' ? 'success' : s === 'IGNORED' ? 'neutral' : 'warning') as 'success' | 'warning' | 'neutral';
const pct = (c: number) => `${Math.round(c * 100)}%`;
const ctone = (c: number) => (c >= 0.9 ? 'success' : c >= 0.75 ? 'warning' : 'neutral') as 'success' | 'warning' | 'neutral';

// ------------------------------------------------------------------ accounts
function Accounts({ companyId, canCreate }: { companyId: string; canCreate: boolean }) {
  const base = `/companies/${companyId}/banking`;
  const { data, reload, error } = useApi<BankAccount[]>(`${base}/accounts`);
  const { data: ledger } = useApi<Acct[]>(canCreate ? `/companies/${companyId}/accounts` : null);
  const [imp, setImp] = useState<BankAccount | null>(null);
  const [f, setF] = useState({ name: '', kind: 'CHEQUING', mask: '', ledgerAccountId: '', code: '', ledgerName: '' });
  const [err, setErr] = useState<string | null>(null);
  const wantType = f.kind === 'CREDIT_CARD' ? 'LIABILITY' : 'ASSET';
  async function add(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try {
      await api(`${base}/accounts`, { method: 'POST', body: { name: f.name, kind: f.kind, mask: f.mask || undefined, ...(f.ledgerAccountId ? { ledgerAccountId: f.ledgerAccountId } : { newLedgerAccount: { code: f.code, name: f.ledgerName || f.name } }) } });
      setF({ ...f, name: '', mask: '', code: '', ledgerName: '', ledgerAccountId: '' }); await reload();
    } catch (x) { setErr(errorMessage(x)); }
  }
  return (
    <div className="space-y-4">
      <FormError message={err ?? (error ? errorMessage(error) : null)} />
      {data && data.length === 0 && <Card><EmptyState title="No bank accounts yet">Add a bank or credit-card account, then import a statement or connect your bank.</EmptyState></Card>}
      <div className="grid gap-4 md:grid-cols-2">
        {(data ?? []).map((a) => (
          <Card key={a.id}><CardContent className="space-y-3 p-5">
            <div className="flex items-center gap-2"><h2 className="font-semibold">{a.name}</h2><Badge>{a.kind.replace('_', ' ').toLowerCase()}</Badge>{a.mask && <span className="text-xs text-muted-foreground">••{a.mask}</span>}{a.connection && <Badge tone={a.connection.status === 'CONNECTED' ? 'success' : 'danger'}>{a.connection.institutionName ?? 'linked'}</Badge>}</div>
            <dl className="grid grid-cols-3 gap-2 text-sm">
              <div><dt className="text-muted-foreground">Books balance</dt><dd className="font-medium">{fmtMoney(a.health.ledgerBalance)}</dd></div>
              <div><dt className="text-muted-foreground">To review</dt><dd className={a.health.unmatched ? 'font-medium text-warning' : ''}>{a.health.unmatched}</dd></div>
              <div><dt className="text-muted-foreground">Reconciled to</dt><dd>{a.health.lastReconciledThrough?.slice(0, 10) ?? '—'}</dd></div>
            </dl>
            {canCreate && <Button size="sm" variant="outline" onClick={() => setImp(a)}>Import statement</Button>}
          </CardContent></Card>
        ))}
      </div>
      {imp && <ImportPanel companyId={companyId} accountId={imp.id} accountName={imp.name} onDone={() => void reload()} onClose={() => setImp(null)} />}
      {canCreate && (
        <Card><CardHeader><CardTitle>Add a bank or credit-card account</CardTitle></CardHeader><CardContent>
          <form onSubmit={add} className="grid gap-4 sm:grid-cols-3">
            <Field label="Name" htmlFor="ba-name"><Input id="ba-name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Type" htmlFor="ba-kind"><Select id="ba-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, ledgerAccountId: '' })}><option value="CHEQUING">Chequing</option><option value="SAVINGS">Savings</option><option value="CREDIT_CARD">Credit card</option></Select></Field>
            <Field label="Last 4 digits (optional)" htmlFor="ba-mask"><Input id="ba-mask" maxLength={4} value={f.mask} onChange={(e) => setF({ ...f, mask: e.target.value })} /></Field>
            <Field label="Use existing ledger account" htmlFor="ba-led"><Select id="ba-led" value={f.ledgerAccountId} onChange={(e) => setF({ ...f, ledgerAccountId: e.target.value })}><option value="">— or create a new one →</option>{(ledger ?? []).filter((a) => !a.role && a.type === wantType).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
            {!f.ledgerAccountId && <><Field label="New account code" htmlFor="ba-code"><Input id="ba-code" required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field><Field label="New account name" htmlFor="ba-lname"><Input id="ba-lname" value={f.ledgerName} placeholder={f.name} onChange={(e) => setF({ ...f, ledgerName: e.target.value })} /></Field></>}
            <div className="sm:col-span-3"><Button type="submit">Add account</Button></div>
          </form></CardContent></Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ transactions
function Row({ t, accounts, taxCodes, bankAccounts, perms, reload, setErr, base }: { t: Txn; accounts: Acct[]; taxCodes: Tax[]; bankAccounts: BankAccount[]; perms: { approve: boolean; post: boolean; reverse: boolean }; reload: () => Promise<unknown>; setErr: (s: string | null) => void; base: string }) {
  const [mode, setMode] = useState<null | 'categorize' | 'invoice' | 'transfer'>(null);
  const [lines, setLines] = useState([{ accountId: t.suggestedAccountId ?? '', amount: String(Math.abs(Number(t.amount)).toFixed(2)), taxCodeId: '' }]);
  const [inclusive, setInclusive] = useState(true);
  const [docs, setDocs] = useState<DocSuggestion[] | null>(null);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [to, setTo] = useState('');
  const out = Number(t.amount) < 0;
  const act = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); setMode(null); await reload(); } catch (x) { setErr(errorMessage(x)); } };
  const top = t.suggestions[0];
  const sum = lines.reduce((s, l) => s + Math.round(parseFloat(l.amount || '0') * 100), 0);
  const need = Math.round(Math.abs(Number(t.amount)) * 100);
  return (
    <>
      <tr>
        <Td>{t.date.slice(0, 10)}</Td><Td>{t.description}{t.suggestedAccount && <div className="text-xs text-muted-foreground">rule suggests {t.suggestedAccount.code}</div>}</Td>
        <Td right><span className={out ? '' : 'text-success'}>{fmtMoney(t.amount)}</span></Td>
        <Td><Badge tone={tone(t.status)}>{t.status.toLowerCase()}</Badge>{t.matchedEntry && <div className="text-xs text-muted-foreground">{t.matchedEntry.sourceType} #{t.matchedEntry.number}</div>}</Td>
        <Td>
          {t.status === 'UNMATCHED' && (
            <div className="space-y-1">
              {top && perms.approve && (
                <div className="flex flex-wrap items-center gap-1 text-xs"><Badge tone={ctone(top.confidence)}>{pct(top.confidence)}</Badge><span className="max-w-[16rem] truncate" title={top.reasons.join(', ')}>{top.entry?.memo ?? top.entry?.sourceType} · {top.entry?.date.slice(0, 10)}</span>
                  <Button size="sm" onClick={() => void act(() => api(`${base}/matches/${top.id}/approve`, { method: 'POST' }))}>Match</Button><Button size="sm" variant="ghost" onClick={() => void act(() => api(`${base}/matches/${top.id}/reject`, { method: 'POST' }))}>No</Button></div>)}
              {perms.post && <div className="flex flex-wrap gap-1">
                <Button size="sm" variant="outline" onClick={() => setMode(mode === 'categorize' ? null : 'categorize')}>Categorize</Button>
                <Button size="sm" variant="outline" onClick={() => { setMode('invoice'); void api<DocSuggestion[]>(`${base}/transactions/${t.id}/documents`).then(setDocs); }}>{out ? 'Pay bill' : 'Receive payment'}</Button>
                <Button size="sm" variant="outline" onClick={() => setMode(mode === 'transfer' ? null : 'transfer')}>Transfer</Button>
                {perms.approve && <Button size="sm" variant="ghost" onClick={() => void act(() => api(`${base}/transactions/${t.id}/ignore`, { method: 'POST', body: {} }))}>Ignore</Button>}
              </div>}
            </div>
          )}
          {t.status === 'MATCHED' && perms.approve && <Button size="sm" variant="ghost" onClick={() => void act(() => api(`${base}/transactions/${t.id}/${t.matchedEntry?.sourceType === 'bank_txn' || t.matchedEntry?.sourceType === 'bank_transfer' ? 'undo' : 'unmatch'}`, { method: 'POST' }))}>Undo</Button>}
          {t.status === 'IGNORED' && perms.approve && <Button size="sm" variant="ghost" onClick={() => void act(() => api(`${base}/transactions/${t.id}/unignore`, { method: 'POST' }))}>Restore</Button>}
        </Td>
      </tr>
      {mode && (
        <tr><td colSpan={5} className="border-b bg-muted/40 p-4">
          {mode === 'categorize' && (
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void act(() => api(`${base}/transactions/${t.id}/categorize`, { method: 'POST', body: { taxInclusive: inclusive, lines: lines.map((l) => ({ accountId: l.accountId, amount: l.amount, ...(l.taxCodeId ? { taxCodeId: l.taxCodeId } : {}) })) } })); }}>
              {lines.map((l, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[1fr_8rem_12rem]">
                  <Select aria-label={`Account, line ${i + 1}`} required value={l.accountId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, accountId: e.target.value } : x)))}><option value="">Account…</option>{accounts.filter((a) => !a.role && !bankAccounts.some((b) => b.ledgerAccountId === a.id)).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select>
                  <Input aria-label={`Amount, line ${i + 1}`} required inputMode="decimal" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                  <Select aria-label={`Tax, line ${i + 1}`} value={l.taxCodeId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, taxCodeId: e.target.value } : x)))}><option value="">No tax</option>{taxCodes.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}</Select>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <Button type="button" size="sm" variant="outline" onClick={() => setLines([...lines, { accountId: '', amount: '', taxCodeId: '' }])}>Split</Button>
                <label className="flex items-center gap-1"><input type="checkbox" checked={inclusive} onChange={(e) => setInclusive(e.target.checked)} /> Amounts include tax</label>
                <span className={sum === need || !inclusive ? 'text-muted-foreground' : 'text-warning'}>{inclusive ? (sum === need ? 'Adds up' : `Lines total ${(sum / 100).toFixed(2)} of ${(need / 100).toFixed(2)}`) : 'Tax is added on top; the server checks the total'}</span>
                <Button type="submit" size="sm" className="ml-auto">Post entry</Button>
              </div>
            </form>
          )}
          {mode === 'invoice' && (
            <div className="space-y-2 text-sm">
              {docs === null ? 'Looking for open documents…' : docs.length === 0 ? 'No open invoice/bill looks like this transaction. Use Categorize instead.' : docs.map((d) => (
                <div key={d.documentId} className="flex flex-wrap items-center gap-2"><Badge tone={ctone(d.confidence)}>{pct(d.confidence)}</Badge><span>{d.number} · {d.contactName} · outstanding {fmtMoney(d.outstanding)}</span>
                  <Input aria-label={`Amount applied to ${d.number}`} className="w-28" value={alloc[d.documentId] ?? Math.min(Math.abs(Number(t.amount)), Number(d.outstanding)).toFixed(2)} onChange={(e) => setAlloc({ ...alloc, [d.documentId]: e.target.value })} />
                  <Button size="sm" onClick={() => void act(() => api(`${base}/transactions/${t.id}/settle`, { method: 'POST', body: { contactId: d.contactId, allocations: [{ documentId: d.documentId, amount: alloc[d.documentId] ?? Math.min(Math.abs(Number(t.amount)), Number(d.outstanding)).toFixed(2) }] } }))}>Apply payment</Button></div>
              ))}
            </div>
          )}
          {mode === 'transfer' && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label={out ? 'Money went to' : 'Money came from'} htmlFor={`tr-${t.id}`}><Select id={`tr-${t.id}`} value={to} onChange={(e) => setTo(e.target.value)}><option value="">Select account…</option>{bankAccounts.filter((b) => b.id !== t.bankAccountId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
              <Button size="sm" disabled={!to} onClick={() => void act(() => api(`${base}/transactions/${t.id}/transfer`, { method: 'POST', body: { toBankAccountId: to } }))}>Record transfer</Button>
            </div>
          )}
        </td></tr>
      )}
    </>
  );
}

function Transactions({ companyId, perms }: { companyId: string; perms: { approve: boolean; post: boolean; reverse: boolean; create: boolean } }) {
  const base = `/companies/${companyId}/banking`;
  const { data: accts } = useApi<BankAccount[]>(`${base}/accounts`);
  const [acct, setAcct] = useState('');
  const [status, setStatus] = useState('UNMATCHED');
  const [q, setQ] = useState('');
  const qs = new URLSearchParams({ ...(acct ? { bankAccountId: acct } : {}), ...(status ? { status } : {}), ...(q ? { search: q } : {}), take: '100' });
  const { data, reload, error } = useApi<{ items: Txn[] }>(`${base}/transactions?${qs}`);
  const { data: ledger } = useApi<Acct[]>(perms.post ? `/companies/${companyId}/accounts` : null);
  const { data: taxes } = useApi<Tax[]>(perms.post ? `/companies/${companyId}/tax-codes` : null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const flat = async () => { await reload(); };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Account" htmlFor="tf-acct"><Select id="tf-acct" value={acct} onChange={(e) => setAcct(e.target.value)}><option value="">All accounts</option>{(accts ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Field label="Status" htmlFor="tf-st"><Select id="tf-st" value={status} onChange={(e) => setStatus(e.target.value)}><option value="UNMATCHED">To review</option><option value="MATCHED">Matched</option><option value="RECONCILED">Reconciled</option><option value="IGNORED">Ignored</option><option value="">All</option></Select></Field>
        <Field label="Search" htmlFor="tf-q"><Input id="tf-q" value={q} onChange={(e) => setQ(e.target.value)} className="w-48" /></Field>
        {perms.create && acct && <Button variant="outline" onClick={() => void (async () => { setErr(null); try { const r = await api<{ suggestions: number }>(`${base}/accounts/${acct}/suggest`, { method: 'POST' }); setMsg(`${r.suggestions} suggestion(s) refreshed`); await reload(); } catch (x) { setErr(errorMessage(x)); } })()}>Refresh suggestions</Button>}
        {perms.approve && acct && <Button variant="outline" onClick={() => void (async () => { setErr(null); try { const r = await api<{ approved: number }>(`${base}/matches/approve-bulk`, { method: 'POST', body: { bankAccountId: acct, minConfidence: 0.9 } }); setMsg(`Approved ${r.approved} match(es) at 90% or higher`); await reload(); } catch (x) { setErr(errorMessage(x)); } })()}>Approve all ≥ 90%</Button>}
      </div>
      <p className="text-xs text-muted-foreground">Suggestions never change your books. A match only links a bank transaction to an entry that already exists; creating an entry always needs your click.</p>
      {msg && <p role="status" className="text-sm text-success">{msg}</p>}
      <FormError message={err ?? (error ? errorMessage(error) : null)} />
      {data && data.items.length === 0 ? <Card><EmptyState icon={<CheckCircle2 className="h-8 w-8" aria-hidden />} title="Nothing here">Import a statement or change the filters.</EmptyState></Card> : (
        <Table head={['Date', 'Description', 'Amount', 'Status', 'Action']} right={[2]}>
          {(data?.items ?? []).map((t) => <Row key={t.id} t={t} accounts={ledger ?? []} taxCodes={taxes ?? []} bankAccounts={accts ?? []} perms={perms} reload={flat} setErr={setErr} base={base} />)}
        </Table>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ rules
interface Rule { id: string; name: string; priority: number; isActive: boolean; accountId: string; conditions: { descriptionContains?: string[]; direction?: string; minAmount?: string; maxAmount?: string } }
function Rules({ companyId, canCreate }: { companyId: string; canCreate: boolean }) {
  const base = `/companies/${companyId}/banking`;
  const { data, reload } = useApi<Rule[]>(`${base}/rules`);
  const { data: ledger } = useApi<Acct[]>(canCreate ? `/companies/${companyId}/accounts` : null);
  const [f, setF] = useState({ name: '', contains: '', direction: '', accountId: '' });
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Rules suggest an account for matching transactions. They never post anything by themselves.</p>
      <FormError message={err} />{msg && <p role="status" className="text-sm text-success">{msg}</p>}
      {data && data.length === 0 ? <Card><EmptyState title="No rules yet" /></Card> : (
        <Table head={['Priority', 'Rule', 'When description contains', 'Direction', '']}>
          {(data ?? []).map((r) => <tr key={r.id}><Td>{r.priority}</Td><Td>{r.name}</Td><Td>{r.conditions.descriptionContains?.join(', ')}</Td><Td>{r.conditions.direction?.toLowerCase()}</Td><Td>{canCreate && <Button size="sm" variant="ghost" onClick={() => void api(`${base}/rules/${r.id}`, { method: 'DELETE' }).then(reload)}>Delete</Button>}</Td></tr>)}
        </Table>
      )}
      {canCreate && (
        <Card><CardHeader><CardTitle>New rule</CardTitle></CardHeader><CardContent>
          <form className="grid gap-4 sm:grid-cols-4" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { await api(`${base}/rules`, { method: 'POST', body: { name: f.name, conditions: { descriptionContains: f.contains.split(',').map((x) => x.trim()).filter(Boolean), ...(f.direction ? { direction: f.direction } : {}) }, accountId: f.accountId } }); setF({ name: '', contains: '', direction: '', accountId: '' }); await reload(); } catch (x) { setErr(errorMessage(x)); } }}>
            <Field label="Name" htmlFor="r-name"><Input id="r-name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Description contains (comma-separated)" htmlFor="r-c"><Input id="r-c" required value={f.contains} onChange={(e) => setF({ ...f, contains: e.target.value })} /></Field>
            <Field label="Direction" htmlFor="r-d"><Select id="r-d" value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}><option value="">Either</option><option value="OUT">Money out</option><option value="IN">Money in</option></Select></Field>
            <Field label="Suggest account" htmlFor="r-a"><Select id="r-a" required value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}><option value="">Select…</option>{(ledger ?? []).filter((a) => !a.role).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
            <div className="flex gap-2 sm:col-span-4"><Button type="submit">Add rule</Button><Button type="button" variant="outline" onClick={() => void api<{ suggested: number }>(`${base}/rules/apply`, { method: 'POST' }).then((r) => setMsg(`${r.suggested} transaction(s) now have a suggested account`))}>Apply to unmatched transactions</Button></div>
          </form></CardContent></Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ reconciliation
interface Pv { summary: { opening: string; cleared: string; computedEnding: string; statementEnding: string; difference: string; balanced: boolean }; printedStatementBalance: string; cleared: { id: string; date: string; description: string; amount: string }[]; unmatchedBankTransactions: { id: string }[]; outstandingLedgerItems: { lineId: string; date: string; memo: string | null; amount: string }[]; bookVsBank: { ledgerBalance: string; outstandingNet: string; unexplained: string }; warnings: string[] }
interface Rec { id: string; statementDate: string; statementBalance: string; clearedTotal: string; txnCount: number; status: string; bankAccount: { name: string }; completedAt: string }
function Reconcile({ companyId, canPost, canReverse }: { companyId: string; canPost: boolean; canReverse: boolean }) {
  const base = `/companies/${companyId}/banking`;
  const { data: accts } = useApi<BankAccount[]>(`${base}/accounts`);
  const { data: hist, reload } = useApi<Rec[]>(`${base}/reconciliations`);
  const [acct, setAcct] = useState('');
  const [date, setDate] = useState(today());
  const [bal, setBal] = useState('');
  const [open, setOpen] = useState('');
  const [pv, setPv] = useState<Pv | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<{ summary: Pv['summary']; cleared: Pv['cleared']; outstandingLedgerItems: Pv['outstandingLedgerItems'] } | null>(null);
  const selected = accts?.find((a) => a.id === acct);
  const first = !hist?.some((r) => r.status === 'COMPLETED' && (r as unknown as { bankAccountId: string }).bankAccountId === acct);
  const q = new URLSearchParams({ statementDate: date, statementBalance: bal, ...(open ? { openingBalance: open } : {}) });
  async function preview() { setErr(null); setPv(null); try { setPv(await api<Pv>(`${base}/accounts/${acct}/reconciliation-preview?${q}`)); } catch (x) { setErr(errorMessage(x)); } }
  async function complete() { setErr(null); try { await api(`${base}/accounts/${acct}/reconciliations`, { method: 'POST', body: { statementDate: date, statementBalance: bal, ...(open ? { openingBalance: open } : {}) } }); setPv(null); await reload(); } catch (x) { setErr(errorMessage(x)); } }
  return (
    <div className="space-y-4">
      <Card><CardHeader><CardTitle>Reconcile to a statement</CardTitle></CardHeader><CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Account" htmlFor="rc-a"><Select id="rc-a" value={acct} onChange={(e) => { setAcct(e.target.value); setPv(null); }}><option value="">Select…</option>{(accts ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
          <Field label="Statement end date" htmlFor="rc-d"><Input id="rc-d" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label={selected?.kind === 'CREDIT_CARD' ? 'Ending balance (amount owed)' : 'Ending balance'} htmlFor="rc-b"><Input id="rc-b" inputMode="decimal" value={bal} onChange={(e) => setBal(e.target.value)} /></Field>
          {first && acct && <Field label="Opening balance (first time only)" htmlFor="rc-o" hint="The statement's beginning balance"><Input id="rc-o" inputMode="decimal" value={open} onChange={(e) => setOpen(e.target.value)} /></Field>}
        </div>
        <FormError message={err} />
        <Button variant="outline" disabled={!acct || !bal} onClick={() => void preview()}>Preview</Button>
        {pv && (
          <div className="space-y-3">
            <div className="grid gap-2 text-sm sm:grid-cols-5">{[['Opening', pv.summary.opening], ['+ Cleared', pv.summary.cleared], ['= Computed', pv.summary.computedEnding], ['Statement', pv.summary.statementEnding], ['Difference', pv.summary.difference]].map(([l, v]) => <div key={l} className="rounded-md border p-2"><div className="text-muted-foreground">{l}</div><div className="font-medium">{fmtMoney(v)}</div></div>)}</div>
            {pv.summary.balanced ? <Badge tone="success">Balanced to the cent</Badge> : <Badge tone="danger">Out by {fmtMoney(pv.summary.difference)}</Badge>}
            {pv.warnings.map((w) => <p key={w} className="text-sm text-warning">⚠ {w}</p>)}
            <details><summary className="cursor-pointer text-sm font-medium">{pv.cleared.length} cleared · {pv.outstandingLedgerItems.length} outstanding in the books · {pv.unmatchedBankTransactions.length} unmatched at the bank</summary>
              <Table head={['Date', 'Cleared item', 'Amount']} right={[2]}>{pv.cleared.map((t) => <tr key={t.id}><Td>{t.date.slice(0, 10)}</Td><Td>{t.description}</Td><Td right>{fmtMoney(t.amount)}</Td></tr>)}</Table>
              {pv.outstandingLedgerItems.length > 0 && <Table head={['Date', 'Outstanding (in books, not at bank)', 'Amount']} right={[2]}>{pv.outstandingLedgerItems.map((t) => <tr key={t.lineId}><Td>{t.date.slice(0, 10)}</Td><Td>{t.memo}</Td><Td right>{fmtMoney(t.amount)}</Td></tr>)}</Table>}
            </details>
            {canPost && <Button disabled={!pv.summary.balanced} onClick={() => void complete()}>Complete and lock</Button>}
          </div>
        )}
      </CardContent></Card>
      <h2 className="text-lg font-semibold">History</h2>
      {hist && hist.length === 0 ? <Card><EmptyState title="No reconciliations yet" /></Card> : (
        <Table head={['Statement date', 'Account', 'Balance', 'Items', 'Status', '']} right={[2]}>
          {(hist ?? []).map((r) => <tr key={r.id}><Td>{r.statementDate.slice(0, 10)}</Td><Td>{r.bankAccount.name}</Td><Td right>{fmtMoney(r.statementBalance)}</Td><Td>{r.txnCount}</Td><Td><Badge tone={r.status === 'COMPLETED' ? 'success' : 'warning'}>{r.status.toLowerCase()}</Badge></Td>
            <Td><div className="flex gap-1"><Button size="sm" variant="outline" onClick={() => void api<typeof report>(`${base}/reconciliations/${r.id}`).then(setReport)}>Report</Button>{canReverse && r.status === 'COMPLETED' && <Button size="sm" variant="ghost" onClick={() => void api(`${base}/reconciliations/${r.id}/reopen`, { method: 'POST' }).then(reload).catch((x) => setErr(errorMessage(x)))}>Reopen</Button>}</div></Td></tr>)}
        </Table>
      )}
      {report && <Card><CardHeader><CardTitle>Reconciliation report</CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><p>Opening {fmtMoney(report.summary.opening)} + cleared {fmtMoney(report.summary.cleared)} = {fmtMoney(report.summary.computedEnding)} (statement {fmtMoney(report.summary.statementEnding)})</p><Table head={['Date', 'Cleared item', 'Amount']} right={[2]}>{report.cleared.map((t) => <tr key={t.id}><Td>{t.date.slice(0, 10)}</Td><Td>{t.description}</Td><Td right>{fmtMoney(t.amount)}</Td></tr>)}</Table>{report.outstandingLedgerItems.length > 0 && <p>Outstanding at the time: {report.outstandingLedgerItems.map((o) => `${o.memo ?? 'item'} ${fmtMoney(o.amount)}`).join('; ')}</p>}</CardContent></Card>}
    </div>
  );
}

// ------------------------------------------------------------------ connections (Plaid Link)
declare global { interface Window { Plaid?: { create: (o: { token: string; onSuccess: (publicToken: string, meta: { institution?: { name?: string } }) => void; onExit: () => void }) => { open: () => void } } } }
interface Conns { provider: string | null; configured: boolean; connections: { id: string; institutionName: string | null; status: string; lastSyncAt: string | null; lastError: string | null; accounts: { id: string; name: string }[] }[] }
interface PAccount { providerAccountId: string; name: string; mask: string | null; kind: string; currentBalance: string | null }
function Connections({ companyId, canManage, canSync }: { companyId: string; canManage: boolean; canSync: boolean }) {
  const base = `/companies/${companyId}/banking`;
  const { data, reload } = useApi<Conns>(`${base}/connections`);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; accounts: PAccount[] } | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (!document.getElementById('plaid-link')) { const s = document.createElement('script'); s.id = 'plaid-link'; s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js'; s.async = true; document.body.appendChild(s); } }, []);
  async function link() {
    setErr(null);
    try {
      const { linkToken } = await api<{ linkToken: string }>(`${base}/connections/link-token`, { method: 'POST' });
      if (!window.Plaid) throw new Error('Plaid Link could not be loaded (is cdn.plaid.com reachable from this browser?)');
      window.Plaid.create({ token: linkToken, onExit: () => undefined, onSuccess: (publicToken, meta) => void api<{ connectionId: string; accounts: PAccount[] }>(`${base}/connections/exchange`, { method: 'POST', body: { publicToken, institutionName: meta.institution?.name } }).then((r) => setPending({ id: r.connectionId, accounts: r.accounts })).catch((x) => setErr(errorMessage(x))) }).open();
    } catch (x) { setErr(errorMessage(x)); }
  }
  async function mapAccounts() {
    if (!pending) return; setErr(null);
    try { await api(`${base}/connections/${pending.id}/accounts`, { method: 'POST', body: { accounts: pending.accounts.filter((a) => codes[a.providerAccountId]).map((a) => ({ providerAccountId: a.providerAccountId, name: a.name, kind: a.kind === 'CREDIT_CARD' ? 'CREDIT_CARD' : a.kind === 'SAVINGS' ? 'SAVINGS' : 'CHEQUING', mask: a.mask ?? undefined, newLedgerAccount: { code: codes[a.providerAccountId], name: a.name } })) } }); setPending(null); await reload(); } catch (x) { setErr(errorMessage(x)); }
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Bank connections go through your aggregation provider’s own sign-in window. This system never sees or stores your online-banking password. CSV/OFX import always works without it.</p>
      <FormError message={err} />{msg && <p role="status" className="text-sm text-success">{msg}</p>}
      {data && !data.configured && <Card><EmptyState title="Bank connections are not configured">Set <code>PLAID_CLIENT_ID</code> and <code>PLAID_SECRET</code> on the server (see docs/banking-setup.md). Flinks is not implemented.</EmptyState></Card>}
      {(data?.connections ?? []).map((c) => (
        <Card key={c.id}><CardContent className="space-y-2 p-5">
          <div className="flex items-center gap-2"><h2 className="font-semibold">{c.institutionName ?? 'Bank'}</h2><Badge tone={c.status === 'CONNECTED' ? 'success' : 'danger'}>{c.status.toLowerCase()}</Badge><span className="text-xs text-muted-foreground">last sync {c.lastSyncAt?.slice(0, 16).replace('T', ' ') ?? 'never'}</span></div>
          {c.lastError && <p className="text-sm text-destructive">{c.lastError}</p>}
          <p className="text-sm text-muted-foreground">{c.accounts.map((a) => a.name).join(', ') || 'No accounts mapped yet'}</p>
          <div className="flex gap-2">{canSync && c.status !== 'REMOVED' && <Button size="sm" onClick={() => void api<{ added: number }>(`${base}/connections/${c.id}/sync`, { method: 'POST' }).then((r) => { setMsg(`${r.added} new transaction(s)`); return reload(); }).catch((x) => setErr(errorMessage(x)))}>Sync now</Button>}{canManage && c.status !== 'REMOVED' && <Button size="sm" variant="ghost" onClick={() => void api(`${base}/connections/${c.id}`, { method: 'DELETE' }).then(reload)}>Disconnect</Button>}</div>
        </CardContent></Card>
      ))}
      {pending && (
        <Card><CardHeader><CardTitle>Choose which accounts to import</CardTitle></CardHeader><CardContent className="space-y-3">
          {pending.accounts.map((a) => <div key={a.providerAccountId} className="grid items-end gap-2 sm:grid-cols-3"><div className="text-sm"><div className="font-medium">{a.name} {a.mask && `••${a.mask}`}</div><div className="text-muted-foreground">{a.kind.toLowerCase()} · balance {a.currentBalance ? fmtMoney(a.currentBalance) : '—'}</div></div><Field label="New ledger account code (blank = skip)" htmlFor={`pc-${a.providerAccountId}`}><Input id={`pc-${a.providerAccountId}`} value={codes[a.providerAccountId] ?? ''} onChange={(e) => setCodes({ ...codes, [a.providerAccountId]: e.target.value })} /></Field></div>)}
          <Button onClick={() => void mapAccounts()}>Link accounts</Button>
        </CardContent></Card>
      )}
      {canManage && data?.configured && <Button onClick={() => void link()}>Connect a bank</Button>}
    </div>
  );
}

export default function BankingPage() {
  const { companyId, can } = useCompany();
  const perms = { approve: can('banking:approve'), post: can('banking:post'), reverse: can('banking:reverse'), create: can('banking:create') };
  return (
    <div className="space-y-4">
      <PageTitle>Banking</PageTitle>
      <Tabs defaultValue="accounts">
        <TabsList><TabsTrigger value="accounts">Accounts</TabsTrigger><TabsTrigger value="transactions">Transactions</TabsTrigger><TabsTrigger value="rules">Rules</TabsTrigger><TabsTrigger value="reconcile">Reconcile</TabsTrigger><TabsTrigger value="connections">Connections</TabsTrigger></TabsList>
        <TabsContent value="accounts"><Accounts companyId={companyId} canCreate={perms.create} /></TabsContent>
        <TabsContent value="transactions"><Transactions companyId={companyId} perms={perms} /></TabsContent>
        <TabsContent value="rules"><Rules companyId={companyId} canCreate={perms.create} /></TabsContent>
        <TabsContent value="reconcile"><Reconcile companyId={companyId} canPost={perms.post} canReverse={perms.reverse} /></TabsContent>
        <TabsContent value="connections"><Connections companyId={companyId} canManage={can('settings:create')} canSync={perms.create} /></TabsContent>
      </Tabs>
    </div>
  );
}
