import { z } from 'zod';

const isRealDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** ISO calendar date, validated (rejects 2026-02-31). */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(isRealDate, 'Not a real date');
/** Money / quantity as a decimal string. Never a JSON number, so no float ever touches an amount. */
export const amountString = z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Use a positive decimal like 12.50');
export const uuid = z.string().uuid();

export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const;

export const createAccountSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  type: z.enum(ACCOUNT_TYPES),
  parentId: uuid.optional(),
  description: z.string().max(500).optional(),
});
export const updateAccountSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
  parentId: uuid.nullable().optional(),
});

export const journalLineInput = z.object({
  accountId: uuid,
  debit: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/).default('0'),
  credit: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/).default('0'),
  memo: z.string().max(300).optional(),
  contactId: uuid.optional(),
});
export const createJournalSchema = z.object({
  date: isoDate,
  memo: z.string().max(500).optional(),
  lines: z.array(journalLineInput).min(2).max(500),
  /** true = post immediately (needs journal:post); false = save as draft */
  post: z.boolean().default(false),
});
export const reverseJournalSchema = z.object({ date: isoDate.optional(), memo: z.string().max(500).optional() });

export const createContactSchema = z.object({
  kind: z.enum(['CUSTOMER', 'VENDOR', 'BOTH']),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().optional(),
  province: z.string().length(2).toUpperCase().optional(),
  taxNumber: z.string().max(40).optional(),
});

export const taxRateSchema = z.object({
  component: z.enum(['GST', 'HST', 'QST', 'PST']),
  rate: z.string().regex(/^0\.\d{1,6}$/, 'Fraction like 0.13 for 13%'),
  recoverable: z.boolean(),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable().optional(),
  source: z.string().max(300).optional(),
});

const docLine = z.object({
  description: z.string().trim().min(1).max(300),
  quantity: amountString,
  unitPrice: amountString,
  accountId: uuid,
  taxCodeId: uuid,
});
const docBase = {
  contactId: uuid,
  issueDate: isoDate,
  dueDate: isoDate,
  taxInclusive: z.boolean().default(false),
  kind: z.enum(['STANDARD', 'CREDIT']).default('STANDARD'),
  lines: z.array(docLine).min(1).max(200),
};
export const createInvoiceSchema = z.object(docBase);
export const createBillSchema = z.object({ ...docBase, supplierRef: z.string().max(60).optional() });

export const createPaymentSchema = z.object({
  direction: z.enum(['RECEIPT', 'DISBURSEMENT']),
  contactId: uuid,
  bankAccountId: uuid,
  date: isoDate,
  amount: amountString,
  reference: z.string().max(100).optional(),
  allocations: z
    .array(z.object({ documentId: uuid, amount: amountString }))
    .min(1)
    .max(100),
});

export const createExpenseSchema = z.object({
  date: isoDate,
  description: z.string().trim().min(1).max(300),
  contactId: uuid.optional(),
  paidFromAccountId: uuid,
  taxInclusive: z.boolean().default(true),
  lines: z
    .array(z.object({ description: z.string().trim().min(1).max(300), amount: amountString, accountId: uuid, taxCodeId: uuid }))
    .min(1)
    .max(50),
});
export const decideExpenseSchema = z.object({ note: z.string().max(300).optional() });

export const createFiscalYearSchema = z.object({ startDate: isoDate.optional() });
export const lockPeriodSchema = z.object({ locked: z.boolean() });
