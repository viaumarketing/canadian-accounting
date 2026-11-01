import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@ca/database';
import { PASSWORD, agent, bootApp, resetDb, setupAdmin, totp } from './helpers';

let app: INestApplication;
let prisma: PrismaClient;
const dir = mkdtempSync(join(tmpdir(), 'ca-backups-'));
beforeAll(async () => { ({ app, prisma } = await bootApp({ BACKUP_DIR: dir, GIT_SHA: 'abc1234', BUILD_TIME: '2026-10-30T00:00:00Z', QUEUE_MODE: 'none', REDIS_URL: '' })); });
afterAll(async () => { await prisma.$disconnect(); await app.close(); });
beforeEach(() => resetDb(prisma));

type A = ReturnType<typeof agent>;
const NEWPW = 'a-different-long-passphrase';
/** Create a second user (as owner of a new company) and return their login agent. */
async function user(root: A, email: string, companyName = `${email} Co`) {
  await root.post('/admin/companies', { legalName: companyName, province: 'ON', ownerEmail: email, ownerName: email, ownerTemporaryPassword: PASSWORD }).expect(201);
  const a = agent(app);
  await a.post('/auth/login', { email, password: PASSWORD }).expect(200);
  await a.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: NEWPW }).expect(204);
  const row = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { a, id: row.id };
}

