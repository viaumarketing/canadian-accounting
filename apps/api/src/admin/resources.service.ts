import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import IORedis from 'ioredis';
import { AppConfig, CONFIG } from '../config';
import { PrismaService } from '../prisma.service';
import { containerMemory, diskSpace, hostMemory, load, processMemory, warningsFor, type ContainerMemory, type ProcessMemory } from '../common/resources';

export type ServiceName = 'api' | 'worker';
interface ServiceStats { name: ServiceName; at: string; container: ContainerMemory | null; process: ProcessMemory; paused?: boolean }

const KEY = (n: string) => `ca:resources:${n}`;
const PUBLISH_MS = 30_000;
const KEEP_DAYS = 7;

/**
 * Resource monitoring for a small NAS. Each Node process (api, worker) publishes its own memory to Redis every 30 s;
 * the worker writes a combined sample to the database every 5 minutes (kept 7 days) and logs low-memory warnings.
 * System administration reads the live snapshot plus the history. No Docker socket is needed or mounted.
 */
@Injectable()
export class ResourcesService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Resources');
  private redis?: IORedis;
  private timer?: NodeJS.Timeout;
  private role: ServiceName = 'api';
  private paused = false;

  constructor(private readonly prisma: PrismaService, @Inject(CONFIG) private readonly config: AppConfig) {}

  /** The worker calls this so its readings are published under its own name. */
  setRole(role: ServiceName) { this.role = role; }
  setPaused(p: boolean) { this.paused = p; }

  onModuleInit() {
    if (!this.config.REDIS_URL || this.config.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.publish().catch(() => undefined), PUBLISH_MS);
    this.timer.unref();
    void this.publish().catch(() => undefined);
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.redis?.disconnect();
  }

  private conn() {
    if (!this.config.REDIS_URL) return null;
    this.redis ??= new IORedis(this.config.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true, connectTimeout: 1500 });
    return this.redis;
  }

  async self(): Promise<ServiceStats> {
    return { name: this.role, at: new Date().toISOString(), container: await containerMemory(), process: processMemory(), ...(this.role === 'worker' ? { paused: this.paused } : {}) };
  }

  async publish() {
    const r = this.conn();
    if (!r) return;
    await r.set(KEY(this.role), JSON.stringify(await this.self()), 'EX', Math.round((PUBLISH_MS * 4) / 1000));
  }

  private async redisInfo() {
    const r = this.conn();
    if (!r) return null;
    try {
      const info = await Promise.race([r.info('memory'), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500))]);
      const num = (k: string) => Number(new RegExp(`^${k}:(\\d+)`, 'm').exec(info)?.[1] ?? NaN);
      const max = num('maxmemory');
      return { usedBytes: num('used_memory'), maxBytes: Number.isFinite(max) && max > 0 ? max : null };
    } catch {
      return null;
    }
  }

  private async peers(): Promise<Partial<Record<ServiceName, ServiceStats>>> {
    const out: Partial<Record<ServiceName, ServiceStats>> = { [this.role]: await this.self() };
    const r = this.conn();
    if (!r) return out;
    for (const n of ['api', 'worker'] as const) {
      if (n === this.role) continue;
      try {
        const v = await Promise.race([r.get(KEY(n)), new Promise<null>((res) => setTimeout(() => res(null), 1500))]);
        if (v) out[n] = JSON.parse(v) as ServiceStats;
      } catch {
        /* missing peer is shown as "no data" */
      }
    }
    return out;
  }

  async snapshot() {
    const paths = [...new Set([...(this.config.MONITOR_PATHS?.split(',').map((p) => p.trim()).filter(Boolean) ?? []), this.config.BACKUP_DIR, this.config.DOCUMENTS_DIR].filter((p): p is string => Boolean(p)))];
    const [host, services, redis, disksAll, db] = await Promise.all([
      hostMemory(),
      this.peers(),
      this.redisInfo(),
      diskSpace(paths),
      this.prisma.$queryRaw<{ size: bigint; conns: bigint }[]>`SELECT pg_database_size(current_database()) AS size, (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS conns`.catch(() => null),
    ]);
    // Several folders usually sit on the same NAS volume: show each volume once.
    const seen = new Set<string>();
    const disks = disksAll.filter((d) => { const k = `${d.totalBytes}:${d.freeBytes}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const warnings = warningsFor({ host, services, disks, redis });
    return {
      at: new Date().toISOString(),
      host: host ? { ...host, ...load() } : null,
      services,
      redis,
      database: db ? { sizeBytes: Number(db[0].size), connections: Number(db[0].conns) } : null,
      disks,
      warnings,
    };
  }

  /** Worker: persist one sample, prune old ones, and put warnings in the log. */
  async sample() {
    const s = await this.snapshot();
    const compact = {
      hostTotal: s.host?.totalBytes ?? null,
      hostAvailable: s.host?.availableBytes ?? null,
      swapUsed: s.host ? s.host.swapTotalBytes - s.host.swapFreeBytes : null,
      load1: s.host?.load1 ?? null,
      api: s.services.api?.container?.usageBytes ?? null,
      worker: s.services.worker?.container?.usageBytes ?? null,
      redis: s.redis?.usedBytes ?? null,
      dbSize: s.database?.sizeBytes ?? null,
      warnings: s.warnings.length,
    };
    await this.prisma.resourceSample.create({ data: { data: compact } });
    await this.prisma.resourceSample.deleteMany({ where: { at: { lt: new Date(Date.now() - KEEP_DAYS * 86_400_000) } } });
    for (const w of s.warnings) this.log.warn(`[${w.level}] ${w.message}`);
    return s;
  }

  async history(hours = 24) {
    const rows = await this.prisma.resourceSample.findMany({ where: { at: { gte: new Date(Date.now() - hours * 3_600_000) } }, orderBy: { at: 'asc' }, take: 2_100 });
    return rows.map((r) => ({ at: r.at, ...(r.data as Record<string, number | null>) }));
  }
}
