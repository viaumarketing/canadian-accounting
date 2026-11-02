import { Prisma, AccountRole, AccountType } from '@ca/database';
import { SEED_TAX_CODES } from '@ca/canadian-tax';
import { currentFiscalYear } from '../companies/fiscal-year';
import { ensureSpecialAccount } from './special-accounts';

interface TemplateAccount { code: string; name: string; type: AccountType; role?: AccountRole; cashFlow?: 'INVESTING' | 'FINANCING' }

/** Canadian small-business starter chart of accounts. A template, not a standard: edit freely. */
export const COA_TEMPLATE: TemplateAccount[] = [
  { code: '1010', name: 'Chequing Account', type: 'ASSET' },
  { code: '1020', name: 'Savings Account', type: 'ASSET' },
  { code: '1030', name: 'Shopify Payments Clearing', type: 'ASSET' },
  { code: '1035', name: 'Shopify Payments Reserve', type: 'ASSET' },
  { code: '1036', name: 'Disputed Funds Held', type: 'ASSET' },
  { code: '1040', name: 'Third-party Gateway Clearing', type: 'ASSET' },
  { code: '1100', name: 'Accounts Receivable', type: 'ASSET', role: 'ACCOUNTS_RECEIVABLE' },
  { code: '1150', name: 'GST/HST Receivable (ITC)', type: 'ASSET', role: 'GST_HST_RECEIVABLE' },
  { code: '1160', name: 'QST Receivable (ITR)', type: 'ASSET', role: 'QST_RECEIVABLE' },
  { code: '1200', name: 'Inventory', type: 'ASSET' },
  { code: '1300', name: 'Prepaid Expenses', type: 'ASSET' },
  { code: '1500', name: 'Equipment', type: 'ASSET', cashFlow: 'INVESTING' },
  { code: '1510', name: 'Accumulated Amortization – Equipment', type: 'ASSET', cashFlow: 'INVESTING' },
  { code: '2000', name: 'Accounts Payable', type: 'LIABILITY', role: 'ACCOUNTS_PAYABLE' },
  { code: '2100', name: 'Credit Card Payable', type: 'LIABILITY' },
  { code: '2200', name: 'GST/HST Payable', type: 'LIABILITY', role: 'GST_HST_PAYABLE' },
  { code: '2210', name: 'QST Payable', type: 'LIABILITY', role: 'QST_PAYABLE' },
  { code: '2220', name: 'PST Payable', type: 'LIABILITY', role: 'PST_PAYABLE' },
  { code: '2300', name: 'Payroll Liabilities', type: 'LIABILITY' },
  { code: '2400', name: 'Employee Expense Reimbursements Payable', type: 'LIABILITY' },
  { code: '2510', name: 'Gift Card Liability', type: 'LIABILITY' },
  { code: '2500', name: 'Shareholder Loan', type: 'LIABILITY', cashFlow: 'FINANCING' },
  { code: '3000', name: 'Share Capital', type: 'EQUITY' },
  { code: '3100', name: 'Retained Earnings', type: 'EQUITY', role: 'RETAINED_EARNINGS' },
  { code: '3200', name: 'Dividends', type: 'EQUITY' },
  { code: '4000', name: 'Sales Revenue', type: 'REVENUE' },
  { code: '4100', name: 'Shipping Revenue', type: 'REVENUE' },
  { code: '4800', name: 'Sales Returns and Allowances', type: 'REVENUE' },
  { code: '4900', name: 'Other Income', type: 'REVENUE' },
  { code: '5000', name: 'Cost of Goods Sold', type: 'EXPENSE' },
  { code: '5100', name: 'Freight In', type: 'EXPENSE' },
  { code: '6010', name: 'Advertising and Promotion', type: 'EXPENSE' },
  { code: '6020', name: 'Bank Charges', type: 'EXPENSE' },
  { code: '6030', name: 'Insurance', type: 'EXPENSE' },
  { code: '6040', name: 'Interest Expense', type: 'EXPENSE' },
  { code: '6050', name: 'Office Supplies', type: 'EXPENSE' },
  { code: '6060', name: 'Professional Fees', type: 'EXPENSE' },
  { code: '6070', name: 'Rent', type: 'EXPENSE' },
  { code: '6080', name: 'Software and Subscriptions', type: 'EXPENSE' },
  { code: '6090', name: 'Telephone and Internet', type: 'EXPENSE' },
  { code: '6100', name: 'Travel', type: 'EXPENSE' },
  { code: '6110', name: 'Meals and Entertainment', type: 'EXPENSE' },
  { code: '6120', name: 'Payment Processing Fees', type: 'EXPENSE' },
  { code: '6125', name: 'Chargeback and Dispute Fees', type: 'EXPENSE' },
  { code: '6130', name: 'Utilities', type: 'EXPENSE' },
  { code: '6140', name: 'Wages and Salaries', type: 'EXPENSE' },
  { code: '6150', name: 'Amortization Expense', type: 'EXPENSE' },
  { code: '6160', name: 'Vehicle Expenses', type: 'EXPENSE' },
  { code: '6165', name: 'Shipping Label Expenses', type: 'EXPENSE' },
];

