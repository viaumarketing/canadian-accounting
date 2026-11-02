-- ca:compat additive (new tables and nullable columns; older versions ignore them)

-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('SERVICE', 'NON_INVENTORY');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CHEQUE', 'CREDIT_CARD', 'DEBIT_CARD', 'E_TRANSFER', 'OTHER');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "address" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "phone" TEXT;

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "billingAddress" TEXT,
ADD COLUMN     "defaultTerms" TEXT,
ADD COLUMN     "phone" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "billingAddress" TEXT,
ADD COLUMN     "memo" TEXT,
ADD COLUMN     "message" TEXT,
ADD COLUMN     "terms" TEXT;

-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN     "itemId" UUID,
ADD COLUMN     "serviceDate" DATE;

-- CreateTable
CREATE TABLE "Item" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "type" "ItemType" NOT NULL DEFAULT 'SERVICE',
    "description" TEXT,
    "rate" DECIMAL(19,4),
    "incomeAccountId" UUID NOT NULL,
    "taxCodeId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesReceipt" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "number" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "date" DATE NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'OTHER',
    "referenceNo" TEXT,
    "depositAccountId" UUID NOT NULL,
    "taxInclusive" BOOLEAN NOT NULL DEFAULT false,
    "currency" CHAR(3) NOT NULL DEFAULT 'CAD',
    "subtotal" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "billingAddress" TEXT,
    "message" TEXT,
    "memo" TEXT,
    "journalEntryId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesReceiptLine" (
    "id" UUID NOT NULL,
    "receiptId" UUID NOT NULL,
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

    CONSTRAINT "SalesReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Item_companyId_name_key" ON "Item"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SalesReceipt_journalEntryId_key" ON "SalesReceipt"("journalEntryId");

-- CreateIndex
CREATE INDEX "SalesReceipt_companyId_date_idx" ON "SalesReceipt"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "SalesReceipt_companyId_number_key" ON "SalesReceipt"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "SalesReceiptLine_receiptId_lineNo_key" ON "SalesReceiptLine"("receiptId", "lineNo");

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_incomeAccountId_fkey" FOREIGN KEY ("incomeAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_taxCodeId_fkey" FOREIGN KEY ("taxCodeId") REFERENCES "TaxCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReceipt" ADD CONSTRAINT "SalesReceipt_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReceipt" ADD CONSTRAINT "SalesReceipt_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReceipt" ADD CONSTRAINT "SalesReceipt_depositAccountId_fkey" FOREIGN KEY ("depositAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReceiptLine" ADD CONSTRAINT "SalesReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "SalesReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReceiptLine" ADD CONSTRAINT "SalesReceiptLine_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReceiptLine" ADD CONSTRAINT "SalesReceiptLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReceiptLine" ADD CONSTRAINT "SalesReceiptLine_taxCodeId_fkey" FOREIGN KEY ("taxCodeId") REFERENCES "TaxCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

