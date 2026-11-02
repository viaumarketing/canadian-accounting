'use client';
import { useState } from 'react';
import { MoneyBar, SalesHeader, TransactionsTable } from '@/components/sales/common';

/** All sales: invoices, credit notes, sales receipts and payments in one list. */
export default function AllSalesPage() {
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<'' | 'open' | 'overdue' | 'paid'>('');
  return (
    <div className="space-y-5">
      <SalesHeader title="Sales transactions" />
      <MoneyBar key={version} onPick={(s) => setStatus(s)} />
      <TransactionsTable key={status} initialStatus={status} onChange={() => setVersion((v) => v + 1)} />
    </div>
  );
}
