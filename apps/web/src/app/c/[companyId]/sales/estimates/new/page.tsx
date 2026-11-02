'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { SalesForm } from '@/components/sales/sales-form';

function NewEstimate() {
  const p = useSearchParams();
  return <SalesForm kind="estimate" presetCustomer={p.get('customer')} />;
}
export default function NewEstimatePage() {
  return <Suspense><NewEstimate /></Suspense>;
}
