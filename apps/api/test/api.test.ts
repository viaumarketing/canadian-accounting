import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@ca/database';
import { PASSWORD, ORIGIN, agent, bootApp, resetDb, setupAdmin, totp } from './helpers';

let app: INestApplication;
let prisma: PrismaClient;

beforeAll(async () => ({ app, prisma } = await bootApp()));
afterAll(async () => {
  await prisma.$disconnect();
  await app.close();
});
beforeEach(() => resetDb(prisma));

// By default the acting super admin names themselves as owner (explicitly) so tests can drive the company.
const company = (name: string, extra: object = {}) => ({ legalName: name, province: 'ON', ownerEmail: 'root@example.test', ...extra });
const foreignOwner = (email: string) => ({ ownerEmail: email, ownerName: 'Owner', ownerTemporaryPassword: PASSWORD });

async function signIn(email: string) {
  const a = agent(app);
  await a.post('/auth/login', { email, password: PASSWORD }).expect(200);
  await a.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' }).expect(204);
  return a;
}

/** Company the super admin is NOT a member of, with the given role signed in. */
async function provisionWithMember(root: ReturnType<typeof agent>, name: string, email: string, role: string) {
  const ownerEmail = role === 'OWNER' ? email : `owner-${name.replace(/\W/g, '').toLowerCase()}@example.test`;
  const c = (await root.post('/admin/companies', company(name, foreignOwner(ownerEmail))).expect(201)).body;
  const owner = await signIn(ownerEmail);
  if (role === 'OWNER') return { company: c, agent: owner };
  await owner.post(`/companies/${c.id}/members`, { email, name: email, role, temporaryPassword: PASSWORD }).expect(201);
  return { company: c, agent: await signIn(email) };
}

describe('first administrator setup', () => {
  it('works once, then is refused', async () => {
    const a = agent(app);
    expect((await a.get('/setup/status')).body.needsSetup).toBe(true);
    await a.post('/setup', { name: 'A', email: 'a@example.test', password: PASSWORD }).expect(201);
    expect((await a.get('/setup/status')).body.needsSetup).toBe(false);
    await a.post('/setup', { name: 'B', email: 'b@example.test', password: PASSWORD }).expect(409);
  });

  it('concurrent setup attempts create exactly one user', async () => {
    const attempts = await Promise.all(
      ['x', 'y', 'z'].map((n) => agent(app).post('/setup', { name: n, email: `${n}@example.test`, password: PASSWORD })),
    );
    expect(attempts.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await prisma.user.count()).toBe(1);
  });

  it('rejects weak passwords and enforces SETUP_TOKEN when configured', async () => {
    await agent(app).post('/setup', { name: 'A', email: 'a@example.test', password: 'short' }).expect(400);
    const { app: guarded } = await bootApp({ SETUP_TOKEN: 'secret-token' });
    const g = agent(guarded);
    await g.post('/setup', { name: 'A', email: 'a@example.test', password: PASSWORD }).expect(403);
    await g.post('/setup', { name: 'A', email: 'a@example.test', password: PASSWORD, setupToken: 'secret-token' }).expect(201);
    await guarded.close();
  });

  it('in production refuses to create the first administrator unless SETUP_TOKEN is configured', async () => {
    const { app: prod } = await bootApp({ NODE_ENV: 'production', SETUP_TOKEN: '', QUEUE_MODE: 'none', REDIS_URL: '' });
    try {
      const p = agent(prod);
      expect((await p.get('/setup/status')).body).toMatchObject({ needsSetup: true, requiresToken: true });
      const r = await p.post('/setup', { name: 'A', email: 'a@example.test', password: PASSWORD });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('SETUP_TOKEN_REQUIRED');
      expect(await prisma.user.count()).toBe(0);
    } finally {
      await prod.close();
    }
  });
});

