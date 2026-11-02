-- ca:compat additive (new tables, nullable or defaulted columns; no new enum values on existing types, so older builds keep reading every table)

-- CreateEnum
CREATE TYPE "EstimateStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CLOSED', 'VOID');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('OPEN', 'CLOSED', 'VOID');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "special" TEXT;

-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "locationId" UUID,
ADD COLUMN     "memo" TEXT,
ADD COLUMN     "purchaseOrderId" UUID,
ADD COLUMN     "recurringId" UUID;

-- AlterTable
ALTER TABLE "BillLine" ADD COLUMN     "billable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "billableToId" UUID,
ADD COLUMN     "classId" UUID,
ADD COLUMN     "invoiceLineId" UUID,
ADD COLUMN     "itemId" UUID,
ADD COLUMN     "projectId" UUID;

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "emailFromName" TEXT,
ADD COLUMN     "emailReplyTo" TEXT,
ADD COLUMN     "lateFeeSettings" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "logo" BYTEA,
ADD COLUMN     "logoMime" TEXT,
ADD COLUMN     "organizationId" UUID,
ADD COLUMN     "reminderSettings" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "template" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "locationId" UUID,
ADD COLUMN     "recurringId" UUID;

-- AlterTable
ALTER TABLE "ExpenseLine" ADD COLUMN     "billable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "billableToId" UUID,
ADD COLUMN     "classId" UUID,
ADD COLUMN     "invoiceLineId" UUID,
ADD COLUMN     "projectId" UUID;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "estimateId" UUID,
ADD COLUMN     "lastSentAt" TIMESTAMP(3),
ADD COLUMN     "lateFeeForId" UUID,
ADD COLUMN     "locationId" UUID,
ADD COLUMN     "payToken" TEXT,
ADD COLUMN     "recurringId" UUID;

-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN     "classId" UUID,
ADD COLUMN     "cogs" DECIMAL(19,4),
ADD COLUMN     "projectId" UUID;

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "avgCost" DECIMAL(19,6) NOT NULL DEFAULT 0,
ADD COLUMN     "cogsAccountId" UUID,
ADD COLUMN     "inventoryAccountId" UUID,
ADD COLUMN     "purchaseCost" DECIMAL(19,4),
ADD COLUMN     "purchaseDescription" TEXT,
ADD COLUMN     "qtyOnHand" DECIMAL(19,4) NOT NULL DEFAULT 0,
ADD COLUMN     "reorderPoint" DECIMAL(19,4),
ADD COLUMN     "trackInventory" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "JournalLine" ADD COLUMN     "classId" UUID,
ADD COLUMN     "locationId" UUID,
ADD COLUMN     "projectId" UUID;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "depositId" UUID,
ADD COLUMN     "method" "PaymentMethod";

-- AlterTable
ALTER TABLE "SalesReceipt" ADD COLUMN     "depositId" UUID,
ADD COLUMN     "lastSentAt" TIMESTAMP(3),
ADD COLUMN     "locationId" UUID;

