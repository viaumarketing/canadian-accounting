'use client';
import { useEffect, useRef, useState } from 'react';
import type { Account } from '@/components/sales/common';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { useApi } from '@/lib/use-api';

const areaCls = 'w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const Ok = ({ msg }: { msg: string | null }) => (msg ? <p role="status" className="rounded-md border border-primary/30 bg-accent px-3 py-2 text-sm">{msg}</p> : null);

type Kind = 'invoice' | 'sales_receipt' | 'estimate' | 'statement' | 'reminder' | 'purchase_order';
interface Template { accent?: string; layout?: 'modern' | 'classic' | 'compact'; showLogo?: boolean; showServiceDate?: boolean; showTaxColumn?: boolean; footer?: string; paymentInstructions?: string; emails?: Partial<Record<Kind, { subject: string; body: string }>> }
interface Branding { template: Template; emailFromName: string | null; emailReplyTo: string | null; hasLogo: boolean; companyName: string }
const KIND_LABEL: Record<Kind, string> = { invoice: 'Invoices', sales_receipt: 'Sales receipts', estimate: 'Estimates', statement: 'Statements', reminder: 'Overdue reminders', purchase_order: 'Purchase orders' };

/** Logo, document look (accent, layout, footer, payment instructions) and e-mail wording. */
export function BrandingTab({ companyId, canEdit }: { companyId: string; canEdit: boolean }) {
  const base = `/companies/${companyId}`;
  const { data, reload } = useApi<Branding>(`${base}/branding`);
  const [t, setT] = useState<Template>({});
  const [from, setFrom] = useState(''); const [reply, setReply] = useState('');
  const [kind, setKind] = useState<Kind>('invoice');
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null);
  const [v, setV] = useState(0); // cache-buster for the logo and preview
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { if (data) { setT(data.template); setFrom(data.emailFromName ?? ''); setReply(data.emailReplyTo ?? ''); } }, [data]);
  async function save() {
    setErr(null); setMsg(null);
    try { await api(`${base}/branding`, { method: 'PUT', body: { template: t, emailFromName: from.trim() || null, emailReplyTo: reply.trim() || null } }); await reload(); setV((x) => x + 1); setMsg('Saved. New PDFs and e-mails use these settings.'); } catch (x) { setErr(errorMessage(x)); }
  }
  async function upload(f: File) {
    setErr(null); setMsg(null);
    if (f.size > 1024 * 1024) { setErr('The logo must be 1 MB or smaller'); return; }
    try {
      const res = await fetch(`/api${base}/branding/logo`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'ca-web' }, body: f });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { message?: string }).message ?? 'Upload failed');
      await reload(); setV((x) => x + 1); setMsg('Logo uploaded.');
    } catch (x) { setErr(x instanceof Error ? x.message : errorMessage(x)); }
  }
  const email = t.emails?.[kind] ?? { subject: '', body: '' };
  const setEmail = (patch: Partial<{ subject: string; body: string }>) => setT({ ...t, emails: { ...t.emails, [kind]: { ...email, ...patch } } });
  if (!data) return null;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <FormError message={err} /><Ok msg={msg} />
        <Card><CardHeader><CardTitle>Logo</CardTitle></CardHeader><CardContent className="space-y-3">
          {data.hasLogo ? <img src={`/api${base}/branding/logo?v=${v}`} alt="Company logo" className="max-h-20 max-w-[240px] rounded border bg-white p-2" /> : <p className="text-sm text-muted-foreground">No logo yet. PNG or JPEG, up to 1 MB; it is printed at the top left of every document.</p>}
          {canEdit && <div className="flex gap-2">
            <input ref={file} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
            <Button variant="outline" onClick={() => file.current?.click()}>{data.hasLogo ? 'Replace logo' : 'Upload logo'}</Button>
            {data.hasLogo && <Button variant="ghost" onClick={() => void api(`${base}/branding/logo`, { method: 'DELETE' }).then(reload)}>Remove</Button>}
          </div>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Document template</CardTitle></CardHeader><CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Layout" htmlFor="br-layout"><Select id="br-layout" disabled={!canEdit} value={t.layout ?? 'modern'} onChange={(e) => setT({ ...t, layout: e.target.value as Template['layout'] })}><option value="modern">Modern</option><option value="classic">Classic (serif, ruled)</option><option value="compact">Compact</option></Select></Field>
            <Field label="Accent colour" htmlFor="br-accent"><div className="flex gap-2"><input id="br-accent" type="color" disabled={!canEdit} value={t.accent ?? '#2f8a2b'} onChange={(e) => setT({ ...t, accent: e.target.value })} className="h-9 w-12 rounded border" /><Input aria-label="Accent hex" disabled={!canEdit} value={t.accent ?? '#2f8a2b'} onChange={(e) => setT({ ...t, accent: e.target.value })} /></div></Field>
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            {([['showLogo', 'Show logo'], ['showServiceDate', 'Service date column'], ['showTaxColumn', 'Tax code column']] as const).map(([k, l]) => <label key={k} className="flex items-center gap-2"><input type="checkbox" disabled={!canEdit} checked={t[k] !== false} onChange={(e) => setT({ ...t, [k]: e.target.checked })} /> {l}</label>)}
          </div>
          <Field label="How to pay (printed on invoices)" htmlFor="br-pay"><textarea id="br-pay" rows={3} disabled={!canEdit} className={areaCls} placeholder="Interac e-Transfer to billing@example.com, or cheque payable to…" value={t.paymentInstructions ?? ''} onChange={(e) => setT({ ...t, paymentInstructions: e.target.value })} /></Field>
          <Field label="Footer (every page)" htmlFor="br-foot"><Input id="br-foot" disabled={!canEdit} value={t.footer ?? ''} onChange={(e) => setT({ ...t, footer: e.target.value })} placeholder="Thank you for your business" /></Field>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>E-mail</CardTitle></CardHeader><CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sender name" htmlFor="br-from" hint={`Default: ${data.companyName}`}><Input id="br-from" disabled={!canEdit} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="Replies go to" htmlFor="br-reply" hint="Default: the company e-mail"><Input id="br-reply" type="email" disabled={!canEdit} value={reply} onChange={(e) => setReply(e.target.value)} /></Field>
          </div>
          <Field label="Wording for" htmlFor="br-kind"><Select id="br-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="Subject" htmlFor="br-subj" hint="Blank = the default wording"><Input id="br-subj" disabled={!canEdit} value={email.subject} onChange={(e) => setEmail({ subject: e.target.value })} /></Field>
          <Field label="Message" htmlFor="br-body" hint="Placeholders: {{customer}} {{company}} {{number}} {{total}} {{balance}} {{dueDate}} {{link}}"><textarea id="br-body" rows={6} disabled={!canEdit} className={areaCls} value={email.body} onChange={(e) => setEmail({ body: e.target.value })} /></Field>
        </CardContent></Card>
        {canEdit && <Button onClick={() => void save()}>Save branding</Button>}
      </div>
      <Card className="lg:sticky lg:top-4 lg:self-start"><CardHeader><CardTitle>Preview (sample invoice, saved settings)</CardTitle></CardHeader><CardContent><iframe key={v} title="Invoice preview" src={`/api${base}/branding/preview.pdf?v=${v}`} className="h-[38rem] w-full rounded border bg-white" /></CardContent></Card>
    </div>
  );
}

