'use client';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { PageTitle, Table, Td } from '@/components/accounting/bits';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';

interface Job { id: string; kind: string; status: string; trigger: string; attempts: number; createdAt: string; finishedAt: string | null; error: string | null; progress: Record<string, number | string>; errorLog: { message: string }[] }
interface Store {
  id: string; shopDomain: string; shopName: string | null; status: string; currency: string; paymentsEnabled: boolean; lastSyncAt: string | null; lastError: string | null; scopes: string;
  accountMap: Record<string, string>; historyStart: string | null; ordersWatermark: string | null;
  health: { needsReview: number; orders: number; lastJob: Job | null };
}
interface Payout { id: string; shopifyId: string; issuedAt: string; status: string; direction: string; net: string; postingStatus: string; postingNote: string | null }
interface Review { orders: { id: string; name: string; total: string; postingNote: string }[]; refunds: { id: string; total: string; postingNote: string }[]; balanceTransactions: { id: string; type: string; amount: string; fee: string; orderName: string | null; adjustmentReason: string | null; postingNote: string }[]; payouts: { id: string; shopifyId: string; net: string; postingNote: string }[] }
interface Detail {
  payout: Payout; tieOut: { componentsNet: string; payoutNet: string; difference: string; ok: boolean | null; unresolvedComponents: number };
  components: Record<'charges' | 'refunds' | 'adjustments' | 'reserves' | 'total', { count: number; gross: string; fees: string; net: string }>;
  transactions: { id: string; type: string; date: string; amount: string; fee: string; net: string; orderName: string | null; postingStatus: string }[];
  orders: { name: string; total: string; postingStatus: string }[]; bankMatch: null;
}
interface Account { id: string; code: string; name: string; role: string | null }

const tone = (s: string) => (['POSTED', 'SUCCEEDED', 'CONNECTED', 'PAID'].includes(s) ? 'success' : ['NEEDS_REVIEW', 'FAILED', 'DEAD', 'ERROR', 'FAILED'].includes(s) ? 'danger' : ['PENDING', 'RUNNING', 'SCHEDULED'].includes(s) ? 'warning' : 'neutral') as 'success' | 'danger' | 'warning' | 'neutral';
const when = (s: string | null) => (s ? new Date(s).toLocaleString('en-CA') : '—');
const KEY_LABELS: Record<string, string> = { clearing: 'Shopify Payments clearing', otherClearing: 'Third-party gateway clearing', sales: 'Sales', shipping: 'Shipping revenue', giftCard: 'Gift card liability', fees: 'Processing fees', bank: 'Bank (payouts land here)', refunds: 'Sales returns', reserve: 'Payments reserve', disputeHold: 'Disputed funds held', chargebackFees: 'Chargeback fees', shippingExpense: 'Shipping label expense' };

