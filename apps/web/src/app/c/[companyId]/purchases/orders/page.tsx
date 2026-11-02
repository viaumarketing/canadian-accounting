'use client';
import { useRouter } from 'next/navigation';
import { PurchasesHeader } from '@/components/purchases/header';
import { StatusPill } from '@/components/sales/common';
import { Button } from '@/components/ui/button';
import { Card, EmptyState } from '@/components/ui/card';
import { FormError } from '@/components/ui/form';
import { errorMessage } from '@/lib/api';
import { fmtMoney, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Po { id: string; number: string; status: 'OPEN' | 'CLOSED' | 'VOID'; issueDate: string; expectedDate: string | null; total: string; contact: { name: string } }

export default function PurchaseOrdersPage() {
  const { companyId, can } = useCompany();
  const router = useRouter();
  const { data, error } = useApi<Po[]>(`/companies/${companyId}/purchase-orders`);
  return (
    <div className="space-y-5">
      <PurchasesHeader title="Purchase orders" actions={can('purchases:create') && <Button variant="outline" onClick={() => router.push(`/c/${companyId}/purchases/orders/new`)}>New purchase order</Button>} />
      <FormError message={error ? errorMessage(error) : null} />
      {data && data.length === 0 ? <Card><EmptyState title="No purchase orders yet">A purchase order records what you ordered from a supplier. It has no effect on the books; convert it to a bill when the goods and the invoice arrive.</EmptyState></Card> : (
        <div className="overflow-x-auto rounded-md border bg-card shadow-sm">
          <table className="w-full min-w-[44rem] text-sm">
            <thead className="border-b bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr>{['Date', 'No.', 'Supplier', 'Expected', 'Total', 'Status'].map((h, i) => <th key={h} className={`px-3 py-2.5 ${i === 4 ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
            <tbody>
              {(data ?? []).map((p) => (
                <tr key={p.id} className="cursor-pointer border-b last:border-0 hover:bg-accent/50" onClick={() => router.push(`/c/${companyId}/purchases/orders/${p.id}`)}>
                  <td className="px-3 py-2.5">{p.issueDate.slice(0, 10)}</td><td className="px-3 py-2.5 font-mono text-xs">{p.number}</td><td className="px-3 py-2.5">{p.contact.name}</td><td className="px-3 py-2.5">{p.expectedDate?.slice(0, 10) ?? ''}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(p.total)}</td>
                  <td className="px-3 py-2.5"><StatusPill row={{ state: p.status === 'OPEN' ? 'open' : p.status === 'CLOSED' ? 'paid' : 'void', status: { OPEN: 'Open', CLOSED: 'Closed', VOID: 'Voided' }[p.status] }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