describe('user administration', () => {
  it('lists users without any secret material', async () => {
    const root = await setupAdmin(app);
    await user(root, 'u1@example.test');
    const list = (await root.get('/admin/users').expect(200)).body;
    expect(list).toHaveLength(2);
    expect(JSON.stringify(list)).not.toMatch(/passwordHash|mfaSecret|tokenHash|argon2/);
    expect(list.find((u: { email: string }) => u.email === 'u1@example.test')).toMatchObject({ isSuperAdmin: false, isActive: true, companies: 1, activeSessions: 1 });
  });
  it('deactivation signs the user out immediately and blocks login; reactivation restores it', async () => {
    const root = await setupAdmin(app); const u = await user(root, 'u1@example.test');
    await u.a.get('/auth/me').expect(200);
    await root.patch(`/admin/users/${u.id}/active`, { active: false }).expect(204);
    await u.a.get('/auth/me').expect(401);
    await agent(app).post('/auth/login', { email: 'u1@example.test', password: NEWPW }).expect(401);
    await root.patch(`/admin/users/${u.id}/active`, { active: true }).expect(204);
    await agent(app).post('/auth/login', { email: 'u1@example.test', password: NEWPW }).expect(200);
  });
  it('protects against self-lockout and removing the last platform administrator', async () => {
    const root = await setupAdmin(app);
    const me = (await prisma.user.findUniqueOrThrow({ where: { email: 'root@example.test' } })).id;
    expect((await root.patch(`/admin/users/${me}/active`, { active: false })).body.code).toBe('SELF_LOCKOUT');
    expect((await root.patch(`/admin/users/${me}/super-admin`, { value: false })).body.code).toBe('SELF_LOCKOUT');
    const u = await user(root, 'u2@example.test');
    await root.patch(`/admin/users/${u.id}/super-admin`, { value: true }).expect(204);
    await u.a.get('/admin/users').expect(200); // now a platform admin
    // u2 demotes root (allowed: u2 remains an administrator) ...
    await u.a.patch(`/admin/users/${me}/super-admin`, { value: false }).expect(204);
    // ... after which root has no platform access, and u2 is the last administrator: it cannot demote or deactivate itself
    await root.get('/admin/users').expect(403);
    expect((await u.a.patch(`/admin/users/${u.id}/active`, { active: false })).body.code).toBe('SELF_LOCKOUT');
    expect((await u.a.patch(`/admin/users/${u.id}/super-admin`, { value: false })).body.code).toBe('SELF_LOCKOUT');
    // a second admin must exist before the first can be removed by someone else
    await u.a.patch(`/admin/users/${me}/super-admin`, { value: true }).expect(204);
    await root.patch(`/admin/users/${u.id}/super-admin`, { value: false }).expect(204);
    expect((await root.patch(`/admin/users/${me}/super-admin`, { value: false })).body.code).toBe('SELF_LOCKOUT');
  });
  it('promotion requires an active user', async () => {
    const root = await setupAdmin(app); const u = await user(root, 'u1@example.test');
    await root.patch(`/admin/users/${u.id}/active`, { active: false }).expect(204);
    expect((await root.patch(`/admin/users/${u.id}/super-admin`, { value: true })).body.code).toBe('INACTIVE');
  });
  it('temporary password: old one stops working, sessions end, change is forced; the password never reaches the audit log', async () => {
    const root = await setupAdmin(app); const u = await user(root, 'u1@example.test');
    await root.post(`/admin/users/${u.id}/temp-password`, { password: 'short' }).expect(400);
    await root.post(`/admin/users/${u.id}/temp-password`, { password: 'temporary-passphrase-1' }).expect(204);
    await u.a.get('/auth/me').expect(401);
    await agent(app).post('/auth/login', { email: 'u1@example.test', password: NEWPW }).expect(401);
    const a = agent(app);
    await a.post('/auth/login', { email: 'u1@example.test', password: 'temporary-passphrase-1' }).expect(200);
    expect((await a.get('/auth/me').expect(200)).body.mustChangePassword).toBe(true);
    expect(JSON.stringify(await prisma.auditEvent.findMany())).not.toContain('temporary-passphrase-1');
  });
  it('MFA reset removes the authenticator and signs the user out; unlock clears a lockout; revoke ends sessions', async () => {
    const root = await setupAdmin(app); const u = await user(root, 'u1@example.test');
    const enroll = (await u.a.post('/auth/mfa/enroll').expect(201)).body;
    await u.a.post('/auth/mfa/activate', { code: totp(enroll.secret) }).expect(200);
    expect((await agent(app).post('/auth/login', { email: 'u1@example.test', password: NEWPW })).body.code).toBe('MFA_REQUIRED');
    await root.post(`/admin/users/${u.id}/reset-mfa`).expect(204);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect([row.mfaEnabled, row.mfaSecretEnc]).toEqual([false, null]);
    expect(await prisma.recoveryCode.count({ where: { userId: u.id } })).toBe(0);
    await u.a.get('/auth/me').expect(401);
    await agent(app).post('/auth/login', { email: 'u1@example.test', password: NEWPW }).expect(200);
    for (let i = 0; i < 5; i++) await agent(app).post('/auth/login', { email: 'u1@example.test', password: 'wrong-wrong-wrong' }).expect(401);
    expect((await agent(app).post('/auth/login', { email: 'u1@example.test', password: NEWPW })).status).toBe(429);
    await root.post(`/admin/users/${u.id}/unlock`).expect(204);
    const b = agent(app);
    await b.post('/auth/login', { email: 'u1@example.test', password: NEWPW }).expect(200);
    expect((await root.post(`/admin/users/${u.id}/revoke-sessions`).expect(200)).body.revoked).toBeGreaterThan(0);
    await b.get('/auth/me').expect(401);
  });
  it('company deactivation locks members out; every action is audited; non-admins are refused', async () => {
    const root = await setupAdmin(app); const u = await user(root, 'u1@example.test', 'Deactivate Me');
    const co = (await root.get('/admin/companies').expect(200)).body.find((c: { legalName: string }) => c.legalName === 'Deactivate Me');
    const mine = (await u.a.get('/auth/me').expect(200)).body.companies[0].id;
    await u.a.get(`/companies/${mine}/dashboard`).expect(200);
    await root.patch(`/admin/companies/${co.id}/active`, { active: false }).expect(204);
    await u.a.get(`/companies/${mine}/dashboard`).expect(404);
    await root.patch(`/admin/companies/${co.id}/active`, { active: true }).expect(204);
    await u.a.get(`/companies/${mine}/dashboard`).expect(200);
    for (const [m, p, b] of [['get', '/admin/users', undefined], ['get', '/admin/system', undefined], ['patch', `/admin/users/${u.id}/active`, { active: false }], ['post', `/admin/users/${u.id}/reset-mfa`, {}], ['patch', `/admin/companies/${co.id}/active`, { active: false }]] as const) {
      const r = m === 'get' ? await u.a.get(p) : m === 'patch' ? await u.a.patch(p, b) : await u.a.post(p, b);
      expect(r.status, `${m} ${p}`).toBe(403);
    }
    const actions = (await prisma.auditEvent.findMany()).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['admin.company_deactivated', 'admin.company_activated']));
    expect((await root.patch('/admin/users/not-a-uuid/active', { active: true })).status).toBe(400);
    expect((await root.patch('/admin/users/00000000-0000-4000-8000-000000000000/active', { active: true })).status).toBe(404);
  });
});

