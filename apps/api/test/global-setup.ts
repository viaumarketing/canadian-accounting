import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * Integration tests run against a real PostgreSQL (embedded binary, no Docker needed).
 * If TEST_DATABASE_URL is set, that database is used instead (CI uses the service container).
 * Migrations are applied with `prisma migrate deploy`, so the real SQL migration is what's tested.
 */
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

export default async function setup() {
  let stop = async () => {};
  let url = process.env.TEST_DATABASE_URL;

  if (!url) {
    const dir = mkdtempSync(join(tmpdir(), 'ca-pg-'));
    const port = await freePort();
    const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'test', password: 'test', port, persistent: false, onLog: () => {}, onError: () => {} });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('ca_test');
    url = `postgresql://test:test@127.0.0.1:${port}/ca_test`;
    stop = async () => {
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  }

  try {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: resolve(__dirname, '../../../packages/database'),
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
  } catch (e) {
    await stop();
    throw new Error(`prisma migrate deploy failed:\n${(e as { stderr?: Buffer }).stderr?.toString().slice(0, 1500)}`);
  }

  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'test';
  process.env.WEB_ORIGIN = 'http://localhost:3000';
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  return stop;
}
