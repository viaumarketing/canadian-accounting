-- ca:compat additive (older app versions ignore these nullable columns)

-- Year-end close bookkeeping on the fiscal year.
ALTER TABLE "FiscalYear" ADD COLUMN "closingEntryId" UUID;
ALTER TABLE "FiscalYear" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "FiscalYear" ADD COLUMN "closedById" UUID;
