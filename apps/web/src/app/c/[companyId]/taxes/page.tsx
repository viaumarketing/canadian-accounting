'use client';
import { useEffect, useState } from 'react';
import { PageTitle, Table, Td } from '@/components/accounting/bits';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Code { id: string; code: string; name: string; kind: string; rates: { id: string; component: string; rate: string; recoverable: boolean; effectiveFrom: string; effectiveTo: string | null; source: string | null }[] }

interface Reg { id: string; kind: string; registrationNumber: string; effectiveFrom: string; quickMethodFrom: string | null; quickMethodRates: Record<string, { rate: string; credit?: string }> | null }
const pctToFraction = (v: string) => (v.trim() === '' ? null : (Math.round(parseFloat(v) * 100) / 10000).toString());
const fractionToPct = (v?: string) => (v === undefined ? '' : String(Math.round(parseFloat(v) * 1000000) / 10000));

/** GST/HST Quick Method election (CRA guide RC4058): start date and the remittance rate for each GST/HST sales tax code. */
function QuickMethod({ companyId, codes, canEdit }: { companyId: string; codes: Code[]; canEdit: boolean }) {
  const { data, reload } = useApi<Reg[]>(`/companies/${companyId}/tax-registrations`);
  const reg = (data ?? []).find((r) => r.kind === 'GST_HST');
  const taxable = codes.filter((c) => c.rates.some((r) => r.component === 'GST' || r.component === 'HST'));
  const [from, setFrom] = useState('');
  const [rates, setRates] = useState<Record<string, { rate: string; credit: string }>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!reg) return;
    setFrom(reg.quickMethodFrom?.slice(0, 10) ?? '');
    setRates(Object.fromEntries(Object.entries(reg.quickMethodRates ?? {}).map(([k, v]) => [k, { rate: fractionToPct(v.rate), credit: fractionToPct(v.credit) }])));
  }, [reg]);
  if (!reg) return null;
  async function save(off = false) {
    setErr(null); setMsg(null);
    const body = off ? { from: null, rates: {} } : {
      from: from || null,
      rates: Object.fromEntries(Object.entries(rates).filter(([, v]) => v.rate.trim() !== '').map(([k, v]) => [k, { rate: pctToFraction(v.rate)!, ...(v.credit.trim() ? { credit: pctToFraction(v.credit)! } : {}) }])),
    };
    try { await api(`/companies/${companyId}/tax-registrations/${reg!.id}/quick-method`, { method: 'PATCH', body }); await reload(); setMsg(off ? 'Back to the regular method.' : 'Saved.'); } catch (x) { setErr(errorMessage(x)); }
  }
  return (
    <Card><CardHeader><CardTitle>GST/HST Quick Method</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        {reg.quickMethodFrom ? <>In effect since <strong>{reg.quickMethodFrom.slice(0, 10)}</strong> for {reg.registrationNumber}.</> : <>Not elected: {reg.registrationNumber} uses the regular method.</>}{' '}
        Enter the remittance rate CRA guide RC4058 gives your business for each tax code you charge. The system never chooses rates for you. A tax code left blank is treated as a supply not eligible for the Quick Method, and its GST/HST is reported in full. The credit column is only for 0%-rate supplies.
      </p>
      <FormError message={err} />{msg && <p role="status" className="text-success">{msg}</p>}
      <fieldset disabled={!canEdit} className="space-y-3">
        <div className="max-w-xs"><Field label="Election in effect from" htmlFor="qm-from"><Input id="qm-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field></div>
        <Table head={['Tax code', 'Remittance rate %', 'Credit % (0%-rate supplies only)']}>
          {taxable.map((c) => (
            <tr key={c.id}>
              <Td mono>{c.code}</Td>
              <Td><Input aria-label={`Remittance rate for ${c.code}`} inputMode="decimal" className="h-8 w-28" value={rates[c.code]?.rate ?? ''} onChange={(e) => setRates({ ...rates, [c.code]: { rate: e.target.value, credit: rates[c.code]?.credit ?? '' } })} /></Td>
              <Td><Input aria-label={`Credit rate for ${c.code}`} inputMode="decimal" className="h-8 w-28" value={rates[c.code]?.credit ?? ''} onChange={(e) => setRates({ ...rates, [c.code]: { rate: rates[c.code]?.rate ?? '', credit: e.target.value } })} /></Td>
            </tr>
          ))}
        </Table>
        {canEdit && <div className="flex gap-2"><Button onClick={() => void save()} disabled={!from}>Save election</Button>{reg.quickMethodFrom && <Button variant="outline" onClick={() => void save(true)}>Stop using the Quick Method</Button>}</div>}
      </fieldset>
    </CardContent></Card>
  );
}

export default function TaxesPage() {
  const { companyId, can } = useCompany();
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
      <QuickMethod companyId={companyId} codes={data ?? []} canEdit={can('taxes:create')} />
    </div>
  );
}
