'use client';
import { BarChart3, Boxes, Briefcase, CreditCard, FileText, Landmark, Mail, Receipt, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { usePublicConfig } from '@/lib/config';

const FEATURES = [
  [FileText, 'Invoices, estimates and sales receipts', 'Branded PDFs with your logo, e-mailed to customers, with automatic reminders and recurring invoices.'],
  [CreditCard, 'Get paid by card', 'A Pay now button on every invoice through your own Stripe account; payments are recorded for you.'],
  [Receipt, 'Bills, purchase orders and expenses', 'Pay several bills at once, apply supplier credits, re-bill costs to customers.'],
  [Landmark, 'Banking and deposits', 'Bank feeds and statement imports, matching, reconciliation, and bank deposits from Undeposited Funds.'],
  [Boxes, 'Inventory', 'Quantity on hand and cost of goods sold at weighted-average cost, with valuation reports.'],
  [Briefcase, 'Projects and time', 'Timesheets, billable time and project profitability.'],
  [BarChart3, 'Canadian tax and reports', 'GST/HST, QST and PST by rate, Quick Method, financial statements, budgets, P&L by class and location.'],
  [ShieldCheck, 'Built for accuracy', 'Exact decimal arithmetic, posted entries that cannot be edited, an audit trail of every change.'],
] as const;

/** Public home page of the SaaS edition. */
export default function Welcome() {
  const c = usePublicConfig();
  const name = c?.appName ?? 'Canadian Accounting';
  return (
    <div className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">CA</span>
        <span className="font-semibold">{name}</span>
        <nav className="ml-auto flex items-center gap-4 text-sm"><Link href="/pricing" className="hover:underline">Pricing</Link><Link href="/login" className="hover:underline">Sign in</Link>{c?.mode === 'saas' && <Link href="/signup" className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90">Start free trial</Link>}</nav>
      </header>
      <section className="mx-auto max-w-6xl px-4 py-16 text-center sm:py-24">
        <h1 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">Accounting made for Canadian small businesses</h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">Invoicing, bills, banking, inventory and GST/HST/QST/PST in one place, in the browser.</p>
        {c?.mode === 'saas' && <div className="mt-8 flex justify-center gap-3"><Link href="/signup" className="rounded-md bg-primary px-6 py-3 font-medium text-primary-foreground hover:bg-primary/90">Try it free for {c.trialDays} days</Link><Link href="/pricing" className="rounded-md border px-6 py-3 font-medium hover:bg-accent">See plans</Link></div>}
        {c?.mode === 'saas' && <p className="mt-3 text-sm text-muted-foreground">No card needed to start.</p>}
      </section>
      <section className="mx-auto grid max-w-6xl gap-6 px-4 pb-24 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map(([Icon, title, text]) => <div key={title} className="rounded-lg border bg-card p-5"><Icon className="h-6 w-6 text-primary" aria-hidden /><h2 className="mt-3 font-semibold">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{text}</p></div>)}
      </section>
      <footer className="border-t py-6 text-center text-xs text-muted-foreground"><Mail className="mr-1 inline h-3.5 w-3.5" aria-hidden />Payroll is not included. Tax rates are seeded from CRA and Revenu Québec sources; have your accountant confirm your setup.</footer>
    </div>
  );
}
