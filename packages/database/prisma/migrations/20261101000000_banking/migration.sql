-- CreateEnum
CREATE TYPE "BankAccountKind" AS ENUM ('CHEQUING', 'SAVINGS', 'CREDIT_CARD');

-- CreateEnum
CREATE TYPE "BankTxnStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'RECONCILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('SUGGESTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('COMPLETED', 'REOPENED');

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "ledgerAccountId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "institution" TEXT,
    "mask" TEXT,
    "kind" "BankAccountKind" NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'CAD',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "connectionId" UUID,
    "providerAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankProviderConnection" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerItemId" TEXT NOT NULL,
    "institutionName" TEXT,
    "accessTokenEnc" TEXT NOT NULL,
    "cursor" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankProviderConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "bankAccountId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "statementId" UUID,
    "total" INTEGER NOT NULL DEFAULT 0,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "skippedDuplicates" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatement" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "bankAccountId" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "periodStart" DATE,
    "periodEnd" DATE,
    "endingBalance" DECIMAL(19,4),
    "uploadedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "bankAccountId" UUID NOT NULL,
    "statementId" UUID,
    "batchId" UUID,
    "externalId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "balanceAfter" DECIMAL(19,4),
    "status" "BankTxnStatus" NOT NULL DEFAULT 'UNMATCHED',
    "matchedLineId" UUID,
    "matchedAt" TIMESTAMP(3),
    "matchedById" UUID,
    "suggestedAccountId" UUID,
    "suggestedRuleId" UUID,
    "reconciliationId" UUID,
    "ignoredReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankRule" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "conditions" JSONB NOT NULL,
    "accountId" UUID NOT NULL,
    "taxCodeId" UUID,
    "contactId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reconciliation" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "bankAccountId" UUID NOT NULL,
    "statementDate" DATE NOT NULL,
    "statementBalance" DECIMAL(19,4) NOT NULL,
    "openingBalance" DECIMAL(19,4) NOT NULL,
    "clearedTotal" DECIMAL(19,4) NOT NULL,
    "txnCount" INTEGER NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'COMPLETED',
    "completedById" UUID,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reopenedAt" TIMESTAMP(3),
    "reopenedById" UUID,
    "note" TEXT,

    CONSTRAINT "Reconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationMatch" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "bankTxnId" UUID NOT NULL,
    "journalLineId" UUID NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "status" "MatchStatus" NOT NULL DEFAULT 'SUGGESTED',
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankAccount_companyId_idx" ON "BankAccount"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "BankAccount_companyId_ledgerAccountId_key" ON "BankAccount"("companyId", "ledgerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "BankAccount_connectionId_providerAccountId_key" ON "BankAccount"("connectionId", "providerAccountId");

-- CreateIndex
CREATE INDEX "BankProviderConnection_companyId_idx" ON "BankProviderConnection"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "BankProviderConnection_provider_providerItemId_key" ON "BankProviderConnection"("provider", "providerItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatch_statementId_key" ON "ImportBatch"("statementId");

-- CreateIndex
CREATE INDEX "ImportBatch_bankAccountId_createdAt_idx" ON "ImportBatch"("bankAccountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatement_bankAccountId_sha256_key" ON "BankStatement"("bankAccountId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_matchedLineId_key" ON "BankTransaction"("matchedLineId");

-- CreateIndex
CREATE INDEX "BankTransaction_bankAccountId_date_idx" ON "BankTransaction"("bankAccountId", "date");

-- CreateIndex
CREATE INDEX "BankTransaction_companyId_status_idx" ON "BankTransaction"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_bankAccountId_fingerprint_key" ON "BankTransaction"("bankAccountId", "fingerprint");

-- CreateIndex
CREATE INDEX "BankRule_companyId_priority_idx" ON "BankRule"("companyId", "priority");

-- CreateIndex
CREATE INDEX "Reconciliation_bankAccountId_statementDate_idx" ON "Reconciliation"("bankAccountId", "statementDate");

-- CreateIndex
CREATE INDEX "ReconciliationMatch_companyId_status_idx" ON "ReconciliationMatch"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationMatch_bankTxnId_journalLineId_key" ON "ReconciliationMatch"("bankTxnId", "journalLineId");

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BankProviderConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankProviderConnection" ADD CONSTRAINT "BankProviderConnection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "BankStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "BankStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_reconciliationId_fkey" FOREIGN KEY ("reconciliationId") REFERENCES "Reconciliation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankRule" ADD CONSTRAINT "BankRule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationMatch" ADD CONSTRAINT "ReconciliationMatch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationMatch" ADD CONSTRAINT "ReconciliationMatch_bankTxnId_fkey" FOREIGN KEY ("bankTxnId") REFERENCES "BankTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A journal line can be matched to at most one bank transaction (approved matches only), enforced by the database.
-- BankTransaction.matchedLineId is already UNIQUE; this adds the guard that the line lives in the same company's bank ledger.
ALTER TABLE "BankTransaction" ADD CONSTRAINT bank_txn_match_state_chk CHECK (
  ("status" IN ('MATCHED','RECONCILED') AND "matchedLineId" IS NOT NULL) OR ("status" IN ('UNMATCHED','IGNORED') AND "matchedLineId" IS NULL)
);
ALTER TABLE "BankTransaction" ADD CONSTRAINT bank_txn_amount_chk CHECK ("amount" <> 0);
CREATE UNIQUE INDEX "recon_match_one_approved_per_line" ON "ReconciliationMatch" ("journalLineId") WHERE "status" = 'APPROVED';
CREATE UNIQUE INDEX "recon_match_one_approved_per_txn" ON "ReconciliationMatch" ("bankTxnId") WHERE "status" = 'APPROVED';

-- Completed reconciliations lock their transactions: reconciled rows cannot be altered or deleted.
CREATE OR REPLACE FUNCTION ca_bank_txn_reconciled_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'RECONCILED' THEN RAISE EXCEPTION 'Reconciled bank transactions cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'RECONCILED' AND NEW."status" = 'RECONCILED' AND
     (NEW."amount" <> OLD."amount" OR NEW."date" <> OLD."date" OR NEW."matchedLineId" IS DISTINCT FROM OLD."matchedLineId") THEN
    RAISE EXCEPTION 'Reconciled bank transactions cannot be modified';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER bank_txn_reconciled_guard BEFORE UPDATE OR DELETE ON "BankTransaction" FOR EACH ROW EXECUTE FUNCTION ca_bank_txn_reconciled_guard();

