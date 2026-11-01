import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

// Load the repo-root .env when running locally (Docker injects real env vars).
for (const p of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
  if (existsSync(p)) {
    process.loadEnvFile(p);
    break;
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().int().default(4000),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)'),
  SETUP_TOKEN: z.string().optional(),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().default(24 * 7),
  SESSION_IDLE_HOURS: z.coerce.number().default(12),
  RATE_LIMIT_ENABLED: z.enum(['true', 'false']).optional(),
  SHOPIFY_CLIENT_ID: z.string().optional(),
  SHOPIFY_CLIENT_SECRET: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().default('2026-10'),
  SHOPIFY_REQUEST_ALL_ORDERS: z.enum(['true', 'false']).default('false'),
  /** Public base URL Shopify can reach for webhooks (optional; polling works without it). */
  SHOPIFY_WEBHOOK_BASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().optional(),
  /** none = jobs are only created (tests); inline = run in the API process; bullmq = hand to the worker via Redis */
  QUEUE_MODE: z.enum(['none', 'inline', 'bullmq']).optional(),
  PLAID_CLIENT_ID: z.string().optional(),
  PLAID_SECRET: z.string().optional(),
  PLAID_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  PLAID_REDIRECT_URI: z.string().url().optional(),
  /** Read-only mount of the backup directory, used for the backup-status panel. */
  BACKUP_DIR: z.string().optional(),
  /** Where uploaded documents (bank statement files) are stored. Unset = kept inside PostgreSQL (development and tests). */
  DOCUMENTS_DIR: z.string().optional(),
  /** Data folders whose free space the resource dashboard reports (comma-separated mount points). */
  MONITOR_PATHS: z.string().optional(),
  /** Background work limits, sized for a small NAS (Intel N100, 8 GB). */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  /** Pending + running sync jobs, platform-wide, above which new work is refused (manual) or skipped (scheduled). */
  SYNC_MAX_BACKLOG: z.coerce.number().int().min(1).default(20),
  /** Bank-feed pages fetched per connection per run; the cursor is saved per page, so the next run continues. */
  BANK_MAX_PAGES_PER_RUN: z.coerce.number().int().min(1).default(40),
  /** The worker stops taking new jobs while its memory use is above this share of its container limit. */
  WORKER_MEMORY_PAUSE_PCT: z.coerce.number().min(50).max(99).default(85),
  GIT_SHA: z.string().optional(),
  BUILD_TIME: z.string().optional(),
  APP_VERSION: z.string().default('dev'),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const blank = (k: string) => env[k] || undefined;
  const parsed = envSchema.safeParse({ ...env, SETUP_TOKEN: blank('SETUP_TOKEN'), SHOPIFY_CLIENT_ID: blank('SHOPIFY_CLIENT_ID'), SHOPIFY_CLIENT_SECRET: blank('SHOPIFY_CLIENT_SECRET'), SHOPIFY_WEBHOOK_BASE_URL: blank('SHOPIFY_WEBHOOK_BASE_URL'), REDIS_URL: blank('REDIS_URL'), QUEUE_MODE: blank('QUEUE_MODE'), BACKUP_DIR: blank('BACKUP_DIR'), DOCUMENTS_DIR: blank('DOCUMENTS_DIR'), MONITOR_PATHS: blank('MONITOR_PATHS'), GIT_SHA: blank('GIT_SHA'), BUILD_TIME: blank('BUILD_TIME'), PLAID_CLIENT_ID: blank('PLAID_CLIENT_ID'), PLAID_SECRET: blank('PLAID_SECRET'), PLAID_REDIRECT_URI: blank('PLAID_REDIRECT_URI') });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${msg}`);
  }
  return parsed.data;
}

export const CONFIG = Symbol('CONFIG');
