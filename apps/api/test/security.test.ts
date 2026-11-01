import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import type { PrismaClient } from '@ca/database';
import { COMPANY_ROLES, roleHasPermission, type CompanyRole, type Permission } from '@ca/shared';
import { IS_PUBLIC, PERMISSION, SKIP_CSRF, SUPER_ADMIN_ONLY } from '../src/auth/decorators';
import { PASSWORD, agent, bootApp, resetDb, setupAdmin } from './helpers';

/**
 * These tests are generated from Nest's own route table, so a route added later is covered
 * automatically — and a new *public* or permission-less company route fails the build until a
 * human has looked at it (see the allowlists below).
 */

interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string; // e.g. /companies/:companyId/accounts/:id
  isPublic: boolean;
  superAdminOnly: boolean;
  skipCsrf: boolean;
  permission?: Permission;
  company: boolean;
}

const METHODS: Record<number, Route['method'] | undefined> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
};

function discoverRoutes(app: INestApplication): Route[] {
  const routes: Route[] = [];
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype as (new (...a: never[]) => object) | null;
      if (!cls) continue;
      const base = Reflect.getMetadata('path', cls) ?? '';
      const proto = cls.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (typeof handler !== 'function' || name === 'constructor') continue;
        const m = Reflect.getMetadata('method', handler) as number | undefined;
        if (m === undefined) continue;
        const method = METHODS[m];
        if (!method) throw new Error(`unexpected HTTP method on ${cls.name}.${name}`);
        const sub = Reflect.getMetadata('path', handler) ?? '';
        const path = ('/' + [base, sub].flatMap((p) => String(p).split('/')).filter(Boolean).join('/')).replace(/\/$/, '') || '/';
        const meta = <T>(k: string) => (Reflect.getMetadata(k, handler) ?? Reflect.getMetadata(k, cls)) as T | undefined;
        routes.push({
          method,
          path,
          isPublic: !!meta<boolean>(IS_PUBLIC),
          superAdminOnly: !!meta<boolean>(SUPER_ADMIN_ONLY),
          skipCsrf: !!meta<boolean>(SKIP_CSRF),
          permission: meta<Permission>(PERMISSION),
          company: path.includes(':companyId'),
        });
      }
    }
  }
  return routes;
}

const NIL_UUID = '00000000-0000-4000-8000-000000000000';
const fill = (path: string, companyId: string) =>
  path.replace(/:(\w+)/g, (_, k: string) => (k === 'companyId' ? companyId : k.toLowerCase().includes('key') ? 'sales-summary' : NIL_UUID));

let app: INestApplication;
let prisma: PrismaClient;
let routes: Route[];

beforeAll(async () => {
  ({ app, prisma } = await bootApp());
  routes = discoverRoutes(app);
});
afterAll(async () => {
  await prisma.$disconnect();
  await app.close();
});
beforeEach(() => resetDb(prisma));

async function signIn(email: string) {
  const a = agent(app);
  await a.post('/auth/login', { email, password: PASSWORD }).expect(200);
  await a.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' }).expect(204);
  return a;
}

async function call(a: ReturnType<typeof agent>, r: Route, url: string, extraHeaders: Record<string, string> = {}) {
  const req = a.raw[r.method.toLowerCase() as 'get'](url).set(extraHeaders);
  if (r.method !== 'GET') req.set('Origin', 'http://localhost:3000').send({});
  return req;
}

describe('route inventory', () => {
  it('finds a believable number of routes', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.filter((r) => r.company).length).toBeGreaterThan(80);
  });

  it('the set of routes that need no session is exactly this list (review any change)', () => {
    const pub = routes.filter((r) => r.isPublic).map((r) => `${r.method} ${r.path}`).sort();
    expect(pub).toEqual(
      [
        'GET /health',
        'GET /health/ready',
        'GET /setup/status',
        'POST /setup',
        'POST /auth/login',
        'GET /shopify/callback',
        'POST /webhooks/shopify',
      ].sort(),
    );
  });

  it('company routes without an explicit permission are exactly this list (review any change)', () => {
    const none = routes.filter((r) => r.company && !r.permission).map((r) => `${r.method} ${r.path}`).sort();
    expect(none).toEqual([]);
  });

  it('the permission each route demands is pinned (a changed line must be a deliberate, reviewed edit)', async () => {
    const lines = routes
      .map((r) => `${r.method.padEnd(6)} ${r.path}  ->  ${r.isPublic ? 'PUBLIC' : r.superAdminOnly ? 'SUPER_ADMIN' : r.permission ?? 'ANY_SIGNED_IN_USER'}`)
      .sort();
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./route-permissions.snap.txt');
  });

  it('webhook routes (CSRF-exempt) are exactly this list', () => {
    expect(routes.filter((r) => r.skipCsrf).map((r) => `${r.method} ${r.path}`)).toEqual(['POST /webhooks/shopify']);
  });
});

