-- ca:compat additive (older app versions keep working on this schema)

-- Bank statement files can live on the NAS documents folder instead of in the database.
ALTER TABLE "BankStatement" ALTER COLUMN "content" DROP NOT NULL;
ALTER TABLE "BankStatement" ADD COLUMN "storageKey" TEXT;
ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_has_content" CHECK ("content" IS NOT NULL OR "storageKey" IS NOT NULL);

-- Resource history for System health.
CREATE TABLE "ResourceSample" (
    "id" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" JSONB NOT NULL,
    CONSTRAINT "ResourceSample_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ResourceSample_at_idx" ON "ResourceSample"("at");

-- Schema compatibility level (see docs/dxp2800.md, "Migrations and rollback").
CREATE TABLE "SchemaCompat" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "level" INTEGER NOT NULL,
    CONSTRAINT "SchemaCompat_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SchemaCompat_single_row" CHECK ("id" = 1)
);
INSERT INTO "SchemaCompat" ("id", "level") VALUES (1, 1);
