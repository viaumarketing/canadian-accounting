import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { AppConfig, CONFIG } from '../config';

export const QUEUE_NAME = 'shopify';
export const JOB_ATTEMPTS = 5;

/** What runs a sync job. The DB row (ShopifySyncJob) is the source of truth; the queue only triggers it. */
export abstract class SyncQueue {
  abstract enqueue(jobId: string): Promise<void>;
}

@Injectable()
export class SyncQueueImpl extends SyncQueue implements OnModuleDestroy {
  private readonly log = new Logger('SyncQueue');
  private queue?: Queue;
  private conn?: IORedis;
  private runInline?: (id: string) => Promise<void>;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    super();
    if (this.mode() === 'bullmq') {
      this.conn = new IORedis(config.REDIS_URL!, { maxRetriesPerRequest: null });
      this.queue = new Queue(QUEUE_NAME, { connection: this.conn });
    }
  }

  mode(): 'none' | 'inline' | 'bullmq' {
    if (this.config.QUEUE_MODE) return this.config.QUEUE_MODE;
    if (this.config.NODE_ENV === 'test') return 'none';
    return this.config.REDIS_URL ? 'bullmq' : 'inline';
  }

  /** Registered by the sync service (avoids a circular dependency). */
  bindInline(fn: (id: string) => Promise<void>) { this.runInline = fn; }

  async enqueue(jobId: string): Promise<void> {
    const m = this.mode();
    if (m === 'none') return;
    if (m === 'inline') {
      setImmediate(() => void this.runInline?.(jobId).catch((e) => this.log.error(`inline job ${jobId} failed: ${(e as Error).message}`)));
      return;
    }
    // Retries with exponential back-off are BullMQ's job; exhausted jobs stay in the failed set and the DB row ends DEAD.
    await this.queue!.add('sync', { jobId }, { jobId, attempts: JOB_ATTEMPTS, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: 200, removeOnFail: false });
  }

  async onModuleDestroy() {
    await this.queue?.close();
    this.conn?.disconnect();
  }
}
