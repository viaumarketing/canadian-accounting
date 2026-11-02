'use client';
import { useParams } from 'next/navigation';
import { PurchaseForm } from '@/components/purchases/purchase-form';

export default function PurchaseOrderPage() {
  const { id } = useParams<{ id: string }>();
  return <PurchaseForm key={id} kind="po" id={id} />;
}
