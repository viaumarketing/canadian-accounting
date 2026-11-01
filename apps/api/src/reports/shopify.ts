import Decimal from 'decimal.js';
import { col, row, type Report, type Row } from '@ca/reporting';
import { D, Ctx, loadAccounts, m2, newReport, pct } from './common';
import { isoOf, toDate } from '../accounting/setup';

type AccountMap = Partial<Record<string, string>>;

/** Sales summary per store, computed from the JOURNAL LINES of the entries each Shopify order/refund produced. */
export async function shopifySales(c: Ctx, p: { from: string; to: string }): Promise<Report> {
  const stores = await c.prisma.shopifyStore.findMany({ where: { companyId: c.companyId } });
  const accts = await loadAccounts(c);
  const roleOf = new Map(accts.filter((a) => a.role).map((a) => [a.id, a.role!]));
  type R = { storeId: string; st: string; accountId: string; d: string; cr: string; n: string };
  const rows = await c.prisma.$queryRaw<R[]>`
    SELECT COALESCE(so."storeId", sr."storeId")::text AS "storeId", e."sourceType" AS st, l."accountId"::text AS "accountId",
           SUM(l."debit")::text AS d, SUM(l."credit")::text AS cr, COUNT(DISTINCT e."id")::text AS n
    FROM "JournalEntry" e JOIN "JournalLine" l ON l."entryId" = e."id"
    LEFT JOIN "ShopifyOrder" so ON so."journalEntryId" = e."id" LEFT JOIN "ShopifyRefund" sr ON sr."journalEntryId" = e."id"
    WHERE e."companyId" = ${c.companyId}::uuid AND e."status" = 'POSTED' AND e."sourceType" IN ('shopify_order', 'shopify_refund')
      AND e."date" BETWEEN ${toDate(p.from)} AND ${toDate(p.to)} AND COALESCE(so."storeId", sr."storeId") IS NOT NULL
    GROUP BY 1, 2, 3`;
  const r = newReport(c, 'shopify-sales', 'Shopify Sales Summary', `${p.from} to ${p.to} · from posted journal entries`);
  const out: Row[] = [];
  const tot = { orders: 0, sales: D(0), ship: D(0), gift: D(0), tax: D(0), refunds: D(0), refundTax: D(0) };
  for (const s of stores) {
    const map = s.accountMap as AccountMap;
    const mine = rows.filter((x) => x.storeId === s.id);
    const sumBy = (st: string, pred: (id: string) => boolean, side: 'cr' | 'd') => mine.filter((x) => x.st === st && pred(x.accountId)).reduce((a, x) => a.plus(x[side]), D(0));
    const isTax = (id: string) => ['GST_HST_PAYABLE', 'QST_PAYABLE', 'PST_PAYABLE'].includes(roleOf.get(id) ?? '');
    const orders = mine.filter((x) => x.st === 'shopify_order').reduce((a, x) => Math.max(a, Number(x.n)), 0);
    const v = {
      orders, sales: sumBy('shopify_order', (id) => id === map.sales, 'cr'), ship: sumBy('shopify_order', (id) => id === map.shipping, 'cr'), gift: sumBy('shopify_order', (id) => id === map.giftCard, 'cr'),
      tax: sumBy('shopify_order', isTax, 'cr'), refunds: sumBy('shopify_refund', (id) => id === map.refunds, 'd'), refundTax: sumBy('shopify_refund', isTax, 'd'),
    };
    if (!orders && v.refunds.isZero()) continue;
    tot.orders += orders; for (const k of ['sales', 'ship', 'gift', 'tax', 'refunds', 'refundTax'] as const) tot[k] = tot[k].plus(v[k]);
    const netSales = v.sales.plus(v.ship).minus(v.refunds);
    out.push(row({ store: s.shopDomain, orders, sales: m2(v.sales), ship: m2(v.ship), gift: m2(v.gift), tax: m2(v.tax), refunds: m2(v.refunds), refundTax: m2(v.refundTax), net: m2(netSales) }));
  }
  const cols = [col('store', 'Store'), col('orders', 'Orders', 'int'), col('sales', 'Product sales', 'money'), col('ship', 'Shipping', 'money'), col('gift', 'Gift cards sold', 'money'), col('tax', 'Tax collected', 'money'), col('refunds', 'Refunds (net of tax)', 'money'), col('refundTax', 'Refunded tax', 'money'), col('net', 'Net sales', 'money')];
  r.sections.push({ columns: cols, rows: out, totals: [row({ store: 'Total', orders: tot.orders, sales: m2(tot.sales), ship: m2(tot.ship), gift: m2(tot.gift), tax: m2(tot.tax), refunds: m2(tot.refunds), refundTax: m2(tot.refundTax), net: m2(tot.sales.plus(tot.ship).minus(tot.refunds)) }, { bold: true })] });
  const pending = await c.prisma.shopifyOrder.count({ where: { companyId: c.companyId, processedAt: { gte: toDate(p.from), lte: new Date(`${p.to}T23:59:59Z`) }, postingStatus: { in: ['PENDING', 'NEEDS_REVIEW'] } } });
  r.checks.push({ label: 'All imported orders in the period are posted to the books', ok: pending === 0, detail: pending ? `${pending} order(s) are waiting or need review and are NOT in these figures` : undefined });
  r.notes.push('Figures come from the journal lines of posted Shopify entries. Discounts are netted into product sales (the order total is what the customer paid). Test and cancelled orders are not posted.');
  return r;
}

