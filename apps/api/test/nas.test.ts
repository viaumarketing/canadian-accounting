import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@ca/database';
import { ShopifySyncService } from '../src/shopify/sync.service';
import { ResourcesService } from '../src/admin/resources.service';
import { SCHEMA_COMPAT_LEVEL } from '../src/common/schema-compat';
import { warningsFor } from '../src/common/resources';
import { agent, bootApp, resetDb, setupAdmin } from './helpers';

/** Behaviour added for running on a small NAS (UGREEN DXP2800): backpressure, schema compatibility, resource monitoring. */
let app: INestApplication;
let prisma: PrismaClient;
beforeAll(async () => ({ app, prisma } = await bootApp({ SYNC_MAX_BACKLOG: '2', QUEUE_MODE: 'none', REDIS_URL: '' })));
afterAll(async () => { await prisma.$disconnect(); await app.close(); });
beforeEach(async () => {
  await resetDb(prisma);
  await prisma.resourceSample.deleteMany();
});

async function companyWithStores(n: number) {
  const root = await setupAdmin(app);
  const c = (await root.post('/admin/companies', { legalName: 'Busy Shop Inc.', province: 'ON', ownerEmail: 'root@example.test' }).expect(201)).body;
  const stores = [];
  for (let i = 0; i < n; i++) {
    stores.push(await prisma.shopifyStore.create({ data: { companyId: c.id, shopDomain: `s${i}.myshopify.com`, status: 'CONNECTED', accessTokenEnc: 'x', apiVersion: '2026-10', currency: 'CAD' } }));
  }
  return { root, companyId: c.id as string, stores };
}

describe('queue backpressure', () => {
  it('refuses new manual syncs once the platform backlog is full, but still answers with the job a store already has', async () => {
    const { root, companyId, stores } = await companyWithStores(3);
    const sync = (i: number) => root.post(`/companies/${companyId}/shopify/stores/${stores[i].id}/sync`, { kind: 'INCREMENTAL' });
    const j0 = (await sync(0).expect(201)).body;
    await sync(1).expect(201);
    const busy = await sync(2);
    expect(busy.status).toBe(503);
    expect(busy.body.code).toBe('QUEUE_BUSY');
    expect((await sync(0).expect(201)).body.id).toBe(j0.id); // existing job reused, not refused
    expect(await prisma.shopifySyncJob.count()).toBe(2);
  });

  it('the scheduler only tops the backlog up to the limit, longest-unsynced stores first', async () => {
    const { stores } = await companyWithStores(4);
    await prisma.shopifyStore.update({ where: { id: stores[0].id }, data: { lastSyncAt: new Date() } });
    const scheduled = await app.get(ShopifySyncService).scheduleAll();
    expect(scheduled).toBe(2);
    const jobs = await prisma.shopifySyncJob.findMany({ select: { storeId: true } });
    expect(jobs.map((j) => j.storeId)).not.toContain(stores[0].id);
    expect(await app.get(ShopifySyncService).scheduleAll()).toBe(0); // full: nothing more
  });
});

describe('schema compatibility (rollback safety)', () => {
  it('a database raised to a newer schema level makes this build report unready instead of running against it', async () => {
    await agent(app).raw.get('/health/ready').expect(200);
    expect((await agent(app).raw.get('/health')).body.schemaLevel).toBe(SCHEMA_COMPAT_LEVEL);
    await prisma.$executeRawUnsafe(`UPDATE "SchemaCompat" SET "level" = ${SCHEMA_COMPAT_LEVEL + 1}`);
    try {
      const r = await agent(app).raw.get('/health/ready');
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('SCHEMA_TOO_NEW');
    } finally {
      await prisma.$executeRawUnsafe(`UPDATE "SchemaCompat" SET "level" = ${SCHEMA_COMPAT_LEVEL}`);
    }
    await agent(app).raw.get('/health/ready').expect(200);
  });
});

describe('resource monitoring', () => {
  it('platform admins get a live snapshot and a history; samples are stored and pruned after 7 days', async () => {
    const root = await setupAdmin(app);
    await prisma.resourceSample.create({ data: { at: new Date(Date.now() - 8 * 86_400_000), data: { old: 1 } } });
    await app.get(ResourcesService).sample();
    expect(await prisma.resourceSample.count()).toBe(1); // the 8-day-old one was pruned
    const r = (await root.get('/admin/resources?hours=24').expect(200)).body;
    expect(r.now.services.api.process.rssBytes).toBeGreaterThan(0);
    expect(Array.isArray(r.now.warnings)).toBe(true);
    expect(r.history).toHaveLength(1);
    expect(r.history[0]).toHaveProperty('hostAvailable');
  });

  it('warns about low NAS memory, a service near its limit, low disk and a full Redis', () => {
    const GB = 1024 ** 3;
    const w = warningsFor({
      host: { totalBytes: 8 * GB, availableBytes: 0.4 * GB, swapTotalBytes: 2 * GB, swapFreeBytes: 0.5 * GB },
      services: { api: { container: { usageBytes: 500 * 1024 ** 2, limitBytes: 512 * 1024 ** 2 } }, worker: { container: { usageBytes: 100, limitBytes: 1000 } } },
      disks: [{ path: '/backups', totalBytes: 100 * GB, freeBytes: 10 * GB }],
      redis: { usedBytes: 120, maxBytes: 128 },
    });
    expect(w.map((x) => x.level)).toEqual(['critical', 'warning', 'critical', 'warning', 'warning']);
    expect(w[0].message).toMatch(/NAS memory almost exhausted/);
    expect(warningsFor({ host: { totalBytes: 8 * GB, availableBytes: 4 * GB, swapTotalBytes: 0, swapFreeBytes: 0 }, services: {}, disks: [] })).toEqual([]);
  });
});
