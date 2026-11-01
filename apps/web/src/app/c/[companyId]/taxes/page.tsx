'use client';
import { PageTitle, Table, Td } from '@/components/accounting/bits';
import { Badge, Card } from '@/components/ui/card';
import { FormError } from '@/components/ui/form';
import { errorMessage } from '@/lib/api';
import { useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Code { id: string; code: string; name: string; kind: string; rates: { id: string; component: string; rate: string; recoverable: boolean; effectiveFrom: string; effectiveTo: string | null; source: string | null }[] }

export default function TaxesPage() {
  const { companyId } = useCompany();
  const { data, error } = useApi<Code[]>(`/companies/${companyId}/tax-codes`);
  return (
    <div className="space-y-4">
      <PageTitle>Taxes</PageTitle>
      <Card className="border-warning/40 bg-warning/5 p-4 text-sm">
        Starter rates are seed data, not tax advice. Rates marked <Badge tone="warning">unverified</Badge> were not checked against an official source; confirm every rate with the CRA, Revenu Québec or the province before relying on it. This system prepares tax figures; it does not file returns.
      </Card>
      <FormError message={error ? errorMessage(error) : null} />
      <Table head={['Code', 'Component', 'Rate', 'Recoverable', 'From', 'To', 'Source']}>
        {(data ?? []).flatMap((c) => c.rates.length === 0
          ? [<tr key={c.id}><Td mono>{c.code}</Td><Td>{c.kind.replace('_', ' ').toLowerCase()}</Td><Td>0%</Td><Td /><Td /><Td /><Td /></tr>]
          : c.rates.map((r) => (
            <tr key={r.id}>
              <Td mono>{c.code}</Td><Td>{r.component}</Td><Td>{(parseFloat(r.rate) * 100).toFixed(3).replace(/\.?0+$/, '')}%</Td><Td>{r.recoverable ? 'yes' : 'no'}</Td>
              <Td>{r.effectiveFrom.slice(0, 10)}</Td><Td>{r.effectiveTo?.slice(0, 10) ?? 'open'}</Td>
              <Td>{r.source?.includes('UNVERIFIED') ? <Badge tone="warning">unverified</Badge> : <Badge tone="success">CRA</Badge>}</Td>
            </tr>
          )))}
      </Table>
    </div>
  );
}