const DAY = 86_400_000;
export const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
export const isoOf = (d: Date) => d.toISOString().slice(0, 10);

/** Monthly periods for every fiscal year that has none yet. Idempotent. */
export async function ensurePeriods(tx: Prisma.TransactionClient, companyId: string) {
  const years = await tx.fiscalYear.findMany({ where: { companyId, periods: { none: {} } } });
  for (const fy of years) {
    const rows: Prisma.AccountingPeriodCreateManyInput[] = [];
    let start = fy.startDate;
    while (start <= fy.endDate) {
      const monthEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
      const end = monthEnd < fy.endDate ? monthEnd : fy.endDate;
      rows.push({ companyId, fiscalYearId: fy.id, label: isoOf(start).slice(0, 7), startDate: start, endDate: end });
      start = new Date(end.getTime() + DAY);
    }
    await tx.accountingPeriod.createMany({ data: rows, skipDuplicates: true });
  }
}

/** Create the fiscal year that contains `startDate` (default: the day after the latest year ends). */
export async function createNextFiscalYear(tx: Prisma.TransactionClient, companyId: string, startDate?: Date) {
  const company = await tx.company.findUniqueOrThrow({ where: { id: companyId } });
  const latest = await tx.fiscalYear.findFirst({ where: { companyId }, orderBy: { endDate: 'desc' } });
  const anchor = startDate ?? (latest ? new Date(latest.endDate.getTime() + DAY) : new Date());
  const fy = currentFiscalYear(anchor, company.fiscalYearEndMonth, company.fiscalYearEndDay);
  const created = await tx.fiscalYear.create({ data: { companyId, ...fy } });
  await ensurePeriods(tx, companyId);
  return created;
}

/** Idempotent: chart of accounts, tax codes + rates, accounting periods. Existing rows are left untouched. */
export async function seedAccounting(tx: Prisma.TransactionClient, companyId: string) {
  await tx.account.createMany({ data: COA_TEMPLATE.map((a) => ({ ...a, companyId })), skipDuplicates: true });
  for (const c of SEED_TAX_CODES) {
    const code = await tx.taxCode.upsert({
      where: { companyId_code: { companyId, code: c.code } },
      update: {},
      create: { companyId, code: c.code, name: c.name, kind: c.kind },
    });
    await tx.taxRate.createMany({
      data: c.rates.map((r) => ({
        companyId,
        taxCodeId: code.id,
        component: r.component,
        rate: r.rate,
        recoverable: r.recoverable,
        effectiveFrom: toDate(r.effectiveFrom),
        effectiveTo: r.effectiveTo ? toDate(r.effectiveTo) : null,
        source: r.source + (r.verify ? ' [UNVERIFIED seed – confirm before relying on it]' : ''),
      })),
      skipDuplicates: true,
    });
  }
  await ensureSpecialAccount(tx, companyId, 'UNDEPOSITED_FUNDS');
  await ensurePeriods(tx, companyId);
}
