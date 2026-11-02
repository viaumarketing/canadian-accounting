'use client';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { FormError } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney } from '@/lib/company';

interface Pub { company: string; customer: string; number: string; issueDate: string; dueDate: string; currency: string; total: string; amountPaid: string; balance: string; status: 'open' | 'paid' | 'void'; canPayOnline: boolean }

/** What a customer sees from the link in their invoice e-mail: the invoice, its PDF, and Pay now when the business takes cards. */
function PublicInvoice() {
  const { token } = useParams<{ token: string }>();
  const q = useSearchParams();
  const [inv, setInv] = useState<Pub | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<Pub>(`/public/invoices/${token}`).then(setInv).catch((e) => setErr(errorMessage(e))); }, [token]);
  async function pay() {
    setBusy(true); setErr(null);
    try { const r = await api<{ url: string }>(`/public/invoices/${token}/checkout`, { method: 'POST' }); window.location.assign(r.url); } catch (e) { setErr(errorMessage(e)); setBusy(false); }
  }
  return (
    <main className="flex min-h-screen items-start justify-center bg-background p-4 sm:items-center">
      <Card className="w-full max-w-lg">
        {!inv ? <CardContent className="p-6">{err ? <FormError message={err} /> : <p className="text-sm text-muted-foreground">Loading…</p>}</CardContent> : <>
          <CardHeader className="p-6 pb-2"><p className="text-sm text-muted-foreground">{inv.company}</p><h1 className="text-xl font-semibold">Invoice {inv.number}</h1><p className="text-sm text-muted-foreground">For {inv.customer} · issued {inv.issueDate} · due {inv.dueDate}</p></CardHeader>
          <CardContent className="space-y-4 p-6 pt-2">
            {q.get('paid') === '1' && inv.status !== 'paid' && <p role="status" className="rounded-md border border-primary/30 bg-accent px-3 py-2 text-sm">Thank you. Your payment is being confirmed; this page updates once the business has recorded it.</p>}
            <FormError message={err} />
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt>Total</dt><dd className="tabular-nums">{fmtMoney(inv.total)}</dd></div>
              <div className="flex justify-between"><dt>Paid</dt><dd className="tabular-nums">{fmtMoney(inv.amountPaid)}</dd></div>
              <div className="flex justify-between border-t pt-2 text-lg font-semibold"><dt>{inv.status === 'paid' ? 'Paid in full' : inv.status === 'void' ? 'Voided' : 'Balance due'}</dt><dd className="tabular-nums">{inv.status === 'open' ? fmtMoney(inv.balance) : ''}</dd></div>
            </dl>
            <div className="flex flex-wrap gap-2">
              {inv.canPayOnline && <Button disabled={busy} onClick={() => void pay()}>{busy ? 'Opening secure checkout…' : `Pay ${fmtMoney(inv.balance)} by card`}</Button>}
              <a className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent" href={`/api/public/invoices/${token}/pdf`} target="_blank" rel="noreferrer">View or download PDF</a>
            </div>
            {inv.canPayOnline && <p className="text-xs text-muted-foreground">Card payments are processed by Stripe. Your card details are entered on Stripe’s page and never reach {inv.company} or this site.</p>}
          </CardContent>
        </>}
      </Card>
    </main>
  );
}
export default function PublicInvoicePage() {
  return <Suspense><PublicInvoice /></Suspense>;
}