describe('authentication', () => {
  it('every non-public route answers 401 without a session', async () => {
    const a = agent(app);
    const bad: string[] = [];
    for (const r of routes.filter((x) => !x.isPublic)) {
      const res = await call(a, r, fill(r.path, NIL_UUID));
      if (res.status !== 401) bad.push(`${r.method} ${r.path} -> ${res.status}`);
    }
    expect(bad).toEqual([]);
  });

  it('a forged, expired-looking or malformed session cookie is rejected', async () => {
    for (const token of ['', 'x', 'a'.repeat(64), '../../etc/passwd', "' OR 1=1 --"]) {
      const res = await agent(app).raw.get('/auth/me').set('Cookie', `ca_session=${encodeURIComponent(token)}`);
      expect(res.status).toBe(401);
    }
  });
});

describe('CSRF', () => {
  it('every state-changing, cookie-authenticated route rejects a missing or foreign Origin', async () => {
    const root = await setupAdmin(app);
    const bad: string[] = [];
    for (const r of routes.filter((x) => x.method !== 'GET' && !x.isPublic && !x.skipCsrf)) {
      const url = fill(r.path, NIL_UUID);
      for (const headers of [{}, { Origin: 'https://evil.example' }]) {
        const res = await root.raw[r.method.toLowerCase() as 'post'](url).set(headers).send({});
        if (res.status !== 403 || res.body?.code !== 'CSRF') bad.push(`${r.method} ${r.path} ${JSON.stringify(headers)} -> ${res.status}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('tenant isolation (generated from the route table)', () => {
  it('an authenticated outsider — including a platform super admin — gets 404 on every company route', async () => {
    const root = await setupAdmin(app);
    // Company the super admin is NOT a member of.
    const c = (
      await root
        .post('/admin/companies', { legalName: 'Isolated Co', province: 'ON', ownerEmail: 'owner@example.test', ownerName: 'Owner', ownerTemporaryPassword: PASSWORD })
        .expect(201)
    ).body;
    const before = await prisma.account.count({ where: { companyId: c.id } });
    const bad: string[] = [];
    for (const r of routes.filter((x) => x.company)) {
      const res = await call(root, r, fill(r.path, c.id));
      if (res.status !== 404) bad.push(`${r.method} ${r.path} -> ${res.status}`);
    }
    expect(bad).toEqual([]);
    // Nothing was created or changed behind the 404s.
    expect(await prisma.account.count({ where: { companyId: c.id } })).toBe(before);
    expect(await prisma.journalEntry.count({ where: { companyId: c.id } })).toBe(0);
  });

  it('a member of company A cannot reach company B by id on any route', async () => {
    const root = await setupAdmin(app);
    const mk = async (name: string, ownerEmail: string) =>
      (await root.post('/admin/companies', { legalName: name, province: 'ON', ownerEmail, ownerName: name, ownerTemporaryPassword: PASSWORD }).expect(201)).body;
    const a = await mk('Company A', 'a@example.test');
    const b = await mk('Company B', 'b@example.test');
    const ownerA = await signIn('a@example.test');
    // Seed one real record in B, then try to read/modify it through A's URL space and B's.
    const ownerB = await signIn('b@example.test');
    const acct = (await ownerB.post(`/companies/${b.id}/accounts`, { code: '9999', name: 'B secret', type: 'EXPENSE' }).expect(201)).body;
    await ownerA.get(`/companies/${a.id}/accounts/${acct.id}`).expect(404);
    await ownerA.patch(`/companies/${a.id}/accounts/${acct.id}`, { name: 'pwned' }).expect(404);
    await ownerA.get(`/companies/${b.id}/accounts`).expect(404);
    const list = (await ownerA.get(`/companies/${a.id}/accounts`).expect(200)).body as { id: string }[];
    expect(list.find((x) => x.id === acct.id)).toBeUndefined();
    expect((await prisma.account.findUnique({ where: { id: acct.id } }))?.name).toBe('B secret');
  });
});

describe('role matrix (generated from permission metadata)', () => {
  it('every role is allowed exactly the routes the permission matrix says, on every company route', async () => {
    const root = await setupAdmin(app);
    const c = (
      await root
        .post('/admin/companies', { legalName: 'Matrix Co', province: 'ON', ownerEmail: 'matrix-owner@example.test', ownerName: 'Owner', ownerTemporaryPassword: PASSWORD })
        .expect(201)
    ).body;
    const owner = await signIn('matrix-owner@example.test');
    const agents = {} as Record<CompanyRole, ReturnType<typeof agent>>;
    for (const role of COMPANY_ROLES) {
      if (role === 'OWNER') {
        agents[role] = owner;
        continue;
      }
      const email = `${role.toLowerCase()}@example.test`;
      await owner.post(`/companies/${c.id}/members`, { email, name: role, role, temporaryPassword: PASSWORD }).expect(201);
      agents[role] = await signIn(email);
    }
    const bad: string[] = [];
    // Sequential on purpose: some allowed calls (with an empty body) are rejected by validation, none should succeed in a harmful way.
    for (const role of COMPANY_ROLES) {
      for (const r of routes.filter((x) => x.company && x.permission)) {
        const allowed = roleHasPermission(role, r.permission!);
        const res = await call(agents[role], r, fill(r.path, c.id));
        const denied = res.status === 403 && res.body?.code === 'FORBIDDEN';
        if (allowed && (denied || res.status === 401)) bad.push(`${role} should be ALLOWED ${r.method} ${r.path} (${r.permission}) -> ${res.status}`);
        if (!allowed && !denied) bad.push(`${role} should be DENIED ${r.method} ${r.path} (${r.permission}) -> ${res.status}`);
      }
    }
    expect(bad).toEqual([]);
  }, 300_000);

  it('platform-admin routes refuse ordinary users', async () => {
    const root = await setupAdmin(app);
    await root
      .post('/admin/companies', { legalName: 'Any Co', province: 'ON', ownerEmail: 'plain@example.test', ownerName: 'Plain', ownerTemporaryPassword: PASSWORD })
      .expect(201);
    const plain = await signIn('plain@example.test');
    const bad: string[] = [];
    for (const r of routes.filter((x) => x.superAdminOnly)) {
      const res = await call(plain, r, fill(r.path, NIL_UUID));
      if (res.status !== 403) bad.push(`${r.method} ${r.path} -> ${res.status}`);
    }
    expect(bad).toEqual([]);
    expect(routes.filter((x) => x.superAdminOnly).length).toBeGreaterThan(5);
  });
});

describe('permission checks made inside handlers (invisible to the route table)', () => {
  it('payments need sales:post / purchases:post and journals need journal:post to post, even with a valid body', async () => {
    const root = await setupAdmin(app);
    const c = (
      await root
        .post('/admin/companies', { legalName: 'Inline Co', province: 'ON', ownerEmail: 'inline-owner@example.test', ownerName: 'Owner', ownerTemporaryPassword: PASSWORD })
        .expect(201)
    ).body;
    const owner = await signIn('inline-owner@example.test');
    const payment = (direction: string) => ({
      direction,
      contactId: NIL_UUID,
      bankAccountId: NIL_UUID,
      date: '2026-01-15',
      amount: '10.00',
      allocations: [{ documentId: NIL_UUID, amount: '10.00' }],
    });
    const journal = { date: '2026-01-15', memo: 'x', post: true, lines: [{ accountId: NIL_UUID, debit: '1.00' }, { accountId: NIL_UUID, credit: '1.00' }] };
    const bad: string[] = [];
    for (const role of ['AUDITOR', 'BOOKKEEPER', 'FINANCE_MANAGER', 'ACCOUNTANT'] as const) {
      const email = `inline-${role.toLowerCase()}@example.test`;
      await owner.post(`/companies/${c.id}/members`, { email, name: role, role, temporaryPassword: PASSWORD }).expect(201);
      const a = await signIn(email);
      for (const [dir, perm] of [['RECEIPT', 'sales:post'], ['DISBURSEMENT', 'purchases:post']] as const) {
        const res = await a.post(`/companies/${c.id}/payments`, payment(dir));
        const denied = res.status === 403 && res.body?.code === 'FORBIDDEN';
        if (roleHasPermission(role, 'banking:view') && denied === roleHasPermission(role, perm)) bad.push(`${role} ${dir} -> ${res.status}`);
      }
      const j = await a.post(`/companies/${c.id}/journals`, journal);
      const denied = j.status === 403 && j.body?.code === 'FORBIDDEN';
      if (roleHasPermission(role, 'journal:create') && denied === roleHasPermission(role, 'journal:post')) bad.push(`${role} journal(post) -> ${j.status}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('input hostility', () => {
  it('SQL-looking and oversized input does not produce a 500', async () => {
    const root = await setupAdmin(app);
    for (const email of ["x'; DROP TABLE \"User\"; --@example.test", 'a'.repeat(5000) + '@example.test']) {
      const res = await agent(app).post('/auth/login', { email, password: 'whatever-long-password' });
      expect([400, 401]).toContain(res.status);
    }
    expect((await root.get('/auth/me')).status).toBe(200);
    const big = await root.raw.post('/admin/companies').set('Origin', 'http://localhost:3000').send({ legalName: 'x'.repeat(2_000_000) });
    expect([400, 413]).toContain(big.status);
  });

  it('error responses never leak stack traces or SQL', async () => {
    const root = await setupAdmin(app);
    const res = await root.get('/companies/not-a-uuid/accounts');
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+.*\(|prisma|SELECT |node_modules/i);
  });
});

describe('response headers', () => {
  it('API responses carry the helmet defaults and no server banner', async () => {
    const res = await agent(app).raw.get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBeDefined();
  });
});
