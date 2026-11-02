'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PurchaseForm } from '@/components/purchases/purchase-form';

function NewBill() {
  const p = useSearchParams();
  return <PurchaseForm kind={p.get('kind') === 'credit' ? 'credit' : 'bill'} />;
}
export default function NewBillPage() {
  return <Suspense><NewBill /></Suspense>;
}
