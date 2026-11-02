'use client';
import { useParams } from 'next/navigation';
import { PurchaseForm } from '@/components/purchases/purchase-form';

export default function BillPage() {
  const { id } = useParams<{ id: string }>();
  return <PurchaseForm key={id} kind="bill" id={id} />;
}