-- AlterTable
ALTER TABLE "SalesReceiptLine" ADD COLUMN     "classId" UUID,
ADD COLUMN     "cogs" DECIMAL(19,4),
ADD COLUMN     "projectId" UUID;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" UUID NOT NULL,
    "companyId" UUID,
    "kind" TEXT NOT NULL,
    "documentId" UUID,
    "to" TEXT[],
    "cc" TEXT[],
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerId" TEXT,
    "error" TEXT,
    "sentById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Estimate" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "EstimateStatus" NOT NULL DEFAULT 'PENDING',
    "issueDate" DATE NOT NULL,
    "expiryDate" DATE,
    "taxInclusive" BOOLEAN NOT NULL DEFAULT false,
    "currency" CHAR(3) NOT NULL DEFAULT 'CAD',
    "subtotal" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "billingAddress" TEXT,
    "message" TEXT,
    "memo" TEXT,
    "acceptedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "invoiceId" UUID,
    "lastSentAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Estimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimateLine" (
    "id" UUID NOT NULL,
    "estimateId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL,
    "unitPrice" DECIMAL(19,4) NOT NULL,
    "accountId" UUID NOT NULL,
    "taxCodeId" UUID NOT NULL,
    "net" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "taxDetail" JSONB NOT NULL DEFAULT '[]',
    "taxAmount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "itemId" UUID,
    "serviceDate" DATE,
    "classId" UUID,
    "projectId" UUID,

    CONSTRAINT "EstimateLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringTemplate" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "every" INTEGER NOT NULL DEFAULT 1,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "nextDate" DATE,
    "maxRuns" INTEGER,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "daysDue" INTEGER NOT NULL DEFAULT 30,
    "payload" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceReminder" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "stage" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emailId" UUID,

    CONSTRAINT "InvoiceReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeAccount" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "secretKeyEnc" TEXT NOT NULL,
    "webhookSecretEnc" TEXT,
    "mode" TEXT NOT NULL,
    "accountName" TEXT,
    "clearingAccountId" UUID NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeCheckout" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "sessionId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "paymentIntentId" TEXT,
    "paymentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "StripeCheckout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deposit" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "bankAccountId" UUID NOT NULL,
    "memo" TEXT,
    "total" DECIMAL(19,4) NOT NULL,
    "journalEntryId" UUID NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositLine" (
    "id" UUID NOT NULL,
    "depositId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" UUID,
    "accountId" UUID NOT NULL,
    "contactId" UUID,
    "description" TEXT,
    "amount" DECIMAL(19,4) NOT NULL,

    CONSTRAINT "DepositLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" UUID,
    "quantity" DECIMAL(19,4) NOT NULL,
    "value" DECIMAL(19,4) NOT NULL,
    "qtyAfter" DECIMAL(19,4) NOT NULL,
    "avgCostAfter" DECIMAL(19,6) NOT NULL,
    "journalEntryId" UUID,
    "memo" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'OPEN',
    "issueDate" DATE NOT NULL,
    "expectedDate" DATE,
    "taxInclusive" BOOLEAN NOT NULL DEFAULT false,
    "currency" CHAR(3) NOT NULL DEFAULT 'CAD',
    "subtotal" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "shipTo" TEXT,
    "message" TEXT,
    "memo" TEXT,
    "billId" UUID,
    "lastSentAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL,
    "unitPrice" DECIMAL(19,4) NOT NULL,
    "accountId" UUID NOT NULL,
    "taxCodeId" UUID NOT NULL,
    "net" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "taxDetail" JSONB NOT NULL DEFAULT '[]',
    "taxAmount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "itemId" UUID,
    "classId" UUID,
    "projectId" UUID,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditApplication" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "creditInvoiceId" UUID,
    "invoiceId" UUID,
    "creditBillId" UUID,
    "billId" UUID,
    "amount" DECIMAL(19,4) NOT NULL,
    "date" DATE NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "description" TEXT,
    "budget" DECIMAL(19,4),
    "startDate" DATE,
    "endDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeEntry" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "hours" DECIMAL(9,2) NOT NULL,
    "customerId" UUID,
    "projectId" UUID,
    "itemId" UUID,
    "description" TEXT,
    "billable" BOOLEAN NOT NULL DEFAULT false,
    "rate" DECIMAL(19,4),
    "invoiceLineId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingClass" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "fiscalYearId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetLine" (
    "id" UUID NOT NULL,
    "budgetId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "month" DATE NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,

    CONSTRAINT "BudgetLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'essentials',
    "status" TEXT NOT NULL DEFAULT 'trialing',
    "trialEndsAt" TIMESTAMP(3),
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailMessage_companyId_createdAt_idx" ON "EmailMessage"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailMessage_companyId_kind_documentId_idx" ON "EmailMessage"("companyId", "kind", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "Estimate_invoiceId_key" ON "Estimate"("invoiceId");

-- CreateIndex
CREATE INDEX "Estimate_companyId_status_idx" ON "Estimate"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Estimate_companyId_number_key" ON "Estimate"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "EstimateLine_estimateId_lineNo_key" ON "EstimateLine"("estimateId", "lineNo");

-- CreateIndex
CREATE INDEX "RecurringTemplate_isActive_nextDate_idx" ON "RecurringTemplate"("isActive", "nextDate");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceReminder_invoiceId_stage_key" ON "InvoiceReminder"("invoiceId", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "StripeAccount_companyId_key" ON "StripeAccount"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "StripeCheckout_sessionId_key" ON "StripeCheckout"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "StripeCheckout_paymentId_key" ON "StripeCheckout"("paymentId");

-- CreateIndex
CREATE INDEX "StripeCheckout_invoiceId_idx" ON "StripeCheckout"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "StripeEvent_companyId_eventId_key" ON "StripeEvent"("companyId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_journalEntryId_key" ON "Deposit"("journalEntryId");

-- CreateIndex
CREATE INDEX "Deposit_companyId_date_idx" ON "Deposit"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DepositLine_depositId_lineNo_key" ON "DepositLine"("depositId", "lineNo");

-- CreateIndex
CREATE INDEX "InventoryMovement_companyId_itemId_createdAt_idx" ON "InventoryMovement"("companyId", "itemId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryMovement_companyId_sourceType_sourceId_idx" ON "InventoryMovement"("companyId", "sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_billId_key" ON "PurchaseOrder"("billId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_companyId_status_idx" ON "PurchaseOrder"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_companyId_number_key" ON "PurchaseOrder"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderLine_orderId_lineNo_key" ON "PurchaseOrderLine"("orderId", "lineNo");

-- CreateIndex
CREATE INDEX "CreditApplication_companyId_idx" ON "CreditApplication"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_companyId_name_key" ON "Project"("companyId", "name");

-- CreateIndex
CREATE INDEX "TimeEntry_companyId_date_idx" ON "TimeEntry"("companyId", "date");

-- CreateIndex
CREATE INDEX "TimeEntry_companyId_customerId_billable_idx" ON "TimeEntry"("companyId", "customerId", "billable");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingClass_companyId_name_key" ON "TrackingClass"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Location_companyId_name_key" ON "Location"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_companyId_name_key" ON "Budget"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetLine_budgetId_accountId_month_key" ON "BudgetLine"("budgetId", "accountId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_stripeCustomerId_key" ON "Organization"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_stripeSubscriptionId_key" ON "Organization"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "Organization_ownerId_idx" ON "Organization"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailToken_tokenHash_key" ON "EmailToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Account_companyId_special_key" ON "Account"("companyId", "special");

-- CreateIndex
CREATE INDEX "Company_organizationId_idx" ON "Company"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_lateFeeForId_key" ON "Invoice"("lateFeeForId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_payToken_key" ON "Invoice"("payToken");

-- CreateIndex
CREATE INDEX "JournalLine_companyId_classId_idx" ON "JournalLine"("companyId", "classId");

-- CreateIndex
CREATE INDEX "JournalLine_companyId_locationId_idx" ON "JournalLine"("companyId", "locationId");

-- CreateIndex
CREATE INDEX "JournalLine_companyId_projectId_idx" ON "JournalLine"("companyId", "projectId");

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_depositId_fkey" FOREIGN KEY ("depositId") REFERENCES "Deposit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReceipt" ADD CONSTRAINT "SalesReceipt_depositId_fkey" FOREIGN KEY ("depositId") REFERENCES "Deposit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateLine" ADD CONSTRAINT "EstimateLine_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateLine" ADD CONSTRAINT "EstimateLine_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringTemplate" ADD CONSTRAINT "RecurringTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceReminder" ADD CONSTRAINT "InvoiceReminder_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceReminder" ADD CONSTRAINT "InvoiceReminder_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeAccount" ADD CONSTRAINT "StripeAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeCheckout" ADD CONSTRAINT "StripeCheckout_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeCheckout" ADD CONSTRAINT "StripeCheckout_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeEvent" ADD CONSTRAINT "StripeEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositLine" ADD CONSTRAINT "DepositLine_depositId_fkey" FOREIGN KEY ("depositId") REFERENCES "Deposit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositLine" ADD CONSTRAINT "DepositLine_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditApplication" ADD CONSTRAINT "CreditApplication_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditApplication" ADD CONSTRAINT "CreditApplication_creditInvoiceId_fkey" FOREIGN KEY ("creditInvoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditApplication" ADD CONSTRAINT "CreditApplication_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditApplication" ADD CONSTRAINT "CreditApplication_creditBillId_fkey" FOREIGN KEY ("creditBillId") REFERENCES "Bill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditApplication" ADD CONSTRAINT "CreditApplication_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_invoiceLineId_fkey" FOREIGN KEY ("invoiceLineId") REFERENCES "InvoiceLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingClass" ADD CONSTRAINT "TrackingClass_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "Budget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailToken" ADD CONSTRAINT "EmailToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