interface Stripe { connected: boolean; mode?: string; accountName?: string; webhookUrl?: string; webhookConfigured?: boolean; events?: string[]; clearingAccount?: { code: string; name: string } }

/** The company's own Stripe account for "Pay now" on invoices. */
export function PaymentsTab({ companyId }: { companyId: string }) {
  const base = `/companies/${companyId}`;
  const { data, reload } = useApi<Stripe>(`${base}/stripe`);
  const [key, setKey] = useState(''); const [secret, setSecret] = useState('');
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null);
  async function connect() {
    setErr(null); setMsg(null);
    try { await api(`${base}/stripe`, { method: 'PUT', body: { secretKey: key.trim(), ...(secret.trim() ? { webhookSecret: secret.trim() } : {}) } }); setKey(''); setSecret(''); await reload(); setMsg('Stripe connected. Keys are stored encrypted.'); } catch (x) { setErr(errorMessage(x)); }
  }
  if (!data) return null;
  return (
    <div className="max-w-3xl space-y-4">
      <FormError message={err} /><Ok msg={msg} />
      <Card><CardHeader><CardTitle>Card payments with Stripe</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
        {data.connected ? <p>Connected to <strong>{data.accountName}</strong> <Badge tone={data.mode === 'live' ? 'success' : 'warning'}>{data.mode} mode</Badge>. Card payments are recorded to <strong>{data.clearingAccount?.code} · {data.clearingAccount?.name}</strong>; when Stripe pays out, record a bank deposit from it with Stripe’s fee as a negative line.</p>
          : <p>Customers get a <strong>Pay now</strong> button on the invoice link you e-mail them. Payments go through your own Stripe account (Stripe’s fees apply) and are recorded against the invoice automatically.</p>}
        {data.connected && (
          <div className="space-y-2 rounded-md border bg-muted/40 p-3">
            <p className="font-medium">Webhook {data.webhookConfigured ? <Badge tone="success">signing secret saved</Badge> : <Badge tone="danger">needed for Pay now</Badge>}</p>
            <p>In Stripe → Developers → Webhooks, add an endpoint with this URL and these events, then paste its signing secret below:</p>
            <code className="block break-all rounded bg-card px-2 py-1 text-xs">{data.webhookUrl}</code>
            <p className="text-xs text-muted-foreground">Events: {data.events?.join(', ')}. The URL must be reachable from the internet over HTTPS.</p>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Secret key" htmlFor="st-key" hint="sk_test_… to try it, sk_live_… for real payments"><Input id="st-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} /></Field>
          <Field label="Webhook signing secret" htmlFor="st-wh" hint="whsec_…"><Input id="st-wh" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></Field>
        </div>
        <div className="flex gap-2"><Button disabled={!key.trim()} onClick={() => void connect()}>{data.connected ? 'Update keys' : 'Connect Stripe'}</Button>{data.connected && <Button variant="ghost" onClick={() => window.confirm('Disconnect Stripe? Pay now links stop working; recorded payments stay.') && void api(`${base}/stripe`, { method: 'DELETE' }).then(reload)}>Disconnect</Button>}</div>
      </CardContent></Card>
    </div>
  );
}

