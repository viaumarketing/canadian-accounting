import type { PrismaClient } from '@ca/database';

/**
 * Highest database schema compatibility level this build can run against. Raise it together with any migration that
 * older builds cannot run on (that migration must also run `UPDATE "SchemaCompat" SET "level" = <n>`); CI enforces both.
 * Additive migrations (new tables, nullable columns, relaxed constraints) leave it unchanged, so the previous release keeps
 * working on the upgraded database and a rollback does not need a data restore.
 */
export const SCHEMA_COMPAT_LEVEL = 1;

export async function schemaCompat(prisma: PrismaClient): Promise<{ database: number | null; app: number; ok: boolean }> {
  try {
    const rows = await prisma.$queryRaw<{ level: number }[]>`SELECT "level" FROM "SchemaCompat" WHERE "id" = 1`;
    const database = rows[0]?.level ?? null;
    return { database, app: SCHEMA_COMPAT_LEVEL, ok: database === null || database <= SCHEMA_COMPAT_LEVEL };
  } catch {
    // Table not created yet (migrations pending): nothing newer than us can be there.
    return { database: null, app: SCHEMA_COMPAT_LEVEL, ok: true };
  }
}
