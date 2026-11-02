'use client';
import { CheckCircle2, Circle, Clock } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { DashboardCharts } from '@/components/dashboard-charts';
import { Badge, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@/components/ui/card';
import { errorMessage } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { FormError } from '@/components/ui/form';
import { fmtMoney } from '@/lib/company';

interface Dashboard {
  company: { id: string; legalName: string; province: string; baseCurrency: string };
  fiscalYear: { label: string; startDate: string; endDate: string; status: string } | null;
  counts: { activeMembers: number; taxRegistrations: number; auditEvents: number };
  financials: { revenue: string; expenses: string; netIncome: string; accountsReceivable: string; accountsPayable: string; salesTaxPayable: string } | null;
  setup: { hasTaxRegistration: boolean; hasBusinessNumber: boolean; hasLedger: boolean };
}

const KPIS = ['Revenue (YTD)', 'Expenses (YTD)', 'Net income (YTD)', 'Accounts receivable', 'Accounts payable', 'Sales tax payable'];
const KEYS = ['revenue', 'expenses', 'netIncome', 'accountsReceivable', 'accountsPayable', 'salesTaxPayable'] as const;
const fmtDate = (s: string) => new Date(s).toLocaleDateString('en-CA', { timeZone: 'UTC', dateStyle: 'medium' });

export default function DashboardPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const { data, error, loading } = useApi<Dashboard>(`/companies/${companyId}/dashboard`);
  useEffect(() => {
    try {
      localStorage.setItem('ca.company', companyId);
    } catch { /* storage unavailable */ }
  }, [companyId]);

  if (error) return <FormError message={errorMessage(error)} />;
  if (loading || !data) {
    return (
      <div className="space-y-6" aria-busy>
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{KPIS.map((k) => <Skeleton key={k} className="h-28" />)}</div>
      </div>
    );
  }
  const steps = [
    { done: true, label: 'Company created', href: null as string | null },
    { done: data.setup.hasBusinessNumber, label: 'Add your CRA business number', href: `/c/${companyId}/settings` },
    { done: data.setup.hasTaxRegistration, label: 'Add a GST/HST (or QST/PST) registration', href: `/c/${companyId}/settings` },
    { done: data.counts.activeMembers > 1, label: 'Invite your accountant or bookkeeper', href: `/c/${companyId}/settings` },
    { done: data.setup.hasLedger, label: 'Post your first entry or invoice', href: `/c/${companyId}/accounting` },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{data.company.legalName}</h1>
          <p className="text-sm text-muted-foreground">
            {data.company.province} · {data.company.baseCurrency}
            {data.fiscalYear && <> · {data.fiscalYear.label}: {fmtDate(data.fiscalYear.startDate)} – {fmtDate(data.fiscalYear.endDate)}</>}
          </p>
        </div>
        {!data.financials && <Badge tone="warning"><Clock className="mr-1 h-3 w-3" aria-hidden /> Nothing posted yet</Badge>}
      </div>

      <section aria-label="Key figures" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {KPIS.map((k, i) => (
          <Card key={k}>
            <CardHeader><CardTitle>{k}</CardTitle></CardHeader>
            <CardContent>
              {data.financials ? (
                <p className="text-2xl font-semibold">{fmtMoney(data.financials[KEYS[i]])}</p>
              ) : (
                <><p className="text-2xl font-semibold text-muted-foreground" aria-label="No data">—</p>
                <p className="mt-1 text-xs text-muted-foreground">Derived from the ledger once entries are posted.</p></>
              )}
            </CardContent>
          </Card>
        ))}
      </section>

      {data.financials && <DashboardCharts companyId={companyId} />}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-3">
          <CardHeader><CardTitle>Getting started</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-3 text-sm">
              {steps.map((s) => (
                <li key={s.label} className="flex items-start gap-2">
                  {s.done ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Done" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-label="To do" />}
                  {!s.done && s.href ? <Link className="underline-offset-2 hover:underline" href={s.href}>{s.label}</Link> : <span className={s.done ? 'text-muted-foreground' : ''}>{s.label}</span>}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <section aria-label="Company facts" className="grid gap-4 sm:grid-cols-3">
        {[['Active members', data.counts.activeMembers], ['Tax registrations', data.counts.taxRegistrations], ['Audit events', data.counts.auditEvents]].map(([l, v]) => (
          <Card key={l}>
            <CardHeader><CardTitle>{l}</CardTitle></CardHeader>
            <CardContent><p className="text-2xl font-semibold">{v}</p></CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
