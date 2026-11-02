'use client';
import { useParams } from 'next/navigation';
import { SalesForm } from '@/components/sales/sales-form';

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  return <SalesForm key={id} kind="invoice" id={id} />;
}