/** Processing fees by month from Shopify Payments balance transactions, tied to the fee journals. */
export async function shopifyFees(c: Ctx, p: { from: string; to: string }): Promise<Report> {
  const range = { gte: toDate(p.from), lte: new Date(`${p.to}T23:59:59Z`) };
  const bts = await c.prisma.shopifyBalanceTransaction.findMany({ where: { companyId: c.companyId, test: false, transactionDate: range }, select: { type: true, amount: true, fee: true, transactionDate: true, feeJournalId: true } });
  const feeTax = await c.prisma.shopifyTransaction.aggregate({ where: { companyId: c.companyId, test: false, processedAt: range }, _sum: { feeTax: true } });
  const byMonth = new Map<string, { gross: Decimal; fees: Decimal; refundFees: Decimal }>();
  let unposted = D(0), unpostedCount = 0;
  for (const b of bts) {
    const k = isoOf(b.transactionDate).slice(0, 7);
    const e = byMonth.get(k) ?? { gross: D(0), fees: D(0), refundFees: D(0) };
    if (b.type === 'CHARGE') e.gross = e.gross.plus(b.amount.toString());
    if (b.type === 'REFUND') e.refundFees = e.refundFees.plus(b.fee.toString()); else e.fees = e.fees.plus(b.fee.toString());
    byMonth.set(k, e);
    if (!D(b.fee.toString()).isZero()) { if (!b.feeJournalId) { unposted = unposted.plus(b.fee.toString()); unpostedCount++; } }
  }
  const r = newReport(c, 'shopify-fees', 'Shopify Processing Fees', `${p.from} to ${p.to}`);
  const rows = [...byMonth].sort().map(([k, v]) => row({ month: k, gross: m2(v.gross), fees: m2(v.fees), refundFees: m2(v.refundFees), rate: pct(v.fees, v.gross) }));
  const T = [...byMonth.values()].reduce((a, v) => ({ gross: a.gross.plus(v.gross), fees: a.fees.plus(v.fees), rf: a.rf.plus(v.refundFees) }), { gross: D(0), fees: D(0), rf: D(0) });
  r.sections.push({ columns: [col('month', 'Month'), col('gross', 'Charges (gross)', 'money'), col('fees', 'Fees on charges and others', 'money'), col('refundFees', 'Fees on refunds', 'money'), col('rate', 'Fee % of charges', 'pct')], rows, totals: [row({ month: 'Total', gross: m2(T.gross), fees: m2(T.fees), refundFees: m2(T.rf), rate: pct(T.fees, T.gross) }, { bold: true })] });
  // Tie-out: the fee journals posted in this period (by entry date) must equal the fees of the balance transactions they came from.
  const feeEntries = await c.prisma.journalEntry.findMany({ where: { companyId: c.companyId, status: 'POSTED', sourceType: 'shopify_bt_fee', date: { gte: toDate(p.from), lte: toDate(p.to) } }, select: { id: true } });
  const entryIds = feeEntries.map((e) => e.id);
  const stores = await c.prisma.shopifyStore.findMany({ where: { companyId: c.companyId }, select: { accountMap: true } });
  const feeIds = [...new Set(stores.map((s) => (s.accountMap as AccountMap).fees).filter((x): x is string => !!x))];
  let ledgerFees = D(0), sourceFees = D(0);
  if (entryIds.length && feeIds.length) {
    const a = await c.prisma.journalLine.aggregate({ where: { companyId: c.companyId, entryId: { in: entryIds }, accountId: { in: feeIds } }, _sum: { debit: true, credit: true } });
    ledgerFees = D(a._sum.debit ?? 0).minus(a._sum.credit ?? 0);
    const src = await c.prisma.shopifyBalanceTransaction.aggregate({ where: { companyId: c.companyId, feeJournalId: { in: entryIds } }, _sum: { fee: true } });
    sourceFees = D(src._sum.fee ?? 0);
  }
  r.sections.push({ title: 'Tax on fees (information only)', columns: [col('name', 'Item'), col('amount', 'Amount', 'money')], rows: [row({ name: 'GST/QST charged by Shopify on fees (from order transactions)', amount: m2(D(feeTax._sum.feeTax ?? 0)) })] });
  r.checks.push({ label: 'Fee journals in the ledger equal the fees of the balance transactions they came from', ok: ledgerFees.eq(sourceFees), detail: ledgerFees.eq(sourceFees) ? undefined : `ledger ${m2(ledgerFees)} vs source ${m2(sourceFees)}` });
  r.checks.push({ label: 'Every fee in the period has been posted', ok: unpostedCount === 0, detail: unpostedCount ? `${unpostedCount} fee(s) totalling ${m2(unposted)} are not posted yet (see Shopify → Needs review)` : undefined });
  r.notes.push('Fees are booked gross to Processing Fees; tax on fees is not separated into input tax credits in this version, so the tax amount above is informational.');
  return r;
}