function Stores({ companyId, canManage, canSync }: { companyId: string; canManage: boolean; canSync: boolean }) {
  const base = `/companies/${companyId}/shopify`;
  const params = useSearchParams();
  const { data, reload, error } = useApi<Store[]>(`${base}/stores`);
  const { data: accounts } = useApi<Account[]>(canManage ? `/companies/${companyId}/accounts` : null);
  const [shop, setShop] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [since, setSince] = useState('');
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); await reload(); } catch (x) { setErr(errorMessage(x)); } };
  async function connect(e: FormEvent) {
    e.preventDefault();
    await run(async () => { const r = await api<{ authorizeUrl: string }>(`${base}/connect`, { method: 'POST', body: { shop } }); window.location.href = r.authorizeUrl; });
  }
  return (
    <div className="space-y-4">
      {params.get('connected') && <p role="status" className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">Store connected. The first sync has been queued.</p>}
      <FormError message={err ?? params.get('error') ?? (error ? errorMessage(error) : null)} />
      {data && data.length === 0 && <Card><EmptyState title="No Shopify store connected">Connect a store to import orders, refunds, fees and payouts into the books. Only read-only permissions are requested.</EmptyState></Card>}
      {(data ?? []).map((s) => (
        <Card key={s.id}><CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{s.shopName ?? s.shopDomain}</h2><Badge tone={tone(s.status)}>{s.status.toLowerCase()}</Badge>
            <span className="text-sm text-muted-foreground">{s.shopDomain} · {s.currency} · Shopify Payments {s.paymentsEnabled ? 'on' : 'off'}</span>
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-4">
            <div><dt className="text-muted-foreground">Last sync</dt><dd>{when(s.lastSyncAt)}</dd></div>
            <div><dt className="text-muted-foreground">Orders imported</dt><dd>{s.health.orders}</dd></div>
            <div><dt className="text-muted-foreground">Needs review</dt><dd className={s.health.needsReview ? 'font-semibold text-warning' : ''}>{s.health.needsReview}</dd></div>
            <div><dt className="text-muted-foreground">History from</dt><dd>{s.historyStart?.slice(0, 10) ?? 'all available'}</dd></div>
          </dl>
          {s.lastError && <p className="flex items-start gap-2 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{s.lastError}</p>}
          {!s.scopes.includes('read_all_orders') && <p className="text-xs text-muted-foreground">Without the <code>read_all_orders</code> permission Shopify only returns orders from the last 60 days; older history needs that scope (see docs).</p>}
          {canSync && s.status === 'CONNECTED' && (
            <div className="flex flex-wrap items-end gap-2">
              <Button onClick={() => void run(() => api(`${base}/stores/${s.id}/sync`, { method: 'POST', body: { kind: 'INCREMENTAL' } }))}><RefreshCw className="h-4 w-4" aria-hidden /> Sync now</Button>
              <Field label="Re-import history since" htmlFor={`since-${s.id}`}><Input id={`since-${s.id}`} type="date" value={since} onChange={(e) => setSince(e.target.value)} /></Field>
              <Button variant="outline" onClick={() => void run(() => api(`${base}/stores/${s.id}/sync`, { method: 'POST', body: { kind: 'HISTORICAL', since: since || undefined } }))}>Historical sync</Button>
              <Button variant="outline" onClick={() => void run(() => api(`${base}/stores/${s.id}/repost`, { method: 'POST' }))}>Retry posting</Button>
            </div>
          )}
          {canManage && s.status === 'CONNECTED' && accounts && (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">Account mapping</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {Object.keys(KEY_LABELS).map((k) => (
                  <Field key={k} label={KEY_LABELS[k]} htmlFor={`map-${s.id}-${k}`}>
                    <Select id={`map-${s.id}-${k}`} value={s.accountMap[k] ?? ''} onChange={(e) => void run(() => api(`${base}/stores/${s.id}/settings`, { method: 'PATCH', body: { accountMap: { [k]: e.target.value } } }))}>
                      <option value="" disabled>Not mapped</option>
                      {accounts.filter((a) => !a.role).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                    </Select>
                  </Field>
                ))}
              </div>
            </details>
          )}
          {canManage && <Button variant="ghost" size="sm" onClick={() => { if (confirm('Disconnect this store? Imported data and journals are kept.')) void run(() => api(`${base}/stores/${s.id}`, { method: 'DELETE' })); }}>Disconnect</Button>}
        </CardContent></Card>
      ))}
      {canManage && (
        <Card><CardHeader><CardTitle>Connect a store</CardTitle></CardHeader><CardContent>
          <form onSubmit={connect} className="flex flex-wrap items-end gap-3">
            <Field label="Store address" htmlFor="shop" hint="e.g. maple-goods.myshopify.com"><Input id="shop" required value={shop} onChange={(e) => setShop(e.target.value)} className="w-72" /></Field>
            <Button type="submit">Connect with Shopify</Button>
          </form>
          <p className="mt-3 text-xs text-muted-foreground">You will be sent to Shopify to approve read-only access. Requires <code>SHOPIFY_CLIENT_ID</code> and <code>SHOPIFY_CLIENT_SECRET</code> on the server.</p>
        </CardContent></Card>
      )}
    </div>
  );
}

