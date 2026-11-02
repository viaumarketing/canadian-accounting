import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { buildAppModule } from './app.module';
import { loadConfig } from './config';
import { QUEUE_NAME } from './shopify/queue';
import { ShopifySyncService } from './shopify/sync.service';
import { ConnectionsService } from './banking/connections.service';
import { AutomationService } from './billing/automation.service';
import { PrismaService } from './prisma.service';
import { schemaCompat } from './common/schema-compat';
import { ResourcesService } from './admin/resources.service';
import { containerMemory, pressure, processMemory } from './common/resources';

/**
 * The worker process boots the same Nest modules without HTTP, so sync jobs use exactly the same posting code as the API.
 * BullMQ gives retries with exponential back-off; the ShopifySyncJob row records progress, errors and the DEAD state.
 */
export async function startWorkers() {
  const config = loadConfig();
  if (!config.REDIS_URL) throw new Error('REDIS_URL is required for the worker');
  const app = await NestFactory.createApplicationContext(buildAppModule({ ...config, QUEUE_MODE: 'bullmq' }), { logger: ['log', 'warn', 'error'] });
  const compat = await schemaCompat(app.get(PrismaService));
  if (!compat.ok) throw new Error(`Database schema level ${compat.database} is newer than this worker supports (${compat.app}); refusing to run jobs.`);
  const sync = app.get(ShopifySyncService);
  const bank = app.get(ConnectionsService);
  const automation = app.get(AutomationService);
  const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(QUEUE_NAME, { connection });

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === 'schedule') return sync.scheduleAll();
      if (job.name === 'bank-sync') return bank.syncAll();
      // Recurring transactions, late fees and overdue reminders (each idempotent; safe to run again after a crash).
      if (job.name === 'automation') return automation.runAll();
      if (job.name === 'sync') return sync.runJob(job.data.jobId as string, { finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1) });
      throw new Error(`Unknown job ${job.name}`);
    },
    // One job at a time by default: an N100 shares its four cores with PostgreSQL, the web app and the NAS itself.
    { connection, concurrency: config.WORKER_CONCURRENCY },
  );

  // Resource monitoring: publish this process's memory, and every 5 minutes record a sample (with warnings) for System health.
  const resources = app.get(ResourcesService);
  resources.setRole('worker');
  const sampler = setInterval(() => void resources.sample().catch((e) => console.error('resource sample failed', (e as Error).message)), 5 * 60_000);
  void resources.publish().catch(() => undefined);

  // Memory backpressure: stop taking new jobs while this container is close to its limit; resume once it has recovered.
  const pauseAt = config.WORKER_MEMORY_PAUSE_PCT / 100;
  let paused = false;
  const guard = setInterval(() => {
    void (async () => {
      const p = pressure(await containerMemory(), processMemory());
      if (!paused && p >= pauseAt) {
        paused = true;
        resources.setPaused(true);
        console.warn(JSON.stringify({ level: 'warn', service: 'worker', msg: 'memory high: pausing new jobs', pressure: Math.round(p * 100) }));
        await worker.pause(true);
      } else if (paused && p < pauseAt - 0.15) {
        paused = false;
        resources.setPaused(false);
        worker.resume();
        console.log(JSON.stringify({ level: 'info', service: 'worker', msg: 'memory recovered: resuming jobs', pressure: Math.round(p * 100) }));
      }
    })().catch(() => undefined);
  }, 15_000);
  await queue.upsertJobScheduler('schedule-incremental', { every: 15 * 60_000 }, { name: 'schedule' });
  await queue.upsertJobScheduler('schedule-bank-sync', { every: 60 * 60_000 }, { name: 'bank-sync' });
  await queue.upsertJobScheduler('schedule-automation', { every: 60 * 60_000 }, { name: 'automation' });

  return {
    async stop() {
      clearInterval(sampler);
      clearInterval(guard);
      await worker.close();
      await queue.close();
      await app.close();
      connection.disconnect();
    },
  };
}
