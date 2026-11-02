'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { SidePanel } from '@/components/sales/common';
import { api, errorMessage } from '@/lib/api';
import { today } from '@/lib/company';

export type RecurringKind = 'INVOICE' | 'BILL' | 'EXPENSE';

/** Turn a document into a schedule. `payload` is the document as the create endpoint takes it, without its dates. */
export function RecurringDialog({ companyId, kind, payload, defaultName, onClose }: { companyId: string; kind: RecurringKind; payload: Record<string, unknown>; defaultName: string; onClose: (saved: boolean) => void }) {
  const [f, setF] = useState({ name: defaultName, interval: 'MONTHLY', every: '1', startDate: today(), endDate: '', maxRuns: '', daysDue: '30', mode: kind === 'EXPENSE' ? 'POST' : 'DRAFT' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setErr(null); setBusy(true);
    try {
      await api(`/companies/${companyId}/recurring`, { method: 'POST', body: { name: f.name, kind, mode: f.mode, interval: f.interval, every: Number(f.every) || 1, startDate: f.startDate, ...(f.endDate ? { endDate: f.endDate } : {}), ...(f.maxRuns ? { maxRuns: Number(f.maxRuns) } : {}), daysDue: Number(f.daysDue) || 0, payload } });
      onClose(true);
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <SidePanel title="Make recurring" onClose={() => onClose(false)} footer={<><Button variant="outline" onClick={() => onClose(false)}>Cancel</Button><Button disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save schedule'}</Button></>}>
      <FormError message={err} />
      <Field label="Template name" htmlFor="rc-name"><Input id="rc-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Repeat" htmlFor="rc-int"><Select id="rc-int" value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })}><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option><option value="YEARLY">Yearly</option></Select></Field>
        <Field label="Every" htmlFor="rc-every"><Input id="rc-every" inputMode="numeric" value={f.every} onChange={(e) => setF({ ...f, every: e.target.value })} /></Field>
        <Field label="Start" htmlFor="rc-start"><Input id="rc-start" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
        <Field label="End (optional)" htmlFor="rc-end"><Input id="rc-end" type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
        <Field label="Stop after (times, optional)" htmlFor="rc-max"><Input id="rc-max" inputMode="numeric" value={f.maxRuns} onChange={(e) => setF({ ...f, maxRuns: e.target.value })} /></Field>
        {kind !== 'EXPENSE' && <Field label="Due after (days)" htmlFor="rc-due"><Input id="rc-due" inputMode="numeric" value={f.daysDue} onChange={(e) => setF({ ...f, daysDue: e.target.value })} /></Field>}
      </div>
      <Field label="Each time" htmlFor="rc-mode" hint={kind === 'EXPENSE' ? 'Recurring expenses are created as submitted; someone else still approves them.' : undefined}>
        <Select id="rc-mode" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })} disabled={kind === 'EXPENSE'}>
          <option value="DRAFT">Create a draft for me to review</option>
          {kind !== 'EXPENSE' && <option value="POST">Create and post it</option>}
          {kind === 'INVOICE' && <option value="SEND">Post it and e-mail it to the customer</option>}
          {kind === 'EXPENSE' && <option value="POST">Create it (submitted for approval)</option>}
        </Select>
      </Field>
      <p className="text-xs text-muted-foreground">The worker checks schedules every hour. Missed dates are caught up (up to 12 at a time).</p>
    </SidePanel>
  );
}
