'use client';
import { useState } from 'react';
import { Table, Td } from '@/components/accounting/bits';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, FormError, Select } from '@/components/ui/form';
import { ApiError, errorMessage } from '@/lib/api';
import { fmtMoney } from '@/lib/company';

interface Preview {
  filename: string; format: 'csv' | 'ofx'; alreadyImported: { createdAt: string; filename: string } | null; warnings: string[];
  csv?: { headers: string[]; sample: string[][]; suggested: { dateColumn?: number; descriptionColumns?: number[]; amount?: { mode: string; column?: number; debitColumn?: number; creditColumn?: number }; dateFormat?: string; confident: boolean } };
  summary?: { total: number; newCount: number; duplicateCount: number; errorCount: number; errors: { line: number; message: string }[]; preview: { date: string; description: string; amount: string }[] };
}

/** Raw-bytes upload (no multipart): file in the body, column mapping in a header. Nothing is saved until "Import". */
async function post(path: string, file: File, mapping?: object, acceptErrors = false) {
  const res = await fetch(`/api${path}?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST', credentials: 'same-origin', body: file,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'ca-web', ...(mapping ? { 'X-Import-Mapping': JSON.stringify(mapping) } : {}), ...(acceptErrors ? { 'X-Import-Accept-Errors': 'true' } : {}) },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, j.code ?? 'ERROR', j.message ?? 'Upload failed', j.issues);
  return j;
}

export function ImportPanel({ companyId, accountId, accountName, onDone, onClose }: { companyId: string; accountId: string; accountName: string; onDone: () => void; onClose: () => void }) {
  const base = `/companies/${companyId}/banking/accounts/${accountId}/import`;
  const [file, setFile] = useState<File | null>(null);
  const [pv, setPv] = useState<Preview | null>(null);
  const [m, setM] = useState({ date: 0, desc: 1, mode: 'split', amount: 2, debit: 2, credit: 3, invert: false, fmt: 'YMD', decimalComma: false });
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mapping = () => ({ hasHeader: true, dateColumn: m.date, dateFormat: m.fmt, descriptionColumns: [m.desc], decimalComma: m.decimalComma, amount: m.mode === 'split' ? { mode: 'split', debitColumn: m.debit, creditColumn: m.credit } : { mode: 'single', column: m.amount, invert: m.invert } });
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); } };

  const pick = (f: File) => run(async () => {
    setFile(f); setPv(null); setDone(null);
    const p: Preview = await post(`${base}/preview`, f);
    setPv(p);
    const s = p.csv?.suggested;
    if (s) setM((x) => ({ ...x, date: s.dateColumn ?? 0, desc: s.descriptionColumns?.[0] ?? 1, ...(s.amount?.mode === 'single' ? { mode: 'single', amount: s.amount.column ?? 2 } : s.amount?.mode === 'split' ? { mode: 'split', debit: s.amount.debitColumn ?? 2, credit: s.amount.creditColumn ?? 3 } : {}) }));
  });
  const refresh = () => file && run(async () => setPv(await post(`${base}/preview`, file, pv?.format === 'csv' ? mapping() : undefined)));
  const commit = (acceptErrors: boolean) => file && run(async () => {
    const r = await post(`${base}/commit`, file, pv?.format === 'csv' ? mapping() : undefined, acceptErrors);
    setDone(`Imported ${r.imported} transactions (${r.skippedDuplicates} duplicates skipped, ${r.failed} unreadable). ${r.matchSuggestions} match suggestion(s) created.`);
    onDone();
  });
  const headers = pv?.csv?.headers ?? [];
  const opts = headers.map((h, i) => <option key={i} value={i}>{i + 1}. {h}</option>);

  return (
    <Card><CardHeader><CardTitle>Import a statement into {accountName}</CardTitle></CardHeader><CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">CSV, OFX or QFX. PDF statements can’t be read reliably — download the CSV/OFX version from your bank. The original file is kept exactly as uploaded.</p>
      <input type="file" accept=".csv,.ofx,.qfx,.txt" aria-label="Statement file" onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])} className="text-sm" />
      <FormError message={err} />
      {done && <p role="status" className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">{done}</p>}
      {pv?.alreadyImported && <p className="text-sm text-warning">This exact file was already imported on {pv.alreadyImported.createdAt.slice(0, 10)}.</p>}
      {pv?.warnings.map((w) => <p key={w} className="text-sm text-warning">⚠ {w}</p>)}
      {pv?.csv && (
        <div className="space-y-3">
          <p className="text-sm font-medium">Tell us which columns are which{pv.csv.suggested.confident ? ' (we guessed — please check)' : ''}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Date column" htmlFor="m-date"><Select id="m-date" value={m.date} onChange={(e) => setM({ ...m, date: +e.target.value })}>{opts}</Select></Field>
            <Field label="Date format" htmlFor="m-fmt"><Select id="m-fmt" value={m.fmt} onChange={(e) => setM({ ...m, fmt: e.target.value })}><option value="YMD">2026-10-31</option><option value="MDY">10/31/2026 (month first)</option><option value="DMY">31/10/2026 (day first)</option><option value="YYYYMMDD">20261031</option></Select></Field>
            <Field label="Description column" htmlFor="m-desc"><Select id="m-desc" value={m.desc} onChange={(e) => setM({ ...m, desc: +e.target.value })}>{opts}</Select></Field>
            <Field label="Amounts are" htmlFor="m-mode"><Select id="m-mode" value={m.mode} onChange={(e) => setM({ ...m, mode: e.target.value })}><option value="split">in two columns (withdrawals / deposits)</option><option value="single">in one column (+ in, − out)</option></Select></Field>
            {m.mode === 'split' ? (<>
              <Field label="Withdrawals (money out)" htmlFor="m-deb"><Select id="m-deb" value={m.debit} onChange={(e) => setM({ ...m, debit: +e.target.value })}>{opts}</Select></Field>
              <Field label="Deposits (money in)" htmlFor="m-cred"><Select id="m-cred" value={m.credit} onChange={(e) => setM({ ...m, credit: +e.target.value })}>{opts}</Select></Field>
            </>) : (<>
              <Field label="Amount column" htmlFor="m-amt"><Select id="m-amt" value={m.amount} onChange={(e) => setM({ ...m, amount: +e.target.value })}>{opts}</Select></Field>
              <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={m.invert} onChange={(e) => setM({ ...m, invert: e.target.checked })} /> Purchases are positive (credit cards)</label>
            </>)}
            <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={m.decimalComma} onChange={(e) => setM({ ...m, decimalComma: e.target.checked })} /> Amounts use a decimal comma (12,50)</label>
          </div>
          <Button variant="outline" onClick={() => void refresh()} disabled={busy}>Preview with this mapping</Button>
        </div>
      )}
      {pv?.summary && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-sm"><Badge tone="success">{pv.summary.newCount} new</Badge><Badge>{pv.summary.duplicateCount} already imported</Badge>{pv.summary.errorCount > 0 && <Badge tone="danger">{pv.summary.errorCount} unreadable rows</Badge>}</div>
          {pv.summary.errors.slice(0, 5).map((e) => <p key={e.line} className="text-xs text-destructive">Row {e.line}: {e.message}</p>)}
          <Table head={['Date', 'Description', 'Amount']} right={[2]}>{pv.summary.preview.slice(0, 10).map((r, i) => <tr key={i}><Td>{r.date}</Td><Td>{r.description}</Td><Td right>{fmtMoney(r.amount)}</Td></tr>)}</Table>
          <div className="flex gap-2">
            <Button disabled={busy || pv.summary.newCount === 0 || Boolean(pv.alreadyImported)} onClick={() => void commit(false)}>Import {pv.summary.newCount} transactions</Button>
            {pv.summary.errorCount > 0 && <Button variant="outline" disabled={busy} onClick={() => void commit(true)}>Import anyway, skipping unreadable rows</Button>}
          </div>
        </div>
      )}
      <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
    </CardContent></Card>
  );
}
