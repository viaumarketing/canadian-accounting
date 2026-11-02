'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { SalesForm } from '@/components/sales/sales-form';

function NewReceipt() {
  return <SalesForm kind="receipt" presetCustomer={useSearchParams().get('customer')} />;
}
export default function NewSalesReceiptPage() {
  return <Suspense><NewReceipt /></Suspense>;
}
