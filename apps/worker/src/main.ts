import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { createPrismaClient } from '@ca/database';

/**
 * Two responsibilities:
 *  1. a heartbeat queue proving Redis + PostgreSQL connectivity (system health),
 *  2. the Shopify sync worker, which lives in the API package so it shares the posting code (see apps/api/src/worker-entry.ts).
 */
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ level: 'info', service: 'worker', msg, ...extra }));

async function main() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is required');
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const prisma = createPrismaClient();

  const system = new Queue('system', { connection });
  const heartbeat = new Worker(
    'system',
    async (job) => {
      if (job.name === 'ping') {
        await prisma.$queryRaw`SELECT 1`;
        return { ok: true };
      }
      throw new Error(`Unknown job ${job.name}`);
    },
    { connection },
  );
  heartbeat.on('failed', (job, err) => log('job failed', { job: job?.id, err: err.message }));
  await system.upsertJobScheduler('heartbeat', { every: 60_000 }, { name: 'ping' });

  const entry = '@ca/api/dist/worker-entry';
  const { startWorkers } = (await import(entry)) as { startWorkers: () => Promise<{ stop: () => Promise<void> }> };
  const shopify = await startWorkers();
  log('worker started');

  const shutdown = async (sig: string) => {
    log('shutting down', { sig });
    await shopify.stop();
    await heartbeat.close();
    await system.close();
    await prisma.$disconnect();
    connection.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
