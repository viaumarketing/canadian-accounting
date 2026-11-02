'use client';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { PageTitle } from '@/components/accounting/bits';
import { ReportView, type ReportData } from '@/components/reports/report-view';
import { Button } from '@/components/ui/button';
import { Card, CardContent, EmptyState } from '@/components/ui/card';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { ApiError, api, errorMessage } from '@/lib/api';
import { today, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Entry { key: string; title: string; group: string; description: string; params: string[] }
interface Acct { id: string; code: string; name: string }
interface Rec { id: string; statementDate: string; bankAccount: { name: string } }

export default function ReportsPage() {
  const { companyId, can } = useCompany();
  const base = `/companies/${companyId}`;
  const { data: catalog } = useApi<Entry[]>(`${base}/report`);
  const { data: accounts } = useApi<Acct[]>(can('accounts:view') ? `${base}/accounts` : null);
  const { data: recs } = useApi<Rec[]>(can('banking:view') ? `${base}/banking/reconciliations` : null);
  const [sel, setSel] = useState<Entry | null>(null);
  const [q, setQ] = useState<Record<string, string>>({});
  const [report, setReport] = useState<ReportData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setQ((x) => ({ ...x, [k]: v }));
  const params = (extra: Record<string, string> = {}) =>
    new URLSearchParams(Object.entries({ ...q, ...extra }).filter(([, v]) => v !== '' && v !== undefined)).toString();
  const has = (p: string) => sel?.params.includes(p);

  async function run(page?: number) {
    if (!sel) return;
    setBusy(true);
    setErr(null);
    try {
      setReport(await api<ReportData>(`${base}/report/${sel.key}?${params(page ? { page: String(page) } : {})}`));
    } catch (e) {
      setReport(null);
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function download(format: 'csv' | 'xlsx' | 'pdf') {
    if (!sel) return;
    setErr(null);
    try {
      const res = await fetch(`/api${base}/report/${sel.key}?${params({ format })}`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'ca-web' } });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new ApiError(res.status, j.code ?? 'ERROR', j.message ?? 'Export failed');
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `${sel.key}.${format}`;
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(errorMessage(e));
    }
  }
  const groups = [...new Set((catalog ?? []).map((c) => c.group))];

  return (
    <div className="space-y-4">
      <PageTitle>Reports</PageTitle>
      <p className="text-sm text-muted-foreground">
        Every report is computed from posted ledger entries and carries checks that tie it back to the ledger. Tax reports are preparation support; nothing is filed from here.
      </p>
      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <nav aria-label="Reports" className="space-y-4">
          {groups.map((g) => (
            <div key={g}>
              <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g}</h2>
              <ul>
                {(catalog ?? []).filter((c) => c.group === g).map((c) => (
                  <li key={c.key}>
                    <button
                      onClick={() => { setSel(c); setReport(null); setErr(null); }}
                      aria-current={sel?.key === c.key ? 'page' : undefined}
                      className={`w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${sel?.key === c.key ? 'bg-accent font-medium' : ''}`}
                    >
                      {c.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="min-w-0 space-y-4">
          {!sel && <Card><EmptyState title="Choose a report">Pick one on the left, set the dates, and run it.</EmptyState></Card>}
          {sel && (
            <Card>
              <CardContent className="space-y-4 p-5">
                <div>
                  <h2 className="font-semibold">{sel.title}</h2>
                  <p className="text-sm text-muted-foreground">{sel.description}</p>
                </div>
                <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void run(1); }}>
                  {has('from') && <Field label="From" htmlFor="rp-from" hint="blank = fiscal-year start"><Input id="rp-from" type="date" value={q.from ?? ''} onChange={(e) => set('from', e.target.value)} /></Field>}
                  {has('to') && <Field label="To" htmlFor="rp-to"><Input id="rp-to" type="date" value={q.to ?? today()} onChange={(e) => set('to', e.target.value)} /></Field>}
                  {has('asOf') && <Field label="As of" htmlFor="rp-asof"><Input id="rp-asof" type="date" value={q.asOf ?? today()} onChange={(e) => set('asOf', e.target.value)} /></Field>}
                  {has('compare') && (
                    <Field label="Compare with" htmlFor="rp-cmp">
                      <Select id="rp-cmp" value={q.compare ?? 'none'} onChange={(e) => set('compare', e.target.value)}>
                        <option value="none">Nothing</option>
                        <option value="prior_period">Previous period</option>
                        <option value="prior_year">Same period last year</option>
                      </Select>
                    </Field>
                  )}
                  {has('weeks') && <Field label="Weeks" htmlFor="rp-weeks"><Input id="rp-weeks" type="number" min={1} max={52} value={q.weeks ?? '13'} onChange={(e) => set('weeks', e.target.value)} className="w-24" /></Field>}
                  {has('accountId') && (
                    <Field label="Account" htmlFor="rp-acct">
                      <Select id="rp-acct" required value={q.accountId ?? ''} onChange={(e) => set('accountId', e.target.value)}>
                        <option value="">Select…</option>
                        {(accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                      </Select>
                    </Field>
                  )}
                  {has('reconciliationId') && (
                    <Field label="Reconciliation" htmlFor="rp-rec">
                      <Select id="rp-rec" required value={q.reconciliationId ?? ''} onChange={(e) => set('reconciliationId', e.target.value)}>
                        <option value="">Select…</option>
                        {(recs ?? []).map((r) => <option key={r.id} value={r.id}>{r.bankAccount.name} · {r.statementDate.slice(0, 10)}</option>)}
                      </Select>
                    </Field>
                  )}
                  <Button type="submit" disabled={busy}>{busy ? 'Running…' : 'Run report'}</Button>
                </form>
                {sel.key === 'tax-gst-hst' && (
                  <details className="text-sm">
                    <summary className="cursor-pointer font-medium">Amounts only you know (lines 104, 107, 110, 111, 205/405, and Quick Method items)</summary>
                    <div className="mt-2 flex flex-wrap gap-3">
                      {([['adj104', 'Line 104 adjustments added'], ['adj107', 'Line 107 adjustments deducted'], ['instalments110', 'Line 110 instalments paid'], ['rebates111', 'Line 111 rebates'], ['selfAssess', 'Line 205/405 self-assessed'], ['itcCapital', 'Quick Method: ITCs on capital/real property'], ['qmOtherSales', 'Quick Method: other eligible sales incl. GST/HST (Shopify, bank)'], ['qmOtherRate', 'Quick Method: their remittance rate (e.g. 0.044)']] as const).map(([k, l]) => (
                        <Field key={k} label={l} htmlFor={`rp-${k}`}><Input id={`rp-${k}`} inputMode="decimal" value={q[k] ?? ''} onChange={(e) => set(k, e.target.value)} className="w-40" /></Field>
                      ))}
                    </div>
                  </details>
                )}
                <FormError message={err} />
                {report && can('reports:export') && (
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Export">
                    {(['csv', 'xlsx', 'pdf'] as const).map((f) => (
                      <Button key={f} size="sm" variant="outline" onClick={() => void download(f)}><Download className="h-4 w-4" aria-hidden /> {f.toUpperCase()}</Button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
          {report && <ReportView r={report} />}
          {report?.paging && report.paging.pages > 1 && (
            <nav aria-label="Report pages" className="flex items-center gap-2 text-sm">
              <Button size="sm" variant="outline" disabled={busy || report.paging.page <= 1} onClick={() => void run(report.paging!.page - 1)}>Previous</Button>
              <span>Page {report.paging.page} of {report.paging.pages} · {report.paging.total.toLocaleString('en-CA')} lines · exports contain every line</span>
              <Button size="sm" variant="outline" disabled={busy || report.paging.page >= report.paging.pages} onClick={() => void run(report.paging!.page + 1)}>Next</Button>
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}
