'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { MoneyBar, SalesHeader, TransactionsTable } from '@/components/sales/common';

function Invoices() {
  const params = useSearchParams();
  const initial = (['open', 'overdue', 'paid'] as const).find((s) => s === params.get('status')) ?? '';
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<'' | 'open' | 'overdue' | 'paid'>(initial);
  return (
    <div className="space-y-5">
      <SalesHeader title="Invoices" />
      <MoneyBar key={version} onPick={(s) => setStatus(s)} />
      <TransactionsTable key={status} type="invoice" initialStatus={status} onChange={() => setVersion((v) => v + 1)} />
    </div>
  );
}
export default function InvoicesPage() {
  return <Suspense><Invoices /></Suspense>;
}
