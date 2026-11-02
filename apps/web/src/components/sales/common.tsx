'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronDown, Printer, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { api, errorMessage } from '@/lib/api';
import { fmtMoney, today, useCompany } from '@/lib/company';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';

export type SaleType = 'invoice' | 'credit_note' | 'sales_receipt' | 'payment';
export interface SaleRow { id: string; type: SaleType; date: string; number: string | null; customer: string; contactId: string; dueDate: string | null; total: string; balance: string; status: string; state: 'draft' | 'open' | 'overdue' | 'paid' | 'void' }
export interface MoneyBarData { unpaid: { overdue: string; overdueCount: number; notDueYet: string; notDueYetCount: number }; paidLast30Days: { amount: string; count: number } }
export interface Account { id: string; code: string; name: string; type: string; role: string | null }

export const TYPE_LABEL: Record<SaleType, string> = { invoice: 'Invoice', credit_note: 'Credit note', sales_receipt: 'Sales receipt', payment: 'Payment' };

/** Tabs across the top of every Sales page. */
export function SalesHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  const { companyId, can } = useCompany();
  const pathname = usePathname();
  const router = useRouter();
  const base = `/c/${companyId}/sales`;
  const tabs = [['All sales', base], ['Invoices', `${base}/invoices`], ['Estimates', `${base}/estimates`], ['Sales receipts', `${base}/receipts`], ['Recurring', `${base}/recurring`], ['Customers', `${base}/customers`], ['Products & services', `${base}/products`]] as const;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <div className="ml-auto flex items-center gap-2">
          {actions}
          {can('sales:create') && (
            <div className="flex">
              <Button className="rounded-r-none" onClick={() => router.push(`${base}/invoices/new`)}>New invoice</Button>
              <Menu>
                <MenuTrigger asChild><Button className="rounded-l-none border-l border-primary-foreground/30 px-2" aria-label="More new sales transactions"><ChevronDown className="h-4 w-4" /></Button></MenuTrigger>
                <MenuContent align="end">
                  <MenuItem onSelect={() => router.push(`${base}/estimates/new`)}>Estimate</MenuItem>
                  <MenuItem onSelect={() => router.push(`${base}/receipts/new`)}>Sales receipt</MenuItem>
                  <MenuItem onSelect={() => router.push(`${base}/invoices/new?kind=credit`)}>Credit note</MenuItem>
                  <MenuItem onSelect={() => router.push(`${base}/invoices?status=open`)}>Receive payment</MenuItem>
                </MenuContent>
              </Menu>
            </div>
          )}
        </div>
      </div>
      <nav aria-label="Sales" className="flex gap-1 overflow-x-auto border-b">
        {tabs.map(([label, href]) => {
          const active = href === base ? pathname === base : pathname.startsWith(href);
          return (
            <Link key={href} href={href} aria-current={active ? 'page' : undefined}
              className={cn('whitespace-nowrap border-b-2 px-3 pb-2 pt-1 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', active ? 'border-primary text-foreground' : 'border-transparent')}>
              {label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** Unpaid (overdue / not due yet) and paid in the last 30 days, as coloured bars proportional to the amounts. */
export function MoneyBar({ onPick }: { onPick?: (status: 'overdue' | 'open' | 'paid') => void }) {
  const { companyId } = useCompany();
  const { data } = useApi<MoneyBarData>(`/companies/${companyId}/sales/summary`);
  if (!data) return <div className="h-24 animate-pulse rounded-md bg-card" />;
  const o = Number(data.unpaid.overdue), n = Number(data.unpaid.notDueYet), p = Number(data.paidLast30Days.amount);
  const unpaid = o + n;
  const seg = (label: string, sub: string, amount: string, cls: string, flex: number, status: 'overdue' | 'open' | 'paid') => (
    <button type="button" onClick={() => onPick?.(status)} style={{ flexGrow: Math.max(flex, 0.0001) }}
      className="min-w-[8rem] basis-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <div className="text-xl font-semibold tabular-nums">{fmtMoney(amount)}</div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label} <span className="normal-case">· {sub}</span></div>
      <div className={cn('mt-2 h-3 rounded-sm', Number(amount) === 0 ? 'bg-slate-200 dark:bg-slate-700' : cls)} />
    </button>
  );
  return (
    <section aria-label="Money bar" className="grid gap-4 rounded-md border bg-card p-4 shadow-sm md:grid-cols-[2fr_1fr]">
      <div>
        <div className="mb-2 text-sm"><span className="font-semibold">{fmtMoney(unpaid.toFixed(2))} Unpaid</span> <span className="text-muted-foreground">· open invoices</span></div>
        <div className="flex gap-1">
          {seg('Overdue', `${data.unpaid.overdueCount} invoice${data.unpaid.overdueCount === 1 ? '' : 's'}`, data.unpaid.overdue, 'bg-orange-500', unpaid ? o / unpaid : 0.5, 'overdue')}
          {seg('Not due yet', `${data.unpaid.notDueYetCount} invoice${data.unpaid.notDueYetCount === 1 ? '' : 's'}`, data.unpaid.notDueYet, 'bg-slate-300 dark:bg-slate-600', unpaid ? n / unpaid : 0.5, 'open')}
        </div>
      </div>
      <div>
        <div className="mb-2 text-sm"><span className="font-semibold">{fmtMoney(p.toFixed(2))} Paid</span> <span className="text-muted-foreground">· last 30 days</span></div>
        <div className="flex">{seg('Received', `${data.paidLast30Days.count} payment${data.paidLast30Days.count === 1 ? '' : 's'} or sales receipt${data.paidLast30Days.count === 1 ? '' : 's'}`, data.paidLast30Days.amount, 'bg-primary', 1, 'paid')}</div>
      </div>
    </section>
  );
}

export function StatusPill({ row }: { row: Pick<SaleRow, 'status' | 'state'> }) {
  const cls = { draft: 'bg-secondary text-secondary-foreground', open: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200', overdue: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200', paid: 'bg-accent text-accent-foreground', void: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200' }[row.state];
  return <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium', cls)}><span className={cn('h-1.5 w-1.5 rounded-full', { draft: 'bg-slate-400', open: 'bg-slate-400', overdue: 'bg-orange-500', paid: 'bg-primary', void: 'bg-red-500' }[row.state])} />{row.status}</span>;
}

export const docHref = (companyId: string, r: Pick<SaleRow, 'id' | 'type'>) =>
  r.type === 'sales_receipt' ? `/c/${companyId}/sales/receipts/${r.id}` : r.type === 'payment' ? null : `/c/${companyId}/sales/invoices/${r.id}`;
export const pdfHref = (companyId: string, r: Pick<SaleRow, 'id' | 'type'>) =>
  r.type === 'sales_receipt' ? `/api/companies/${companyId}/sales-receipts/${r.id}/pdf` : r.type === 'payment' ? null : `/api/companies/${companyId}/invoices/${r.id}/pdf`;

/** The sales list: filters, then Date · Type · No. · Customer · Due date · Balance · Total · Status · Action. */
export function TransactionsTable({ type, initialStatus = '', onChange }: { type?: SaleType | ''; initialStatus?: '' | 'open' | 'overdue' | 'paid'; onChange?: () => void }) {
  const { companyId, can } = useCompany();
  const router = useRouter();
  const [t, setT] = useState<SaleType | ''>(type ?? '');
  const [status, setStatus] = useState(initialStatus);
  const [pay, setPay] = useState<SaleRow | null>(null);
  const q = new URLSearchParams(Object.entries({ type: t, status }).filter(([, v]) => v)).toString();
  const { data, error, reload } = useApi<SaleRow[]>(`/companies/${companyId}/sales/transactions${q ? `?${q}` : ''}`);
  const rows = data ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        {type === undefined && (
          <Field label="Type" htmlFor="f-type"><Select id="f-type" value={t} onChange={(e) => setT(e.target.value as SaleType | '')} className="w-44">
            <option value="">All transactions</option><option value="invoice">Invoices</option><option value="sales_receipt">Sales receipts</option><option value="credit_note">Credit notes</option><option value="payment">Payments</option>
          </Select></Field>
        )}
        <Field label="Status" htmlFor="f-status"><Select id="f-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="w-40">
          <option value="">All statuses</option><option value="open">Open</option><option value="overdue">Overdue</option><option value="paid">Paid / closed</option>
        </Select></Field>
        <span className="ml-auto text-sm text-muted-foreground">{rows.length} transaction{rows.length === 1 ? '' : 's'}</span>
      </div>
      <FormError message={error ? errorMessage(error) : null} />
      <div className="overflow-x-auto rounded-md border bg-card shadow-sm">
        <table className="w-full min-w-[60rem] text-sm">
          <thead className="border-b bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>{['Date', 'Type', 'No.', 'Customer', 'Due date', 'Balance', 'Total', 'Status', 'Action'].map((h, i) => <th key={h} className={cn('px-3 py-2.5 font-semibold', (i === 5 || i === 6) && 'text-right', i === 8 && 'text-right')}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {data && rows.length === 0 && <tr><td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">No sales transactions match these filters.</td></tr>}
            {rows.map((r) => {
              const href = docHref(companyId, r);
              const pdf = pdfHref(companyId, r);
              return (
                <tr key={`${r.type}-${r.id}`} className={cn('border-b last:border-0', href && 'cursor-pointer hover:bg-accent/50')} onClick={() => href && router.push(href)}>
                  <td className="whitespace-nowrap px-3 py-2.5">{r.date}</td>
                  <td className="px-3 py-2.5">{TYPE_LABEL[r.type]}</td>
                  <td className="px-3 py-2.5 font-mono text-xs">{r.number ?? '—'}</td>
                  <td className="px-3 py-2.5">{r.customer}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">{r.dueDate ?? ''}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{r.type === 'invoice' ? fmtMoney(r.balance) : ''}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{r.type === 'credit_note' ? fmtMoney(`-${r.total}`) : fmtMoney(r.total)}</td>
                  <td className="px-3 py-2.5"><StatusPill row={r} /></td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="inline-flex items-center gap-2">
                      {r.type === 'invoice' && (r.state === 'open' || r.state === 'overdue') && can('sales:post')
                        ? <Button size="sm" variant="ghost" className="text-primary" onClick={() => setPay(r)}>Receive payment</Button>
                        : r.state === 'draft' && href ? <Link href={href} className="text-xs font-medium text-primary hover:underline">Edit</Link>
                        : pdf ? <a href={pdf} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"><Printer className="h-3.5 w-3.5" aria-hidden />Print</a> : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pay && <ReceivePayment row={pay} onClose={(done) => { setPay(null); if (done) { void reload(); onChange?.(); } }} />}
    </div>
  );
}

/** Receive a payment against one invoice (bank or cash account, date, amount). */
export function ReceivePayment({ row, onClose }: { row: Pick<SaleRow, 'id' | 'contactId' | 'number' | 'customer' | 'balance'>; onClose: (done: boolean) => void }) {
  const { companyId } = useCompany();
  const { data: accounts } = useApi<Account[]>(`/companies/${companyId}/accounts`);
  const deposit = (accounts ?? []).filter((a) => a.type === 'ASSET' && !a.role);
  const [f, setF] = useState({ bankAccountId: '', amount: row.balance, date: today(), reference: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setErr(null); setBusy(true);
    try {
      await api(`/companies/${companyId}/payments`, { method: 'POST', body: { direction: 'RECEIPT', contactId: row.contactId, bankAccountId: f.bankAccountId || deposit[0]?.id, date: f.date, amount: f.amount, reference: f.reference || undefined, allocations: [{ documentId: row.id, amount: f.amount }] } });
      onClose(true);
    } catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  }
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose(false)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col bg-card shadow-2xl" aria-describedby={undefined}>
          <div className="flex items-center border-b px-5 py-4">
            <Dialog.Title className="text-lg font-semibold">Receive payment</Dialog.Title>
            <Dialog.Close className="ml-auto rounded p-1 hover:bg-accent" aria-label="Close"><X className="h-5 w-5" /></Dialog.Close>
          </div>
          <form className="flex-1 space-y-4 overflow-y-auto p-5" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <p className="text-sm">{row.customer} · invoice <span className="font-mono">{row.number}</span> · open balance <strong>{fmtMoney(row.balance)}</strong></p>
            <FormError message={err} />
            <Field label="Payment date" htmlFor="rp-date"><Input id="rp-date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
            <Field label="Deposit to" htmlFor="rp-dep"><Select id="rp-dep" value={f.bankAccountId || deposit[0]?.id || ''} onChange={(e) => setF({ ...f, bankAccountId: e.target.value })}>{deposit.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
            <Field label="Amount received" htmlFor="rp-amt"><Input id="rp-amt" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            <Field label="Reference no." htmlFor="rp-ref"><Input id="rp-ref" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
          </form>
          <div className="flex justify-end gap-2 border-t bg-muted/50 px-5 py-3">
            <Button variant="outline" onClick={() => onClose(false)}>Cancel</Button>
            <Button disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save and close'}</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A right-hand side panel, used for customers and products. */
export function SidePanel({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-full max-w-lg flex-col bg-card shadow-2xl" aria-describedby={undefined}>
          <div className="flex items-center border-b px-5 py-4">
            <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
            <Dialog.Close className="ml-auto rounded p-1 hover:bg-accent" aria-label="Close"><X className="h-5 w-5" /></Dialog.Close>
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto p-5">{children}</div>
          <div className="flex justify-end gap-2 border-t bg-muted/50 px-5 py-3">{footer}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