describe('system status', () => {
  it('reports versions, database, jobs, integrations and security events, with no business data', async () => {
    const root = await setupAdmin(app);
    const s = (await root.get('/admin/system').expect(200)).body;
    expect(s.version).toMatchObject({ gitSha: 'abc1234', builtAt: '2026-10-30T00:00:00Z', environment: 'test' });
    expect(s.version.node).toMatch(/^v\d+/);
    expect(s.database).toMatchObject({ status: 'up' });
    expect(s.database.migrations.applied).toBeGreaterThanOrEqual(5);
    expect(s.database.migrations.failed).toBe(0);
    expect(s.database.sizeBytes).toBeGreaterThan(1_000_000);
    expect(s.jobs.queue.status).toBe('not_configured');
    expect(s.counts).toEqual({ users: 1, companies: 0 });
    expect(Object.keys(s).sort()).toEqual(['backups', 'counts', 'database', 'encryptionKey', 'integrationErrors', 'jobs', 'securityEvents', 'version']);
    expect(JSON.stringify(s)).not.toMatch(/invoice|journal|payout|balance/i);
  });
  it('notices an ENCRYPTION_KEY that does not belong to the database (the classic restore mistake) and fails readiness', async () => {
    const root = await setupAdmin(app);
    expect((await root.get('/admin/system').expect(200)).body.encryptionKey).toMatchObject({ status: 'no_data' });
    const enroll = (await root.post('/auth/mfa/enroll').expect(201)).body;
    await root.post('/auth/mfa/activate', { code: totp(enroll.secret) }).expect(200);
    expect((await root.get('/admin/system').expect(200)).body.encryptionKey).toMatchObject({ status: 'ok', checked: 1, failed: 0 });
    await agent(app).raw.get('/health/ready').expect(200);

    const wrong = Buffer.alloc(32, 9).toString('base64');
    const { app: other } = await bootApp({ ENCRYPTION_KEY: wrong, QUEUE_MODE: 'none', REDIS_URL: '' });
    try {
      const r = await agent(other).raw.get('/health/ready');
      expect(r.status).toBe(503);
      expect(r.body).toMatchObject({ code: 'ENCRYPTION_KEY_MISMATCH' });
      expect(r.body.message).toMatch(/ENCRYPTION_KEY/);
    } finally {
      await other.close();
    }
  });
  it('shows integration errors and dead jobs', async () => {
    const root = await setupAdmin(app);
    const c = (await root.post('/admin/companies', { legalName: 'Err Co', province: 'ON', ownerEmail: 'root@example.test' }).expect(201)).body;
    const store = await prisma.shopifyStore.create({ data: { companyId: c.id, shopDomain: 'broken.myshopify.com', status: 'ERROR', accessTokenEnc: 'x', apiVersion: '2026-10', currency: 'CAD', lastError: 'Shopify rejected the access token (401)' } });
    await prisma.shopifySyncJob.create({ data: { companyId: c.id, storeId: store.id, kind: 'INCREMENTAL', status: 'DEAD', error: 'boom' } });
    await prisma.bankProviderConnection.create({ data: { companyId: c.id, provider: 'plaid', providerItemId: 'item-x', accessTokenEnc: 'x', status: 'ERROR', lastError: 'ITEM_LOGIN_REQUIRED', institutionName: 'Test Bank' } });
    const s = (await root.get('/admin/system').expect(200)).body;
    expect(s.integrationErrors.shopify[0]).toMatchObject({ shopDomain: 'broken.myshopify.com', lastError: expect.stringMatching(/401/), company: { legalName: 'Err Co' } });
    expect(s.integrationErrors.banking[0]).toMatchObject({ provider: 'plaid', status: 'ERROR' });
    expect(s.jobs.shopifyLast24h).toMatchObject({ DEAD: 1 });
    expect(s.jobs.deadLast7d[0].error).toBe('boom');
    expect(JSON.stringify(s)).not.toMatch(/accessTokenEnc/);
  });
  it('backup status: missing, ok, stale; unrelated files are ignored', async () => {
    const root = await setupAdmin(app);
    expect((await root.get('/admin/system').expect(200)).body.backups.status).toBe('missing');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, 'ca-20261001-020000.sql.gz.enc.partial'), 'x');
    expect((await root.get('/admin/system').expect(200)).body.backups.status).toBe('missing');
    writeFileSync(join(dir, 'ca-20261029-020000.sql.gz.enc'), Buffer.alloc(2048));
    const ok = (await root.get('/admin/system').expect(200)).body.backups;
    expect(ok).toMatchObject({ status: 'ok', count: 1, totalBytes: 2048 });
    const old = new Date(Date.now() - 50 * 3_600_000);
    utimesSync(join(dir, 'ca-20261029-020000.sql.gz.enc'), old, old);
    const stale = (await root.get('/admin/system').expect(200)).body.backups;
    expect(stale.status).toBe('stale');
    expect(stale.latest.ageHours).toBeGreaterThan(48);
    expect(stale.note).toMatch(/older than 36 hours/);
  });
  it('lists security events from the audit trail', async () => {
    const root = await setupAdmin(app);
    await agent(app).post('/auth/login', { email: 'root@example.test', password: 'wrong-wrong-wrong' }).expect(401);
    const s = (await root.get('/admin/system').expect(200)).body;
    expect(s.securityEvents.some((e: { action: string }) => e.action === 'auth.login_failed')).toBe(true);
  });
});