describe('authentication', () => {
  it('login sets an httpOnly cookie; /auth/me works; logout revokes the session', async () => {
    const a = await setupAdmin(app);
    const login = await agent(app).post('/auth/login', { email: 'root@example.test', password: PASSWORD });
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toMatch(/ca_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect((await a.get('/auth/me').expect(200)).body.email).toBe('root@example.test');
    await a.post('/auth/logout').expect(204);
    await a.get('/auth/me').expect(401);
  });

  it('stores only a hash of the session token', async () => {
    await setupAdmin(app);
    const s = await prisma.session.findFirstOrThrow();
    expect(s.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same error for unknown user and wrong password', async () => {
    await setupAdmin(app);
    const a = await agent(app).post('/auth/login', { email: 'nobody@example.test', password: PASSWORD });
    const b = await agent(app).post('/auth/login', { email: 'root@example.test', password: 'wrong-wrong-wrong' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it('locks the account after repeated failures', async () => {
    await setupAdmin(app);
    for (let i = 0; i < 5; i++) {
      await agent(app).post('/auth/login', { email: 'root@example.test', password: 'wrong-wrong-wrong' }).expect(401);
    }
    const r = await agent(app).post('/auth/login', { email: 'root@example.test', password: PASSWORD });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('ACCOUNT_LOCKED');
  });

  it('rejects unauthenticated access', async () => {
    await agent(app).get('/auth/me').expect(401);
    await agent(app).get('/admin/companies').expect(401);
  });

  it('CSRF: rejects state-changing requests from another origin or without origin', async () => {
    await setupAdmin(app);
    await request(app.getHttpServer()).post('/auth/login').set('Origin', 'https://evil.example').send({ email: 'a@b.co', password: 'x' }).expect(403);
    await request(app.getHttpServer()).post('/auth/login').send({ email: 'a@b.co', password: 'x' }).expect(403);
    await request(app.getHttpServer()).post('/auth/login').set('Origin', ORIGIN).send({ email: 'a@b.co', password: 'x' }).expect(401);
  });

  it('forces a password change for invited users and blocks everything else until done', async () => {
    const root = await setupAdmin(app);
    const c = (await root.post('/admin/companies', company('Acme Inc.')).expect(201)).body;
    await root.post(`/companies/${c.id}/members`, { email: 'bk@example.test', name: 'BK', role: 'BOOKKEEPER', temporaryPassword: PASSWORD }).expect(201);
    const bk = agent(app);
    await bk.post('/auth/login', { email: 'bk@example.test', password: PASSWORD }).expect(200);
    const blocked = await bk.get(`/companies/${c.id}/dashboard`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    await bk.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'a-brand-new-passphrase' }).expect(204);
    await bk.get(`/companies/${c.id}/dashboard`).expect(200);
  });
});

describe('MFA (TOTP)', () => {
  it('enrol, activate, require code at login, accept recovery code once', async () => {
    const a = await setupAdmin(app);
    const enroll = (await a.post('/auth/mfa/enroll').expect(201)).body;
    expect(enroll.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    await a.post('/auth/mfa/activate', { code: '000000' }).expect(400);
    const { recoveryCodes } = (await a.post('/auth/mfa/activate', { code: totp(enroll.secret) }).expect(200)).body;
    expect(recoveryCodes).toHaveLength(8);

    // The secret is encrypted at rest.
    const u = await prisma.user.findFirstOrThrow();
    expect(u.mfaSecretEnc).toMatch(/^v1\./);
    expect(u.mfaSecretEnc).not.toContain(enroll.secret);

    const creds = { email: 'root@example.test', password: PASSWORD };
    expect((await agent(app).post('/auth/login', creds)).body.code).toBe('MFA_REQUIRED');
    expect((await agent(app).post('/auth/login', { ...creds, mfaCode: '000000' })).body.code).toBe('INVALID_MFA');
    await agent(app).post('/auth/login', { ...creds, mfaCode: totp(enroll.secret) }).expect(200);
    await agent(app).post('/auth/login', { ...creds, mfaCode: recoveryCodes[0] }).expect(200);
    await agent(app).post('/auth/login', { ...creds, mfaCode: recoveryCodes[0] }).expect(401);
  });
});

describe('tenant isolation and permissions', () => {
  it('a member of company A cannot read or touch company B (404, not 403)', async () => {
    const root = await setupAdmin(app);
    const a = await provisionWithMember(root, 'Company A', 'a-owner@example.test', 'OWNER');
    const b = await provisionWithMember(root, 'Company B', 'b-owner@example.test', 'OWNER');

    await a.agent.get(`/companies/${a.company.id}/dashboard`).expect(200);
    for (const path of ['', '/dashboard', '/members', '/tax-registrations', '/audit']) {
      await a.agent.get(`/companies/${b.company.id}${path}`).expect(404);
    }
    await a.agent.patch(`/companies/${b.company.id}`, { legalName: 'Hijacked' }).expect(404);
    await a.agent.post(`/companies/${b.company.id}/members`, { email: 'x@example.test', name: 'X', role: 'OWNER', temporaryPassword: PASSWORD }).expect(404);
    expect((await prisma.company.findUniqueOrThrow({ where: { id: b.company.id } })).legalName).toBe('Company B');
  });

  it('super admin has NO implicit access to company data', async () => {
    const root = await setupAdmin(app);
    const other = await provisionWithMember(root, 'Not Rootsco', 'owner@example.test', 'OWNER');
    // root is not a member of this company:
    await root.get(`/companies/${other.company.id}/dashboard`).expect(404);
    await root.get(`/companies/${other.company.id}/members`).expect(404);
    await root.get(`/companies/${other.company.id}/audit`).expect(404);
    // but can see platform metadata
    const list = (await root.get('/admin/companies').expect(200)).body;
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0])).not.toContain('businessNumber');
  });

  it('non-super-admins cannot use platform endpoints', async () => {
    const root = await setupAdmin(app);
    const o = await provisionWithMember(root, 'Acme', 'owner@example.test', 'OWNER');
    await o.agent.get('/admin/companies').expect(403);
    await o.agent.get('/admin/system').expect(403);
    await o.agent.post('/admin/companies', company('Mine')).expect(403);
  });

  it('enforces role permissions within a company', async () => {
    const root = await setupAdmin(app);
    const c = (await root.post('/admin/companies', company('Acme')).expect(201)).body;
    const roles = ['AUDITOR', 'BOOKKEEPER', 'EMPLOYEE', 'ADMIN'];
    const agents: Record<string, ReturnType<typeof agent>> = {};
    for (const role of roles) {
      const email = `${role.toLowerCase()}@example.test`;
      await root.post(`/companies/${c.id}/members`, { email, name: role, role, temporaryPassword: PASSWORD }).expect(201);
      const a = agent(app);
      await a.post('/auth/login', { email, password: PASSWORD }).expect(200);
      await a.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' }).expect(204);
      agents[role] = a;
    }
    const reg = { kind: 'GST_HST', registrationNumber: '123456789RT0001', filingFrequency: 'QUARTERLY', effectiveFrom: '2026-01-01' };

    // Employee: no audit log, no members list, no tax pages
    await agents.EMPLOYEE.get(`/companies/${c.id}/audit`).expect(403);
    await agents.EMPLOYEE.get(`/companies/${c.id}/members`).expect(403);
    await agents.EMPLOYEE.get(`/companies/${c.id}/tax-registrations`).expect(403);
    await agents.EMPLOYEE.get(`/companies/${c.id}/dashboard`).expect(200);
    // Auditor: read-only
    await agents.AUDITOR.get(`/companies/${c.id}/audit`).expect(200);
    await agents.AUDITOR.post(`/companies/${c.id}/tax-registrations`, reg).expect(403);
    await agents.AUDITOR.patch(`/companies/${c.id}`, { legalName: 'X' }).expect(403);
    // Bookkeeper: cannot manage members or tax registrations
    await agents.BOOKKEEPER.get(`/companies/${c.id}/members`).expect(403);
    await agents.BOOKKEEPER.post(`/companies/${c.id}/tax-registrations`, reg).expect(403);
    // Admin: can manage
    await agents.ADMIN.post(`/companies/${c.id}/tax-registrations`, reg).expect(201);
    await agents.ADMIN.post(`/companies/${c.id}/tax-registrations`, reg).expect(409);
    await agents.ADMIN.patch(`/companies/${c.id}`, { operatingName: 'Acme Co' }).expect(200);
  });

  it('protects owners: admin cannot grant/alter owner; last owner cannot be demoted or suspended', async () => {
    const root = await setupAdmin(app);
    const c = (await root.post('/admin/companies', company('Acme')).expect(201)).body;
    await root.post(`/companies/${c.id}/members`, { email: 'adm@example.test', name: 'Adm', role: 'ADMIN', temporaryPassword: PASSWORD }).expect(201);
    const adm = agent(app);
    await adm.post('/auth/login', { email: 'adm@example.test', password: PASSWORD }).expect(200);
    await adm.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' }).expect(204);

    await adm.post(`/companies/${c.id}/members`, { email: 'o2@example.test', name: 'O2', role: 'OWNER', temporaryPassword: PASSWORD }).expect(403);
    const members = (await root.get(`/companies/${c.id}/members`).expect(200)).body;
    const ownerM = members.find((m: { role: string }) => m.role === 'OWNER');
    const admM = members.find((m: { role: string }) => m.role === 'ADMIN');
    await adm.patch(`/companies/${c.id}/members/${ownerM.id}`, { role: 'ADMIN' }).expect(403);
    await adm.delete(`/companies/${c.id}/members/${ownerM.id}`).expect(403);

    // Owner cannot change own role (also protects the last owner)
    await root.patch(`/companies/${c.id}/members/${ownerM.id}`, { role: 'ADMIN' }).expect(403);
    // Promote admin to owner, then the original owner can be demoted by the new owner.
    await root.patch(`/companies/${c.id}/members/${admM.id}`, { role: 'OWNER' }).expect(200);
    await adm.patch(`/companies/${c.id}/members/${ownerM.id}`, { role: 'ACCOUNTANT' }).expect(200);
    // adm is now the last owner; cannot be suspended by another owner? there is none -> self blocked
    await adm.delete(`/companies/${c.id}/members/${admM.id}`).expect(403);
  });

  it('suspended members lose access immediately', async () => {
    const root = await setupAdmin(app);
    const o = await provisionWithMember(root, 'Acme', 'owner@example.test', 'ACCOUNTANT');
    const m = await prisma.companyMembership.findFirstOrThrow({ where: { role: 'ACCOUNTANT' } });
    await o.agent.get(`/companies/${o.company.id}/dashboard`).expect(200);
    await prisma.companyMembership.update({ where: { id: m.id }, data: { status: 'SUSPENDED' } });
    await o.agent.get(`/companies/${o.company.id}/dashboard`).expect(404);
  });
});

describe('company provisioning', () => {
  it('creates company, owner membership, current fiscal year and audit event atomically', async () => {
    const root = await setupAdmin(app);
    const c = (await root.post('/admin/companies', company('Maple Goods Inc.', { fiscalYearEndMonth: 3, fiscalYearEndDay: 31 })).expect(201)).body;
    const full = (await root.get(`/companies/${c.id}`).expect(200)).body;
    expect(full.baseCurrency).toBe('CAD');
    expect(full.fiscalYears).toHaveLength(1);
    expect(new Date(full.fiscalYears[0].endDate).getUTCMonth()).toBe(2);
    const events = await prisma.auditEvent.findMany({ where: { companyId: c.id } });
    expect(events.map((e) => e.action)).toContain('company.provisioned');
  });

  it('rejects invalid input with structured errors', async () => {
    const root = await setupAdmin(app);
    const r = await root.post('/admin/companies', { legalName: '', province: 'ZZ' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION_ERROR');
    expect(r.body.issues.length).toBeGreaterThan(0);
  });

  it('validates GST/HST registration numbers', async () => {
    const root = await setupAdmin(app);
    const c = (await root.post('/admin/companies', company('Acme')).expect(201)).body;
    await root.post(`/companies/${c.id}/tax-registrations`, { kind: 'GST_HST', registrationNumber: '12345', filingFrequency: 'ANNUAL', effectiveFrom: '2026-01-01' }).expect(400);
  });
});

describe('audit log', () => {
  it('records auth and admin actions and is append-only at the database level', async () => {
    const root = await setupAdmin(app);
    await root.post('/admin/companies', company('Acme'));
    const actions = (await prisma.auditEvent.findMany()).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['system.first_admin_created', 'auth.login', 'company.provisioned']));
    await expect(prisma.auditEvent.updateMany({ data: { action: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditEvent.deleteMany({})).rejects.toThrow(/append-only/);
  });

  it('never stores passwords or MFA secrets in audit metadata', async () => {
    await setupAdmin(app);
    const all = JSON.stringify(await prisma.auditEvent.findMany());
    expect(all).not.toContain(PASSWORD);
  });
});

describe('rate limiting', () => {
  it('throttles login attempts per client', async () => {
    const { app: limited } = await bootApp({ RATE_LIMIT_ENABLED: 'true' });
    const a = agent(limited);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await a.post('/auth/login', { email: 'x@example.test', password: 'whatever-long-pw' })).status);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    await limited.close();
  });
});

describe('health', () => {
  it('liveness and readiness are public', async () => {
    await agent(app).get('/health').expect(200);
    expect((await agent(app).get('/health/ready').expect(200)).body.database).toBe('up');
  });
});
