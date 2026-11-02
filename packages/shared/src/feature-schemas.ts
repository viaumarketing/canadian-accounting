import { z } from 'zod';
import { amountString, createBillSchema, createExpenseSchema, createInvoiceSchema, documentLineSchema, isoDate, uuid } from './accounting-schemas';
import { emailSchema, passwordSchema, CANADIAN_PROVINCES } from './schemas';

/** A signed decimal (adjustments, deposit fee lines, budgets). */
export const signedAmount = z.string().regex(/^-?\d{1,13}(\.\d{1,4})?$/, 'Use a decimal like -12.50');

// ================================================================ 1. e-mail and branding

export const EMAIL_KINDS = ['invoice', 'sales_receipt', 'estimate', 'statement', 'reminder', 'purchase_order'] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

/** Placeholders available in e-mail subjects and bodies. */
export const EMAIL_PLACEHOLDERS = ['{{customer}}', '{{company}}', '{{number}}', '{{total}}', '{{balance}}', '{{dueDate}}', '{{link}}'] as const;

export const documentTemplateSchema = z.object({
  /** Accent colour for titles and table headers */
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #2f8a2b').optional(),
  /** modern (sans-serif, coloured title), classic (serif, ruled), compact (smaller type, tighter rows) */
  layout: z.enum(['modern', 'classic', 'compact']).optional(),
  showLogo: z.boolean().optional(),
  showServiceDate: z.boolean().optional(),
  showTaxColumn: z.boolean().optional(),
  /** Printed at the bottom of every page */
  footer: z.string().trim().max(1000).optional(),
  /** Printed under the totals on invoices, e.g. Interac e-Transfer or cheque instructions */
  paymentInstructions: z.string().trim().max(1000).optional(),
  emails: z.partialRecord(z.enum(EMAIL_KINDS), z.object({ subject: z.string().trim().max(200), body: z.string().max(4000) })).optional(),
});
export type DocumentTemplate = z.infer<typeof documentTemplateSchema>;

export const brandingSchema = z.object({
  template: documentTemplateSchema.optional(),
  emailFromName: z.string().trim().max(100).nullable().optional(),
  emailReplyTo: emailSchema.nullable().optional(),
});

export const sendDocumentSchema = z.object({
  to: z.array(emailSchema).min(1).max(20),
  cc: z.array(emailSchema).max(10).optional(),
  subject: z.string().trim().max(250).optional(),
  body: z.string().max(8000).optional(),
});

// ================================================================ 2. estimates, recurring, statements, reminders

export const estimateSchema = createInvoiceSchema.omit({ dueDate: true, kind: true, terms: true }).extend({ expiryDate: isoDate.optional() });
export const estimateDecisionSchema = z.object({ status: z.enum(['ACCEPTED', 'DECLINED']), acceptedBy: z.string().trim().max(120).optional() });

export const RECURRING_KINDS = ['INVOICE', 'BILL', 'EXPENSE'] as const;
export const RECURRING_INTERVALS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
/** What the schedule copies each time: the document without its dates (they come from the run date). */
export const recurringPayloads = {
  INVOICE: createInvoiceSchema.omit({ issueDate: true, dueDate: true }),
  BILL: createBillSchema.omit({ issueDate: true, dueDate: true }),
  EXPENSE: createExpenseSchema.omit({ date: true }),
} as const;
export const recurringSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(RECURRING_KINDS),
  /** DRAFT = create only; POST = create and post (expenses are created as submitted, waiting for approval); SEND = invoices: post and e-mail */
  mode: z.enum(['DRAFT', 'POST', 'SEND']).default('DRAFT'),
  interval: z.enum(RECURRING_INTERVALS),
  every: z.number().int().min(1).max(365).default(1),
  startDate: isoDate,
  endDate: isoDate.optional(),
  maxRuns: z.number().int().min(1).max(10000).optional(),
  daysDue: z.number().int().min(0).max(365).default(30),
  /** Invoices sent automatically go to these addresses (default: the customer's e-mail) */
  sendTo: z.array(emailSchema).max(10).optional(),
  payload: z.record(z.string(), z.unknown()),
  isActive: z.boolean().default(true),
});

export const statementQuery = z.object({
  contactId: uuid,
  from: isoDate,
  to: isoDate,
  /** balance_forward: opening balance then every transaction; open_item: only invoices still open at the end date */
  type: z.enum(['balance_forward', 'open_item']).default('balance_forward'),
});
export const sendStatementSchema = statementQuery.extend({ recipients: z.array(emailSchema).min(1).max(20).optional(), subject: z.string().trim().max(250).optional(), body: z.string().max(8000).optional() });

