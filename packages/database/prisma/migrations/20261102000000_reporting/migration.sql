-- CreateEnum
CREATE TYPE "CashFlowClass" AS ENUM ('OPERATING', 'INVESTING', 'FINANCING');

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "cashFlow" "CashFlowClass";


-- Classify the template's non-operating accounts for the statement of cash flows (only where the code still carries the template's meaning).
UPDATE "Account" SET "cashFlow" = 'INVESTING' WHERE "code" IN ('1500', '1510') AND "type" = 'ASSET';
UPDATE "Account" SET "cashFlow" = 'FINANCING' WHERE "code" IN ('2500') AND "type" = 'LIABILITY';
