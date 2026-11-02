'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { CANADIAN_PROVINCES } from '@ca/shared';
import { AuthCard } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { usePublicConfig } from '@/lib/config';

function Signup() {
  const c = usePublicConfig();
  const q = useSearchParams();
  const [f, setF] = useState({ name: '', email: '', password: '', organizationName: '', companyName: '', province: 'ON', plan: q.get('plan') ?? 'essentials' });
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(null); setBusy(true);
    try { await api('/signup', { method: 'POST', body: { ...f, organizationName: f.organizationName || f.companyName } }); setSent(f.email); } catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  }
  if (c && c.mode !== 'saas') return <AuthCard title="Sign-up is not available">This installation is self-hosted; ask your administrator for an account. <Link href="/login" className="text-primary hover:underline">Sign in</Link></AuthCard>;
  if (sent) return <AuthCard title="Check your e-mail" subtitle={`We sent a confirmation link to ${sent}. Open it to start your trial. It expires in 24 hours.`}><p className="text-sm text-muted-foreground">Nothing arrived? Check your spam folder, or <button className="text-primary hover:underline" onClick={() => void api('/signup/resend', { method: 'POST', body: { email: sent } })}>send it again</button>.</p></AuthCard>;
  return (
    <AuthCard title="Start your free trial" subtitle={`${c?.trialDays ?? 30} days, no card needed. You can subscribe any time from Billing.`}>
      <form onSubmit={submit} className="space-y-4">
        <FormError message={err} />
        <Field label="Your name" htmlFor="su-name"><Input id="su-name" required autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="E-mail" htmlFor="su-email"><Input id="su-email" type="email" required autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Password" htmlFor="su-pw" hint="At least 12 characters"><Input id="su-pw" type="password" required minLength={12} autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <Field label="Business legal name" htmlFor="su-co"><Input id="su-co" required value={f.companyName} onChange={(e) => setF({ ...f, companyName: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Province or territory" htmlFor="su-prov"><Select id="su-prov" value={f.province} onChange={(e) => setF({ ...f, province: e.target.value })}>{CANADIAN_PROVINCES.map((p) => <option key={p}>{p}</option>)}</Select></Field>
          <Field label="Plan" htmlFor="su-plan"><Select id="su-plan" value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })}>{(c?.plans ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        </div>
        <Button type="submit" className="w-full" disabled={busy || c?.signup === false}>{busy ? 'Creating…' : 'Create account'}</Button>
        {c?.signup === false && <p className="text-xs text-destructive">Sign-up is temporarily unavailable (this server cannot send e-mail yet).</p>}
        <p className="text-center text-sm text-muted-foreground">Already have an account? <Link href="/login" className="text-primary hover:underline">Sign in</Link></p>
      </form>
    </AuthCard>
  );
}
export default function SignupPage() {
  return <Suspense><Signup /></Suspense>;
}