export const reminderSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Days after the due date at which a reminder is sent, e.g. [1, 7, 30] */
  stages: z.array(z.number().int().min(0).max(365)).max(5).default([1, 7, 30]),
  subject: z.string().trim().max(200).optional(),
  body: z.string().max(4000).optional(),
});
export const lateFeeSettingsSchema = z.object({
  enabled: z.boolean(),
  type: z.enum(['FLAT', 'PERCENT']).default('FLAT'),
  /** FLAT: dollars; PERCENT: percent of the overdue balance (e.g. 2 = 2 %) */
  amount: amountString,
  /** Days after the due date before the fee is charged (once per invoice) */
  graceDays: z.number().int().min(0).max(365).default(30),
  accountId: uuid,
  taxCodeId: uuid,
});

// ================================================================ 3. card payments, Undeposited Funds, deposits

export const stripeConnectSchema = z.object({
  /** Secret or restricted key from the company's own Stripe dashboard */
  secretKey: z.string().trim().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/, 'Paste a Stripe secret key (sk_test_… or sk_live_…)'),
  /** Signing secret of the webhook endpoint created in Stripe for this company */
  webhookSecret: z.string().trim().regex(/^whsec_[A-Za-z0-9]{10,}$/, 'Paste the endpoint signing secret (whsec_…)').optional(),
});
export const depositSchema = z.object({
  date: isoDate,
  bankAccountId: uuid,
  memo: z.string().trim().max(300).optional(),
  items: z.array(z.object({ type: z.enum(['payment', 'sales_receipt']), id: uuid })).max(500).default([]),
  /** Other lines: positive adds to the deposit (cash back excluded), negative is a fee or charge taken out */
  otherLines: z.array(z.object({ accountId: uuid, amount: signedAmount, description: z.string().trim().max(300).optional(), contactId: uuid.optional() })).max(50).default([]),
});

// ================================================================ 4. inventory

export const inventoryAdjustmentSchema = z.object({
  date: isoDate,
  itemId: uuid,
  /** Change in quantity (negative = shrinkage, damage) */
  quantityChange: signedAmount,
  /** Change in value; omitted = quantity × current average cost. For an opening balance, the total cost of the stock. */
  valueChange: signedAmount.optional(),
  /** Offsetting account, e.g. Inventory shrinkage (expense) or Opening balance equity */
  accountId: uuid,
  memo: z.string().trim().max(300).optional(),
});

// ================================================================ 5. purchase orders and credits

export const purchaseOrderSchema = z.object({
  contactId: uuid,
  issueDate: isoDate,
  expectedDate: isoDate.optional(),
  taxInclusive: z.boolean().default(false),
  lines: z.array(documentLineSchema).min(1).max(200),
  shipTo: z.string().trim().max(500).optional(),
  message: z.string().trim().max(1000).optional(),
  memo: z.string().trim().max(1000).optional(),
});
export const applyCreditSchema = z.object({ creditId: uuid, amount: amountString, date: isoDate.optional() });
export const payBillsSchema = z.object({
  bankAccountId: uuid,
  date: isoDate,
  reference: z.string().max(100).optional(),
  /** One payment per supplier is created from these lines */
  bills: z.array(z.object({ billId: uuid, amount: amountString })).min(1).max(200),
});

// ================================================================ 6. projects and time

export const projectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  customerId: uuid,
  status: z.enum(['ACTIVE', 'COMPLETED', 'CANCELLED']).default('ACTIVE'),
  description: z.string().trim().max(1000).optional(),
  budget: amountString.optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
});
export const timeEntrySchema = z.object({
  date: isoDate,
  hours: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, 'Hours like 1.5').refine((v) => Number(v) > 0 && Number(v) <= 24, 'Between 0 and 24 hours'),
  customerId: uuid.optional(),
  projectId: uuid.optional(),
  itemId: uuid.optional(),
  description: z.string().trim().max(500).optional(),
  billable: z.boolean().default(false),
  rate: amountString.optional(),
  /** Someone else's time (needs sales:approve); default = you */
  userId: uuid.optional(),
});

// ================================================================ 7. tracking and budgets

export const trackingNameSchema = z.object({ name: z.string().trim().min(1).max(80), isActive: z.boolean().optional() });
export const budgetSchema = z.object({
  name: z.string().trim().min(1).max(120),
  fiscalYearId: uuid,
  lines: z.array(z.object({ accountId: uuid, month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM'), amount: signedAmount })).max(5000),
});

// ================================================================ 8. SaaS edition

export const PLAN_IDS = ['starter', 'essentials', 'plus'] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export const signupSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  password: passwordSchema,
  organizationName: z.string().trim().min(1).max(160),
  companyName: z.string().trim().min(1).max(200),
  province: z.enum(CANADIAN_PROVINCES),
  plan: z.enum(PLAN_IDS).default('essentials'),
});
export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) });
export const resendVerificationSchema = z.object({ email: emailSchema });
export const checkoutPlanSchema = z.object({ plan: z.enum(PLAN_IDS) });
