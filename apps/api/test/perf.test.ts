import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@ca/database';
import { PASSWORD, agent, bootApp, resetDb, setupAdmin } from './helpers';

/**
 * Performance check. Skipped in the normal run; use `pnpm --filter @ca/api perf`.
 * Seeds a few years of busy-shop volume straight into PostgreSQL (entries are inserted as drafts and
 * then posted, so every row passes through the real immutability/balance triggers) and times the
 * endpoints a person actually waits on. Numbers depend on the machine: the budgets are generous
 * guard rails against order-of-magnitude regressions, not a benchmark.
 */
const ENTRIES = Number(process.env.PERF_ENTRIES ?? 60_000);
const BUDGET_MS = Number(process.env.PERF_BUDGET_MS ?? 3_000);

let app: INestApplication;
let prisma: PrismaClient;

describe.skipIf(!process.env.PERF)(`performance with ${ENTRIES} posted journal entries`, () => {
  let owner: ReturnType<typeof agent>;
  let companyId: string;
  const timings: { name: string; ms: number; bytes: number }[] = [];

  beforeAll(async () => {
    ({ app, prisma } = await bootApp());
    await resetDb(prisma);
    const root = await setupAdmin(app);
    const c = (
      await root
        .post('/admin/companies', { legalName: 'Perf Co', province: 'ON', ownerEmail: 'perf@example.test', ownerName: 'Perf', ownerTemporaryPassword: PASSWORD })
        .expect(201)
    ).body;
    companyId = c.id;
    owner = agent(app);
    await owner.post('/auth/login', { email: 'perf@example.test', password: PASSWORD }).expect(200);
    await owner.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' }).expect(204);

    const t0 = Date.now();
    const userId = (await prisma.user.findFirstOrThrow({ where: { email: 'perf@example.test' } })).id;
    // Three lines per entry: Dr asset|expense, Cr income, Cr liability (a sale with tax). Dates span three years.
    await prisma.$executeRawUnsafe(
      `
      WITH gen AS (
        SELECT g, gen_random_uuid() AS eid, DATE '2023-11-01' + (g % 1095) AS d FROM generate_series(1, ${ENTRIES}) g
      ), ins AS (
        INSERT INTO "JournalEntry" (id, "companyId", date, memo, status, "sourceType", "createdById")
        SELECT eid, $1::uuid, d, 'perf ' || g, 'DRAFT', 'manual', $2::uuid FROM gen RETURNING id
      )
      SELECT count(*) FROM ins`,
      companyId,
      userId,
    );
    await prisma.$executeRawUnsafe(
      `
      WITH e AS (SELECT id, row_number() OVER (ORDER BY memo) rn FROM "JournalEntry" WHERE "companyId" = $1::uuid AND memo LIKE 'perf %'),
      debit AS (SELECT id, row_number() OVER (ORDER BY code) rn FROM "Account" WHERE "companyId" = $1::uuid AND type IN ('ASSET','EXPENSE') AND "isActive" AND role IS NULL),
      inc AS (SELECT id, row_number() OVER (ORDER BY code) rn FROM "Account" WHERE "companyId" = $1::uuid AND type = 'REVENUE' AND "isActive" AND role IS NULL),
      liab AS (SELECT id, row_number() OVER (ORDER BY code) rn FROM "Account" WHERE "companyId" = $1::uuid AND type = 'LIABILITY' AND "isActive" AND role IS NULL),
      nd AS (SELECT count(*) c FROM debit), ni AS (SELECT count(*) c FROM inc), nl AS (SELECT count(*) c FROM liab),
      m AS (
        SELECT e.id eid, ((e.rn * 37) % 10000 + 100) / 100.0 AS net, e.rn,
               (SELECT id FROM debit WHERE rn = 1 + (e.rn % (SELECT c FROM nd))) dacc,
               (SELECT id FROM inc WHERE rn = 1 + (e.rn % (SELECT c FROM ni))) iacc,
               (SELECT id FROM liab WHERE rn = 1 + (e.rn % (SELECT c FROM nl))) lacc
        FROM e
      )
      INSERT INTO "JournalLine" (id, "entryId", "companyId", "lineNo", "accountId", debit, credit)
      SELECT gen_random_uuid(), eid, $1::uuid, 1, dacc, round(net * 1.13, 2), 0 FROM m
      UNION ALL SELECT gen_random_uuid(), eid, $1::uuid, 2, iacc, 0, net FROM m
      UNION ALL SELECT gen_random_uuid(), eid, $1::uuid, 3, lacc, 0, round(net * 1.13, 2) - net FROM m`,
      companyId,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "JournalEntry" j SET status='POSTED', number = n.rn, "postedAt" = now(), "postedById" = $2::uuid
       FROM (SELECT id, row_number() OVER (ORDER BY date, memo) rn FROM "JournalEntry" WHERE "companyId" = $1::uuid AND memo LIKE 'perf %') n
       WHERE j.id = n.id`,
      companyId,
      userId,
    );
    await prisma.$executeRawUnsafe(`INSERT INTO "Sequence" ("companyId", name, next) VALUES ($1::uuid, 'journal', ${ENTRIES + 1}) ON CONFLICT ("companyId", name) DO UPDATE SET next = ${ENTRIES + 1}`, companyId);
    await prisma.$executeRawUnsafe(`ANALYZE "JournalEntry"`);
    await prisma.$executeRawUnsafe(`ANALYZE "JournalLine"`);
    console.log(`seeded ${ENTRIES} entries in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }, 900_000);

  afterAll(async () => {
    console.table(timings.map((t) => ({ endpoint: t.name, ms: Math.round(t.ms), 'KB': Math.round(t.bytes / 1024) })));
    await prisma.$disconnect();
    await app.close();
  });

  async function time(name: string, path: string) {
    const t = performance.now();
    const res = await owner.raw.get(`/companies/${companyId}${path}`);
    const ms = performance.now() - t;
    timings.push({ name, ms, bytes: Number(res.headers['content-length'] ?? JSON.stringify(res.body ?? '').length) });
    return { res, ms };
  }

  it('the data really is there and balanced', async () => {
    const [{ n, d, c }] = await prisma.$queryRawUnsafe<{ n: bigint; d: string; c: string }[]>(
      `SELECT count(*) n, sum(debit)::text d, sum(credit)::text c FROM "JournalLine" WHERE "companyId" = $1::uuid`,
      companyId,
    );
    expect(Number(n)).toBe(ENTRIES * 3);
    expect(d).toBe(c);
  });

  it('every parameter-free report finishes inside the budget', async () => {
    const catalog = (await owner.get(`/companies/${companyId}/report`).expect(200)).body as { key: string; params: string[] }[];
    const runnable = catalog.filter((r) => !r.params.includes('accountId') && !r.params.includes('reconciliationId'));
    expect(runnable.length).toBeGreaterThan(10);
    const slow: string[] = [];
    for (const r of runnable) {
      const { res, ms } = await time(`report/${r.key}`, `/report/${r.key}?from=2023-11-01&to=2026-10-31&asOf=2026-10-31`);
      expect(res.status, r.key).toBe(200);
      if (ms > BUDGET_MS) slow.push(`${r.key} ${Math.round(ms)}ms`);
    }
    expect(slow).toEqual([]);
  }, 300_000);

  it('the general ledger for one busy account, exports and list endpoints stay responsive', async () => {
    const busy = (await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "accountId" id FROM "JournalLine" WHERE "companyId" = $1::uuid GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
      companyId,
    ))[0].id;
    const checks: [string, string][] = [
      ['report/general-ledger (busiest account, 3y)', `/report/general-ledger?accountId=${busy}&from=2023-11-01&to=2026-10-31`],
      ['report/trial-balance (xlsx)', `/report/trial-balance?format=xlsx&to=2026-10-31`],
      ['report/profit-loss (pdf)', `/report/profit-loss?format=pdf&from=2025-11-01&to=2026-10-31`],
      ['journals (page 1)', `/journals?take=50`],
      ['accounts', `/accounts`],
      ['dashboard', `/dashboard`],
      ['periods', `/periods`],
    ];
    const slow: string[] = [];
    for (const [name, p] of checks) {
      const { res, ms } = await time(name, p);
      expect(res.status, name).toBe(200);
      if (ms > BUDGET_MS) slow.push(`${name} ${Math.round(ms)}ms`);
    }
    expect(slow).toEqual([]);
  }, 300_000);

  it('posting a new entry is not slowed by history', async () => {
    const accts = (await owner.get(`/companies/${companyId}/accounts`).expect(200)).body as { id: string; type: string; role: string | null }[];
    const a = accts.find((x) => x.type === 'EXPENSE' && !x.role)!;
    const b = accts.find((x) => x.type === 'ASSET' && !x.role)!;
    const t = performance.now();
    await owner.post(`/companies/${companyId}/journals`, { date: '2026-10-31', memo: 'late entry', post: true, lines: [{ accountId: a.id, debit: '5.00' }, { accountId: b.id, credit: '5.00' }] }).expect(201);
    const ms = performance.now() - t;
    timings.push({ name: 'POST journal (post=true)', ms, bytes: 0 });
    expect(ms).toBeLessThan(1_000);
  });
});
