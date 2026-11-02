import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { authenticator } from 'otplib';
import { PrismaClient } from '@ca/database';
import { createApp } from '../src/main';
import { loadConfig } from '../src/config';

export const PASSWORD = 'correct-horse-battery';
export const ORIGIN = 'http://localhost:3000';

export async function bootApp(overrides: Record<string, string> = {}) {
  const app = await createApp(loadConfig({ ...process.env, ...overrides }));
  await app.init();
  const prisma = new PrismaClient();
  return { app, prisma };
}

export async function resetDb(prisma: PrismaClient) {
  // AuditEvent is append-only (trigger); TRUNCATE is also blocked, so disable triggers for the reset.
  await prisma.$executeRawUnsafe('ALTER TABLE "AuditEvent" DISABLE TRIGGER USER');
  await prisma.$executeRawUnsafe('TRUNCATE "AuditEvent","User","Company" RESTART IDENTITY CASCADE');
  await prisma.$executeRawUnsafe('ALTER TABLE "AuditEvent" ENABLE TRIGGER USER');
}

/** A cookie-carrying agent that sends the web origin like a browser would. */
export function agent(app: INestApplication) {
  const a = request.agent(app.getHttpServer());
  return {
    raw: a,
    get: (url: string) => a.get(url),
    post: (url: string, body?: object) => a.post(url).set('Origin', ORIGIN).send(body ?? {}),
    patch: (url: string, body?: object) => a.patch(url).set('Origin', ORIGIN).send(body ?? {}),
    put: (url: string, body?: object) => a.put(url).set('Origin', ORIGIN).send(body ?? {}),
    delete: (url: string) => a.delete(url).set('Origin', ORIGIN),
  };
}

export async function setupAdmin(app: INestApplication, email = 'root@example.test') {
  const a = agent(app);
  await a.post('/setup', { name: 'Root Admin', email, password: PASSWORD }).expect(201);
  await a.post('/auth/login', { email, password: PASSWORD }).expect(200);
  return a;
}

export const totp = (secret: string) => authenticator.generate(secret);
