'use client';
import { Check } from 'lucide-react';
import Link from 'next/link';
import { FEATURE_LABEL, priceLabel, usePublicConfig } from '@/lib/config';

const CORE = ['Invoices, estimates, sales receipts', 'E-mail with your logo and wording', 'Card payments (your Stripe account)', 'Recurring invoices, statements, reminders', 'Expenses, bills and supplier credits', 'Banking, deposits and reconciliation', 'GST/HST, QST, PST and reports'];

export default function Pricing() {
  const c = usePublicConfig();
  if (c && c.mode !== 'saas') return <main className="flex min-h-screen items-center justify-center p-6 text-sm text-muted-foreground">This installation is self-hosted: every feature is included and there are no plans. <Link href="/login" className="ml-1 text-primary hover:underline">Sign in</Link></main>;
  return (
    <div className="min-h-screen bg-background px-4 py-12">
      <div className="mx-auto max-w-6xl">
        <div className="text-center"><Link href="/welcome" className="text-sm text-muted-foreground hover:underline">← {c?.appName}</Link><h1 className="mt-2 text-3xl font-semibold tracking-tight">Plans</h1><p className="mt-2 text-muted-foreground">Every plan starts with a {c?.trialDays ?? 30}-day free trial. Prices in Canadian dollars, plus applicable taxes, billed by Stripe.</p></div>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {(c?.plans ?? []).map((p) => (
            <div key={p.id} className={`flex flex-col rounded-lg border bg-card p-6 ${p.id === 'essentials' ? 'border-primary ring-1 ring-primary' : ''}`}>
              <h2 className="text-lg font-semibold">{p.name}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{p.tagline}</p>
              <p className="mt-4 text-2xl font-semibold">{priceLabel(p.price)}</p>
              <p className="text-sm text-muted-foreground">{p.maxUsers} user{p.maxUsers === 1 ? '' : 's'} · {p.maxCompanies} compan{p.maxCompanies === 1 ? 'y' : 'ies'}</p>
              <ul className="mt-4 flex-1 space-y-2 text-sm">
                {[...CORE, ...p.features.map((f) => FEATURE_LABEL[f] ?? f)].map((f) => <li key={f} className="flex gap-2"><Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />{f}</li>)}
              </ul>
              {p.available && c?.signup ? <Link href={`/signup?plan=${p.id}`} className="mt-6 rounded-md bg-primary px-4 py-2 text-center font-medium text-primary-foreground hover:bg-primary/90">Start free trial</Link> : <span className="mt-6 text-center text-sm text-muted-foreground">Not available yet</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
