'use client';
import { SalesHeader, TransactionsTable } from '@/components/sales/common';

export default function SalesReceiptsPage() {
  return (
    <div className="space-y-5">
      <SalesHeader title="Sales receipts" />
      <p className="text-sm text-muted-foreground">A sales receipt records a sale paid on the spot: no invoice, no receivable, the money goes straight to the bank or cash account you choose.</p>
      <TransactionsTable type="sales_receipt" />
    </div>
  );
}