interface Collections { reminders: { enabled: boolean; stages: number[]; subject?: string; body?: string }; lateFees: { enabled: boolean; type: 'FLAT' | 'PERCENT'; amount: string; graceDays: number; accountId: string; taxCodeId: string } | null; mailConfigured: boolean }

/** Automatic overdue reminders and late fees. */
export function CollectionsTab({ companyId, canEdit }: { companyId: string; canEdit: boolean }) {
  const base = `/companies/${companyId}`;
  const { data, reload } = useApi<Collections>(`${base}/collections/settings`);
  const { data: accounts } = useApi<Account[]>(`${base}/accounts`);
  const { data: codes } = useApi<{ id: string; code: string; name: string }[]>(`${base}/tax-codes`);
  const income = (accounts ?? []).filter((a) => a.type === 'REVENUE' && !a.role);
  const [r, setR] = useState({ enabled: false, stages: '1, 7, 30' });
  const [l, setL] = useState({ enabled: false, type: 'FLAT' as 'FLAT' | 'PERCENT', amount: '', graceDays: '30', accountId: '', taxCodeId: '' });
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!data) return;
    setR({ enabled: data.reminders.enabled, stages: data.reminders.stages.join(', ') });
    if (data.lateFees) setL({ ...data.lateFees, graceDays: String(data.lateFees.graceDays) });
  }, [data]);
  async function save() {
    setErr(null); setMsg(null);
    const stages = r.stages.split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
    try {
      await api(`${base}/collections/settings`, { method: 'PUT', body: { reminders: { enabled: r.enabled, stages }, lateFees: l.enabled || data?.lateFees ? { enabled: l.enabled, type: l.type, amount: l.amount || '0', graceDays: Number(l.graceDays) || 0, accountId: l.accountId || income.find((a) => a.code === '4900')?.id || income[0]?.id, taxCodeId: l.taxCodeId || codes?.find((c) => c.code === 'EXEMPT')?.id || codes?.[0]?.id } : null } });
      await reload(); setMsg('Saved. The server checks every hour.');
    } catch (x) { setErr(errorMessage(x)); }
  }
  if (!data) return null;
  return (
    <div className="max-w-3xl space-y-4">
      <FormError message={err} /><Ok msg={msg} />
      <Card><CardHeader><CardTitle>Overdue reminders</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
        {!data.mailConfigured && <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2">E-mail is not set up on this server, so reminders cannot be sent yet.</p>}
        <label className="flex items-center gap-2"><input type="checkbox" disabled={!canEdit} checked={r.enabled} onChange={(e) => setR({ ...r, enabled: e.target.checked })} /> E-mail customers when an invoice is overdue</label>
        <Field label="Days after the due date" htmlFor="co-stages" hint="Up to five, e.g. 1, 7, 30. Each is sent once per invoice; the wording is under Branding → Overdue reminders."><Input id="co-stages" disabled={!canEdit} value={r.stages} onChange={(e) => setR({ ...r, stages: e.target.value })} /></Field>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Late fees</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" disabled={!canEdit} checked={l.enabled} onChange={(e) => setL({ ...l, enabled: e.target.checked })} /> Charge a late fee once per overdue invoice (a separate invoice, posted automatically)</label>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Fee" htmlFor="co-type"><Select id="co-type" disabled={!canEdit} value={l.type} onChange={(e) => setL({ ...l, type: e.target.value as 'FLAT' | 'PERCENT' })}><option value="FLAT">Flat amount ($)</option><option value="PERCENT">Percent of balance (%)</option></Select></Field>
          <Field label={l.type === 'FLAT' ? 'Amount' : 'Percent'} htmlFor="co-amt"><Input id="co-amt" disabled={!canEdit} inputMode="decimal" value={l.amount} onChange={(e) => setL({ ...l, amount: e.target.value })} /></Field>
          <Field label="Days overdue before charging" htmlFor="co-grace"><Input id="co-grace" disabled={!canEdit} inputMode="numeric" value={l.graceDays} onChange={(e) => setL({ ...l, graceDays: e.target.value })} /></Field>
          <Field label="Income account" htmlFor="co-acct"><Select id="co-acct" disabled={!canEdit} value={l.accountId || income.find((a) => a.code === '4900')?.id || ''} onChange={(e) => setL({ ...l, accountId: e.target.value })}>{income.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
          <Field label="Tax code" htmlFor="co-tax" hint="Check with your accountant whether GST/HST applies to your late charges"><Select id="co-tax" disabled={!canEdit} value={l.taxCodeId || codes?.find((c) => c.code === 'EXEMPT')?.id || ''} onChange={(e) => setL({ ...l, taxCodeId: e.target.value })}>{(codes ?? []).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</Select></Field>
        </div>
      </CardContent></Card>
      {canEdit && <Button onClick={() => void save()}>Save</Button>}
    </div>
  );
}

interface Named { id: string; name: string; isActive: boolean }

/** Classes (per line) and locations (per transaction) for profit and loss by class or location. */
export function TrackingTab({ companyId, canEdit }: { companyId: string; canEdit: boolean }) {
  return (
    <div className="grid max-w-4xl gap-4 sm:grid-cols-2">
      <NameList companyId={companyId} path="classes" title="Classes" hint="A department or product line, chosen on each line." canEdit={canEdit} />
      <NameList companyId={companyId} path="locations" title="Locations" hint="A store, region or office, chosen on each transaction." canEdit={canEdit} />
    </div>
  );
}
function NameList({ companyId, path, title, hint, canEdit }: { companyId: string; path: string; title: string; hint: string; canEdit: boolean }) {
  const base = `/companies/${companyId}/${path}`;
  const { data, reload, error } = useApi<Named[]>(base);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => { setErr(null); return fn().then(reload).catch((x) => setErr(errorMessage(x))); };
  return (
    <Card><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
      <p className="text-muted-foreground">{hint}</p>
      <FormError message={err ?? (error ? errorMessage(error) : null)} />
      <ul className="divide-y rounded-md border">{(data ?? []).map((n) => <li key={n.id} className="flex items-center gap-2 px-3 py-2"><span className={n.isActive ? '' : 'text-muted-foreground line-through'}>{n.name}</span>{canEdit && <button className="ml-auto text-xs text-primary hover:underline" onClick={() => void run(() => api(`${base}/${n.id}`, { method: 'PUT', body: { name: n.name, isActive: !n.isActive } }))}>{n.isActive ? 'Make inactive' : 'Make active'}</button>}</li>)}{data?.length === 0 && <li className="px-3 py-2 text-muted-foreground">None yet.</li>}</ul>
      {canEdit && <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run(() => api(base, { method: 'POST', body: { name: name.trim() } })).then(() => setName('')); }}><Input aria-label={`New ${title.toLowerCase()}`} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} /><Button type="submit">Add</Button></form>}
    </CardContent></Card>
  );
}
