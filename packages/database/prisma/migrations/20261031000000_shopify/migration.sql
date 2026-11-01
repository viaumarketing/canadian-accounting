-- CreateEnum
CREATE TYPE "ShopifyStoreStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "SyncJobKind" AS ENUM ('HISTORICAL', 'INCREMENTAL');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "PostingStatus" AS ENUM ('PENDING', 'POSTED', 'SKIPPED', 'NEEDS_REVIEW');

-- CreateTable
CREATE TABLE "ShopifyStore" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopName" TEXT,
    "status" "ShopifyStoreStatus" NOT NULL DEFAULT 'CONNECTED',
    "scopes" TEXT NOT NULL DEFAULT '',
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "apiVersion" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "paymentsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "historyStart" TIMESTAMP(3),
    "ordersWatermark" TIMESTAMP(3),
    "paymentsWatermark" TIMESTAMP(3),
    "accountMap" JSONB NOT NULL DEFAULT '{}',
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifyStore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyOAuthState" (
    "state" TEXT NOT NULL,
    "companyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyOAuthState_pkey" PRIMARY KEY ("state")
);

-- CreateTable
CREATE TABLE "ShopifyOrder" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "updatedAtShopify" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "test" BOOLEAN NOT NULL DEFAULT false,
    "currency" CHAR(3) NOT NULL,
    "taxesIncluded" BOOLEAN NOT NULL DEFAULT false,
    "financialStatus" TEXT,
    "total" DECIMAL(19,4) NOT NULL,
    "tax" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "shipping" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "giftCardSales" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "discounts" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "postedFingerprint" TEXT,
    "postingStatus" "PostingStatus" NOT NULL DEFAULT 'PENDING',
    "postingNote" TEXT,
    "journalEntryId" UUID,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifyOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyTransaction" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "numericId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "gateway" TEXT,
    "amount" DECIMAL(19,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "processedAt" TIMESTAMP(3),
    "test" BOOLEAN NOT NULL DEFAULT false,
    "parentShopifyId" TEXT,
    "feeAmount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "feeTax" DECIMAL(19,4) NOT NULL DEFAULT 0,

    CONSTRAINT "ShopifyTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyRefund" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "total" DECIMAL(19,4) NOT NULL,
    "tax" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "refundedToPayment" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "gateway" TEXT,
    "payload" JSONB NOT NULL,
    "postingStatus" "PostingStatus" NOT NULL DEFAULT 'PENDING',
    "postingNote" TEXT,
    "journalEntryId" UUID,

    CONSTRAINT "ShopifyRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyPayout" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "net" DECIMAL(19,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "summary" JSONB NOT NULL,
    "externalTraceId" TEXT,
    "postingStatus" "PostingStatus" NOT NULL DEFAULT 'PENDING',
    "postingNote" TEXT,
    "journalEntryId" UUID,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifyPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyBalanceTransaction" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "payoutShopifyId" TEXT,
    "payoutStatus" TEXT,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "fee" DECIMAL(19,4) NOT NULL,
    "net" DECIMAL(19,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "transactionDate" TIMESTAMP(3) NOT NULL,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "sourceOrderTransactionId" TEXT,
    "orderName" TEXT,
    "adjustmentReason" TEXT,
    "postingStatus" "PostingStatus" NOT NULL DEFAULT 'PENDING',
    "postingNote" TEXT,
    "feeJournalId" UUID,
    "amountJournalId" UUID,
    "classifiedAccountId" UUID,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifyBalanceTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyDispute" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "initiatedAt" TIMESTAMP(3) NOT NULL,
    "finalizedOn" TIMESTAMP(3),
    "orderShopifyId" TEXT,

    CONSTRAINT "ShopifyDispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifySyncJob" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "kind" "SyncJobKind" NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "since" TIMESTAMP(3),
    "progress" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "errorLog" JSONB NOT NULL DEFAULT '[]',
    "requestedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ShopifySyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyWebhookEvent" (
    "webhookId" TEXT NOT NULL,
    "companyId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "ShopifyWebhookEvent_pkey" PRIMARY KEY ("webhookId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyStore_shopDomain_key" ON "ShopifyStore"("shopDomain");

-- CreateIndex
CREATE INDEX "ShopifyStore_companyId_idx" ON "ShopifyStore"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyOrder_journalEntryId_key" ON "ShopifyOrder"("journalEntryId");

-- CreateIndex
CREATE INDEX "ShopifyOrder_companyId_processedAt_idx" ON "ShopifyOrder"("companyId", "processedAt");

-- CreateIndex
CREATE INDEX "ShopifyOrder_companyId_postingStatus_idx" ON "ShopifyOrder"("companyId", "postingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyOrder_storeId_shopifyId_key" ON "ShopifyOrder"("storeId", "shopifyId");

-- CreateIndex
CREATE INDEX "ShopifyTransaction_storeId_numericId_idx" ON "ShopifyTransaction"("storeId", "numericId");

-- CreateIndex
CREATE INDEX "ShopifyTransaction_orderId_idx" ON "ShopifyTransaction"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyTransaction_storeId_shopifyId_key" ON "ShopifyTransaction"("storeId", "shopifyId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyRefund_journalEntryId_key" ON "ShopifyRefund"("journalEntryId");

-- CreateIndex
CREATE INDEX "ShopifyRefund_companyId_postingStatus_idx" ON "ShopifyRefund"("companyId", "postingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyRefund_storeId_shopifyId_key" ON "ShopifyRefund"("storeId", "shopifyId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyPayout_journalEntryId_key" ON "ShopifyPayout"("journalEntryId");

-- CreateIndex
CREATE INDEX "ShopifyPayout_companyId_issuedAt_idx" ON "ShopifyPayout"("companyId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyPayout_storeId_shopifyId_key" ON "ShopifyPayout"("storeId", "shopifyId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyBalanceTransaction_feeJournalId_key" ON "ShopifyBalanceTransaction"("feeJournalId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyBalanceTransaction_amountJournalId_key" ON "ShopifyBalanceTransaction"("amountJournalId");

-- CreateIndex
CREATE INDEX "ShopifyBalanceTransaction_storeId_payoutShopifyId_idx" ON "ShopifyBalanceTransaction"("storeId", "payoutShopifyId");

-- CreateIndex
CREATE INDEX "ShopifyBalanceTransaction_companyId_postingStatus_idx" ON "ShopifyBalanceTransaction"("companyId", "postingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyBalanceTransaction_storeId_shopifyId_key" ON "ShopifyBalanceTransaction"("storeId", "shopifyId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyDispute_storeId_shopifyId_key" ON "ShopifyDispute"("storeId", "shopifyId");

-- CreateIndex
CREATE INDEX "ShopifySyncJob_storeId_createdAt_idx" ON "ShopifySyncJob"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "ShopifyWebhookEvent_storeId_receivedAt_idx" ON "ShopifyWebhookEvent"("storeId", "receivedAt");

-- AddForeignKey
ALTER TABLE "ShopifyStore" ADD CONSTRAINT "ShopifyStore_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyOAuthState" ADD CONSTRAINT "ShopifyOAuthState_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyOrder" ADD CONSTRAINT "ShopifyOrder_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyOrder" ADD CONSTRAINT "ShopifyOrder_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyTransaction" ADD CONSTRAINT "ShopifyTransaction_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyTransaction" ADD CONSTRAINT "ShopifyTransaction_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyTransaction" ADD CONSTRAINT "ShopifyTransaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ShopifyOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyRefund" ADD CONSTRAINT "ShopifyRefund_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyRefund" ADD CONSTRAINT "ShopifyRefund_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyRefund" ADD CONSTRAINT "ShopifyRefund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ShopifyOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyPayout" ADD CONSTRAINT "ShopifyPayout_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyPayout" ADD CONSTRAINT "ShopifyPayout_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyBalanceTransaction" ADD CONSTRAINT "ShopifyBalanceTransaction_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyBalanceTransaction" ADD CONSTRAINT "ShopifyBalanceTransaction_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyDispute" ADD CONSTRAINT "ShopifyDispute_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyDispute" ADD CONSTRAINT "ShopifyDispute_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifySyncJob" ADD CONSTRAINT "ShopifySyncJob_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifySyncJob" ADD CONSTRAINT "ShopifySyncJob_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyWebhookEvent" ADD CONSTRAINT "ShopifyWebhookEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyWebhookEvent" ADD CONSTRAINT "ShopifyWebhookEvent_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One journal per Shopify source row, enforced by the database (defence in depth against double posting).
CREATE UNIQUE INDEX "journal_shopify_source_uniq" ON "JournalEntry" ("companyId", "sourceType", "sourceId")
  WHERE "sourceType" LIKE 'shopify\_%' AND "sourceId" IS NOT NULL;

-- Only one pending/running job per store and kind, so webhook bursts cannot pile up duplicate syncs.
CREATE UNIQUE INDEX "shopify_sync_job_active_uniq" ON "ShopifySyncJob" ("storeId", "kind") WHERE "status" IN ('PENDING', 'RUNNING');
