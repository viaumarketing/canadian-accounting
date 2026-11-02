'use client';
import { useState } from 'react';
import { SalesHeader } from '@/components/sales/common';
import { Badge } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Template { id: string; name: string; kind: string; mode: string; interval: string; every: number; startDate: string; endDate: string | null; nextDate: string | null; maxRuns: number | null; runCount: number; daysDue: number; payload: Record<string, unknown>; isActive: boolean; lastRunAt: string | null; lastError: string | null }
const EVERY: Record<string, [string, string]> = { DAILY: ['day', 'days'], WEEKLY: ['week', 'weeks'], MONTHLY: ['month', 'months'], YEARLY: ['year', 'years'] };
const MODE: Record<string, string> = { DRAFT: 'Create draft', POST: 'Create and post', SEND: 'Post and e-mail' };

/** Recurring transactions (invoices, bills, expenses). Schedules are made from a document with "Make recurring". */
export default function RecurringPage() {
  const { companyId, can } = useCompany();
  const base = `/companies/${companyId}`;
  const { data, reload, error } = useApi<Template[]>(`${base}/recurring`);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); setNote(null); try { await fn(); await reload(); } catch (x) { setErr(errorMessage(x)); } };
  const save = (t: Template, isActive: boolean) => api(`${base}/recurring/${t.id}`, { method: 'PUT', body: { name: t.name, kind: t.kind, mode: t.mode, interval: t.interval, every: t.every, startDate: t.startDate.slice(0, 10), ...(t.endDate ? { endDate: t.endDate.slice(0, 10) } : {}), ...(t.maxRuns ? { maxRuns: t.maxRuns } : {}), daysDue: t.daysDue, payload: t.payload, isActive } });
  return (
    <div className="space-y-5">
      <SalesHeader title="Recurring transactions" />
      <p className="text-sm text-muted-foreground">To add one, open an invoice and choose <strong>Make recurring</strong>. Schedules run every hour on the server; a schedule pauses itself (with the reason) if it can no longer run.</p>
      <FormError message={err ?? (error ? errorMessage(error) : null)} />
      {note && <p role="status" className="rounded-md border border-primary/30 bg-accent px-3 py-2 text-sm">{note}</p>}
      <div className="overflow-x-auto rounded-md border bg-card shadow-sm">
        <table className="w-full min-w-[56rem] text-sm">
          <thead className="border-b bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr>{['Template', 'Type', 'Interval', 'Each time', 'Next date', 'Runs', 'Status', ''].map((h) => <th key={h} className="px-3 py-2.5">{h}</th>)}</tr></thead>
          <tbody>
            {data && data.length === 0 && <tr><td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">No recurring transactions yet.</td></tr>}
            {(data ?? []).map((t) => (
              <tr key={t.id} className="border-b align-top last:border-0">
                <td className="px-3 py-2.5 font-medium">{t.name}{t.lastError && <span className="mt-1 block text-xs font-normal text-destructive">{t.lastError}</span>}</td>
                <td className="px-3 py-2.5">{t.kind.charAt(0) + t.kind.slice(1).toLowerCase()}</td>
                <td className="px-3 py-2.5">Every {t.every === 1 ? EVERY[t.interval][0] : `${t.every} ${EVERY[t.interval][1]}`}</td>
                <td className="px-3 py-2.5">{MODE[t.mode]}</td>
                <td className="px-3 py-2.5">{t.nextDate?.slice(0, 10) ?? '—'}</td>
                <td className="px-3 py-2.5 tabular-nums">{t.runCount}{t.maxRuns ? ` / ${t.maxRuns}` : ''}</td>
                <td className="px-3 py-2.5"><Badge tone={t.isActive ? 'success' : 'neutral'}>{t.isActive ? 'Active' : 'Paused'}</Badge></td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right">
                  {can('sales:create') && <div className="inline-flex gap-1">
                    {t.isActive && <Button size="sm" variant="ghost" onClick={() => void run(async () => { const r = await api<{ created: number; nextDate: string | null; lastError: string | null }>(`${base}/recurring/${t.id}/run`, { method: 'POST' }); setNote(r.created ? `Created 1 ${t.kind.toLowerCase()}; next on ${r.nextDate?.slice(0, 10) ?? '—'}.` : r.lastError ?? 'Nothing was created.'); })}>Create now</Button>}
                    <Button size="sm" variant="ghost" onClick={() => void run(() => save(t, !t.isActive))}>{t.isActive ? 'Pause' : 'Resume'}</Button>
                    <Button size="sm" variant="ghost" onClick={() => window.confirm(`Delete the schedule “${t.name}”? Documents it already created stay.`) && void run(() => api(`${base}/recurring/${t.id}`, { method: 'DELETE' }))}>Delete</Button>
                  </div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