function Jobs({ companyId }: { companyId: string }) {
  const { data, reload } = useApi<Job[]>(`/companies/${companyId}/shopify/jobs`);
  return (
    <div className="space-y-3">
      <Button variant="outline" size="sm" onClick={() => void reload()}><RefreshCw className="h-4 w-4" aria-hidden /> Refresh</Button>
      {data && data.length === 0 ? <Card><EmptyState title="No sync jobs yet" /></Card> : (
        <Table head={['Started', 'Type', 'Trigger', 'Status', 'Progress', 'Result']}>
          {(data ?? []).map((j) => (
            <tr key={j.id}>
              <Td>{when(j.createdAt)}</Td><Td>{j.kind.toLowerCase()}</Td><Td>{j.trigger}</Td>
              <Td><Badge tone={tone(j.status)}>{j.status.toLowerCase()}</Badge>{j.attempts > 1 && <span className="ml-1 text-xs text-muted-foreground">try {j.attempts}</span>}</Td>
              <Td><span className="text-xs">{j.progress.phase as string} · {j.progress.orders as number ?? 0} orders · {j.progress.payouts as number ?? 0} payouts · {j.progress.balanceTransactions as number ?? 0} balance txns{Number(j.progress.throttleWaits) > 0 && ` · throttled ×${j.progress.throttleWaits}`}</span></Td>
              <Td><span className="text-xs">{j.error ?? (j.status === 'SUCCEEDED' ? `${j.progress.posted ?? 0} posted, ${j.progress.needsReview ?? 0} to review` : '')}{j.errorLog.length > 0 && j.status === 'SUCCEEDED' && ` · ${j.errorLog.length} warnings: ${j.errorLog[0].message}`}</span></Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

function Payouts({ companyId }: { companyId: string }) {
  const { data } = useApi<Payout[]>(`/companies/${companyId}/shopify/payouts`);
  const [sel, setSel] = useState<string | null>(null);
  const { data: d } = useApi<Detail>(sel ? `/companies/${companyId}/shopify/payouts/${sel}` : null);
  return (
    <div className="space-y-4">
      {data && data.length === 0 ? <Card><EmptyState title="No payouts yet">Payouts appear after the first sync of a store with Shopify Payments.</EmptyState></Card> : (
        <Table head={['Issued', 'Payout', 'Status', 'Net', 'Books', '']} right={[3]}>
          {(data ?? []).map((p) => (
            <tr key={p.id} className={sel === p.id ? 'bg-accent/40' : ''}>
              <Td>{p.issuedAt.slice(0, 10)}</Td><Td mono>{p.shopifyId.split('/').pop()}</Td><Td><Badge tone={tone(p.status)}>{p.status.toLowerCase()}</Badge></Td>
              <Td right>{fmtMoney(p.net)}</Td><Td><Badge tone={tone(p.postingStatus)}>{p.postingStatus.replace('_', ' ').toLowerCase()}</Badge></Td>
              <Td><Button size="sm" variant="outline" onClick={() => setSel(p.id)}>Reconcile</Button></Td>
            </tr>
          ))}
        </Table>
      )}
      {d && (
        <Card><CardHeader><CardTitle>Payout {d.payout.shopifyId.split('/').pop()} · reconciliation</CardTitle></CardHeader><CardContent className="space-y-4">
          <div className="grid gap-3 text-sm sm:grid-cols-4">
            {(['charges', 'refunds', 'adjustments', 'reserves'] as const).map((k) => (
              <div key={k} className="rounded-md border p-3"><div className="text-muted-foreground capitalize">{k} ({d.components[k].count})</div><div className="font-medium">Gross {fmtMoney(d.components[k].gross)}</div><div>Fees {fmtMoney(d.components[k].fees)}</div><div>Net {fmtMoney(d.components[k].net)}</div></div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>Σ transactions {fmtMoney(d.tieOut.componentsNet)}</span><span>Payout net {fmtMoney(d.tieOut.payoutNet)}</span>
            {d.tieOut.ok === true && <Badge tone="success"><CheckCircle2 className="mr-1 h-3 w-3" aria-hidden />ties out</Badge>}
            {d.tieOut.ok === false && <Badge tone="danger">difference {fmtMoney(d.tieOut.difference)}</Badge>}
            {d.tieOut.unresolvedComponents > 0 && <Badge tone="warning">{d.tieOut.unresolvedComponents} unresolved transactions</Badge>}
            <Badge>bank deposit: matching arrives with banking (Milestone 4)</Badge>
          </div>
          {d.payout.postingNote && <p className="text-sm text-warning">{d.payout.postingNote}</p>}
          <Table head={['Date', 'Type', 'Order', 'Amount', 'Fee', 'Net', 'Books']} right={[3, 4, 5]}>
            {d.transactions.map((t) => <tr key={t.id}><Td>{t.date.slice(0, 10)}</Td><Td mono>{t.type}</Td><Td>{t.orderName}</Td><Td right>{fmtMoney(t.amount)}</Td><Td right>{fmtMoney(t.fee)}</Td><Td right>{fmtMoney(t.net)}</Td><Td><Badge tone={tone(t.postingStatus)}>{t.postingStatus.replace('_', ' ').toLowerCase()}</Badge></Td></tr>)}
          </Table>
        </CardContent></Card>
      )}
    </div>
  );
}

function ReviewQueue({ companyId, canPost }: { companyId: string; canPost: boolean }) {
  const base = `/companies/${companyId}/shopify`;
  const { data, reload } = useApi<Review>(`${base}/review`);
  const { data: accounts } = useApi<Account[]>(canPost ? `/companies/${companyId}/accounts` : null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const empty = data && !data.orders.length && !data.refunds.length && !data.balanceTransactions.length && !data.payouts.length;
  return (
    <div className="space-y-4">
      <FormError message={err} />
      {empty && <Card><EmptyState icon={<CheckCircle2 className="h-8 w-8" aria-hidden />} title="Nothing needs review">Everything imported so far has been posted or deliberately skipped.</EmptyState></Card>}
      {data && data.orders.length > 0 && <Table head={['Order', 'Total', 'Why it was not posted']} right={[1]}>{data.orders.map((o) => <tr key={o.id}><Td>{o.name}</Td><Td right>{fmtMoney(o.total)}</Td><Td>{o.postingNote}</Td></tr>)}</Table>}
      {data && data.refunds.length > 0 && <Table head={['Refund', 'Total', 'Why']} right={[1]}>{data.refunds.map((o) => <tr key={o.id}><Td mono>{o.id.slice(0, 8)}</Td><Td right>{fmtMoney(o.total)}</Td><Td>{o.postingNote}</Td></tr>)}</Table>}
      {data && data.payouts.length > 0 && <Table head={['Payout', 'Net', 'Why']} right={[1]}>{data.payouts.map((o) => <tr key={o.id}><Td mono>{o.shopifyId.split('/').pop()}</Td><Td right>{fmtMoney(o.net)}</Td><Td>{o.postingNote}</Td></tr>)}</Table>}
      {data && data.balanceTransactions.length > 0 && (
        <Table head={['Type', 'Order', 'Amount', 'Reason', 'Assign to account']} right={[2]}>
          {data.balanceTransactions.map((b) => (
            <tr key={b.id}><Td mono>{b.type}</Td><Td>{b.orderName}</Td><Td right>{fmtMoney(b.amount)}</Td><Td>{b.adjustmentReason ?? b.postingNote}</Td>
              <Td>{canPost && accounts ? (
                <div className="flex gap-1">
                  <Select aria-label={`Account for ${b.type}`} value={pick[b.id] ?? ''} onChange={(e) => setPick({ ...pick, [b.id]: e.target.value })} className="h-8 w-52"><option value="">Select…</option>{accounts.filter((a) => !a.role).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select>
                  <Button size="sm" disabled={!pick[b.id]} onClick={async () => { setErr(null); try { await api(`${base}/balance-transactions/${b.id}/classify`, { method: 'POST', body: { accountId: pick[b.id] } }); const s = await api<{ id: string }[]>(`${base}/stores`); for (const st of s) await api(`${base}/stores/${st.id}/repost`, { method: 'POST' }); await reload(); } catch (x) { setErr(errorMessage(x)); } }}>Post</Button>
                </div>) : null}</Td></tr>
          ))}
        </Table>
      )}
    </div>
  );
}

interface OrderRow { id: string; name: string; processedAt: string; total: string; tax: string; postingStatus: string; postingNote: string | null; test: boolean }
function Orders({ companyId }: { companyId: string }) {
  const { data } = useApi<OrderRow[]>(`/companies/${companyId}/shopify/orders`);
  return data && data.length === 0 ? <Card><EmptyState title="No orders imported yet" /></Card> : (
    <Table head={['Order', 'Date', 'Total', 'Tax', 'Books', 'Note']} right={[2, 3]}>
      {(data ?? []).map((o) => <tr key={o.id}><Td>{o.name}{o.test && ' (test)'}</Td><Td>{o.processedAt.slice(0, 10)}</Td><Td right>{fmtMoney(o.total)}</Td><Td right>{fmtMoney(o.tax)}</Td><Td><Badge tone={tone(o.postingStatus)}>{o.postingStatus.replace('_', ' ').toLowerCase()}</Badge></Td><Td>{o.postingNote}</Td></tr>)}
    </Table>
  );
}

export default function ShopifyPage() {
  const { companyId, can } = useCompany();
  return (
    <div className="space-y-4">
      <PageTitle>Shopify</PageTitle>
      <Tabs defaultValue="stores">
        <TabsList><TabsTrigger value="stores">Stores</TabsTrigger><TabsTrigger value="payouts">Payouts</TabsTrigger><TabsTrigger value="orders">Orders</TabsTrigger><TabsTrigger value="review">Needs review</TabsTrigger><TabsTrigger value="jobs">Import health</TabsTrigger></TabsList>
        <TabsContent value="stores"><Stores companyId={companyId} canManage={can('settings:create')} canSync={can('shopify:create')} /></TabsContent>
        <TabsContent value="payouts"><Payouts companyId={companyId} /></TabsContent>
        <TabsContent value="orders"><Orders companyId={companyId} /></TabsContent>
        <TabsContent value="review"><ReviewQueue companyId={companyId} canPost={can('shopify:post')} /></TabsContent>
        <TabsContent value="jobs"><Jobs companyId={companyId} /></TabsContent>
      </Tabs>
    </div>
  );
}