/** Every payout in the range with its components and tie-out to the balance transactions. */
export async function shopifyPayouts(c: Ctx, p: { from: string; to: string }): Promise<Report> {
  const payouts = await c.prisma.shopifyPayout.findMany({ where: { companyId: c.companyId, issuedAt: { gte: toDate(p.from), lte: new Date(`${p.to}T23:59:59Z`) } }, orderBy: { issuedAt: 'asc' }, include: { store: { select: { shopDomain: true } } } });
  const bts = payouts.length ? await c.prisma.shopifyBalanceTransaction.findMany({ where: { companyId: c.companyId, test: false, payoutShopifyId: { in: payouts.map((x) => x.shopifyId) } } }) : [];
  const r = newReport(c, 'shopify-payouts', 'Shopify Payout Reconciliation', `${p.from} to ${p.to}`);
  const rows: Row[] = [];
  let bad = 0;
  const T = { charges: D(0), fees: D(0), refunds: D(0), other: D(0), net: D(0) };
  for (const x of payouts) {
    const mine = bts.filter((b) => b.payoutShopifyId === x.shopifyId && b.type !== 'TRANSFER');
    const sum = (f: (t: string) => boolean, k: 'amount' | 'fee' | 'net') => mine.filter((b) => f(b.type)).reduce((a, b) => a.plus(b[k].toString()), D(0));
    const charges = sum((t) => t === 'CHARGE', 'amount'), refunds = sum((t) => t === 'REFUND', 'amount'), fees = mine.reduce((a, b) => a.plus(b.fee.toString()), D(0));
    const other = sum((t) => t !== 'CHARGE' && t !== 'REFUND', 'amount');
    const comp = mine.reduce((a, b) => a.plus(b.net.toString()), D(0));
    const diff = comp.minus(x.net.toString());
    const ties = x.direction === 'DEPOSIT' ? diff.isZero() : true;
    if (!ties) bad++;
    T.charges = T.charges.plus(charges); T.fees = T.fees.plus(fees); T.refunds = T.refunds.plus(refunds); T.other = T.other.plus(other); T.net = T.net.plus(x.net.toString());
    rows.push(row({ date: isoOf(x.issuedAt), id: x.shopifyId.split('/').pop() ?? '', store: x.store.shopDomain, status: x.status.toLowerCase(), charges: m2(charges), refunds: m2(refunds), other: m2(other), fees: m2(fees), net: m2(D(x.net.toString())), diff: m2(diff), books: x.postingStatus.replace('_', ' ').toLowerCase() }));
  }
  r.sections.push({ columns: [col('date', 'Issued', 'date'), col('id', 'Payout'), col('store', 'Store'), col('status', 'Status'), col('charges', 'Charges', 'money'), col('refunds', 'Refunds', 'money'), col('other', 'Adjustments & reserves', 'money'), col('fees', 'Fees', 'money'), col('net', 'Payout net', 'money'), col('diff', 'Difference', 'money'), col('books', 'In books')], rows, totals: [row({ id: 'Total', charges: m2(T.charges), refunds: m2(T.refunds), other: m2(T.other), fees: m2(T.fees), net: m2(T.net) }, { bold: true })] });
  r.checks.push({ label: 'Every deposit equals the net of its balance transactions', ok: bad === 0, detail: bad ? `${bad} payout(s) do not tie out: see the Difference column` : undefined });
  r.notes.push('Matching each payout to its bank deposit is done on the Banking → Transactions screen; a posted payout shows as a ledger line on the bank account that the deposit can be matched to.');
  return r;
}
