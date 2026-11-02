'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { CANADIAN_PROVINCES } from '@ca/shared';
import { Shell } from '@/components/shell/shell';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { FEATURE_LABEL, priceLabel, type PlanInfo } from '@/lib/config';
import { SessionProvider, useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface Billing { organization: { id: string; name: string }; plan: PlanInfo | null; status: string; trialEndsAt: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; subscribed: boolean; writable: boolean; usage: { companies: number; users: number }; plans: PlanInfo[] }
const STATUS: Record<string, string> = { trialing: 'Trial', active: 'Active', past_due: 'Payment failed – retrying', canceled: 'Cancelled', unpaid: 'Unpaid', incomplete: 'Incomplete', incomplete_expired: 'Expired', paused: 'Paused' };

function BillingInner() {
  const q = useSearchParams();
  const { refresh } = useSession();
  const { data, error, reload } = useApi<Billing>('/billing');
  const { data: cfg } = useApi<{ plans?: PlanInfo[] }>('/config');
  const [err, setErr] = useState<string | null>(null);
  const [co, setCo] = useState({ legalName: '', province: 'ON' });
  const go = async (path: string, body?: object) => { setErr(null); try { const r = await api<{ url: string }>(path, { method: 'POST', body: body ?? {} }); window.location.assign(r.url); } catch (x) { setErr(errorMessage(x)); } };
  const price = (id: string) => cfg?.plans?.find((p) => p.id === id)?.price ?? null;
  if (error) return <Card><CardContent className="p-6 text-sm">{errorMessage(error)}</CardContent></Card>;
  if (!data) return null;
  const days = data.trialEndsAt ? Math.ceil((Date.parse(data.trialEndsAt) - Date.now()) / 86_400_000) : null;
  return (
    <div className="max-w-5xl space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Billing · {data.organization.name}</h1>
      {q.get('checkout') === 'success' && <p role="status" className="rounded-md border border-primary/30 bg-accent px-3 py-2 text-sm">Thank you. Stripe confirms the subscription in a moment; refresh if the status has not changed yet.</p>}
      <FormError message={err} />
      {!data.writable && <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">Your books are read-only until the subscription is active. Everything stays viewable and exportable.</p>}
      <Card><CardHeader><CardTitle>Subscription</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
        <p><strong>{data.plan?.name ?? '—'}</strong> plan · <Badge tone={data.writable ? 'success' : 'danger'}>{STATUS[data.status] ?? data.status}</Badge>{!data.subscribed && days !== null && <span className="ml-2 text-muted-foreground">{days > 0 ? `${days} day${days === 1 ? '' : 's'} left in your trial` : 'Trial ended'}</span>}{data.cancelAtPeriodEnd && <span className="ml-2 text-orange-600">Cancels at the end of the period</span>}</p>
        {data.currentPeriodEnd && <p className="text-muted-foreground">Current period ends {data.currentPeriodEnd.slice(0, 10)}.</p>}
        <p className="text-muted-foreground">Using {data.usage.users} of {data.plan?.maxUsers} users and {data.usage.companies} of {data.plan?.maxCompanies} compan{data.plan?.maxCompanies === 1 ? 'y' : 'ies'}.</p>
        {data.subscribed && <Button variant="outline" onClick={() => void go('/billing/portal')}>Manage subscription, card and invoices</Button>}
      </CardContent></Card>
      {(!data.subscribed || ['canceled', 'incomplete_expired'].includes(data.status)) && (
        <div className="grid gap-4 md:grid-cols-3">
          {data.plans.map((p) => (
            <Card key={p.id} className={p.id === data.plan?.id ? 'border-primary' : ''}><CardHeader><CardTitle>{p.name}</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
              <p className="text-lg font-semibold">{priceLabel(price(p.id))}</p>
              <p className="text-muted-foreground">{p.maxUsers} users · {p.maxCompanies} compan{p.maxCompanies === 1 ? 'y' : 'ies'}{p.features.length ? ` · ${p.features.map((f) => FEATURE_LABEL[f] ?? f).join(', ')}` : ''}</p>
              <Button disabled={!p.available} onClick={() => void go('/billing/checkout', { plan: p.id })}>Subscribe{days && days > 0 ? ' (trial days carry over)' : ''}</Button>
            </CardContent></Card>
          ))}
        </div>
      )}
      <Card><CardHeader><CardTitle>Add a company</CardTitle></CardHeader><CardContent>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); setErr(null); void api('/billing/companies', { method: 'POST', body: co }).then(async () => { setCo({ legalName: '', province: 'ON' }); await reload(); await refresh(); }).catch((x) => setErr(errorMessage(x))); }}>
          <Field label="Legal name" htmlFor="bl-co"><Input id="bl-co" required value={co.legalName} onChange={(e) => setCo({ ...co, legalName: e.target.value })} /></Field>
          <Field label="Province" htmlFor="bl-pr"><Select id="bl-pr" value={co.province} onChange={(e) => setCo({ ...co, province: e.target.value })}>{CANADIAN_PROVINCES.map((p) => <option key={p}>{p}</option>)}</Select></Field>
          <Button type="submit">Add company</Button>
        </form>
      </CardContent></Card>
      <p className="text-xs text-muted-foreground">Subscriptions are billed by Stripe. <Link href="/pricing" className="hover:underline">Compare plans</Link></p>
    </div>
  );
}
export default function BillingPage() {
  return <SessionProvider><Shell companyId={null} title="Billing"><Suspense><BillingInner /></Suspense></Shell></SessionProvider>;
}
