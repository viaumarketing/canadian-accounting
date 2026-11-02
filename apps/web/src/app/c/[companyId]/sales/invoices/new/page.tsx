'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { SalesForm } from '@/components/sales/sales-form';

function NewInvoice() {
  const p = useSearchParams();
  return <SalesForm kind={p.get('kind') === 'credit' ? 'credit' : 'invoice'} presetCustomer={p.get('customer')} />;
}
export default function NewInvoicePage() {
  return <Suspense><NewInvoice /></Suspense>;
}
