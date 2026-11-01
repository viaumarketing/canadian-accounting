import { readFile, statfs } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { getHeapStatistics } from 'node:v8';

/**
 * Resource readings for the System health dashboard, taken from inside a container without the Docker socket:
 *  - host memory and load come from /proc (a container sees the host's /proc/meminfo and /proc/loadavg);
 *  - this container's own usage and limit come from its cgroup (v2, with a v1 fallback);
 *  - free space comes from statfs() on mounted NAS folders.
 * Anything unreadable (e.g. on a Mac during development) is returned as null rather than guessed.
 */

export interface HostMemory { totalBytes: number; availableBytes: number; swapTotalBytes: number; swapFreeBytes: number }
export interface ContainerMemory { usageBytes: number; limitBytes: number | null }
export interface ProcessMemory { rssBytes: number; heapUsedBytes: number; heapLimitBytes: number }
export interface DiskSpace { path: string; totalBytes: number; freeBytes: number }

export async function hostMemory(): Promise<HostMemory | null> {
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? NaN) * 1024;
    const m = { totalBytes: kb('MemTotal'), availableBytes: kb('MemAvailable'), swapTotalBytes: kb('SwapTotal'), swapFreeBytes: kb('SwapFree') };
    return Number.isFinite(m.totalBytes) && Number.isFinite(m.availableBytes) ? m : null;
  } catch {
    return null;
  }
}

async function readNum(path: string): Promise<number | null | 'max'> {
  try {
    const v = (await readFile(path, 'utf8')).trim();
    return v === 'max' ? 'max' : Number.isFinite(Number(v)) ? Number(v) : null;
  } catch {
    return null;
  }
}

export async function containerMemory(): Promise<ContainerMemory | null> {
  // cgroup v2 (current Docker and UGOS), then v1
  const usage = (await readNum('/sys/fs/cgroup/memory.current')) ?? (await readNum('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
  if (typeof usage !== 'number') return null;
  let limit = (await readNum('/sys/fs/cgroup/memory.max')) ?? (await readNum('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
  // v1 reports "no limit" as a huge number
  if (limit === 'max' || (typeof limit === 'number' && limit > 2 ** 60)) limit = null;
  return { usageBytes: usage, limitBytes: typeof limit === 'number' ? limit : null };
}

export function processMemory(): ProcessMemory {
  const m = process.memoryUsage();
  return { rssBytes: m.rss, heapUsedBytes: m.heapUsed, heapLimitBytes: getHeapStatistics().heap_size_limit };
}

export async function diskSpace(paths: string[]): Promise<DiskSpace[]> {
  const out: DiskSpace[] = [];
  for (const path of paths) {
    try {
      const s = await statfs(path);
      out.push({ path, totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize });
    } catch {
      /* not mounted here */
    }
  }
  return out;
}

export const load = () => ({ cpus: cpus().length, load1: loadavg()[0], load5: loadavg()[1], load15: loadavg()[2] });

/** Share of the container limit in use (0–1), or of the V8 heap limit when the container has none. */
export function pressure(c: ContainerMemory | null, p: ProcessMemory): number {
  if (c?.limitBytes) return c.usageBytes / c.limitBytes;
  return p.heapUsedBytes / p.heapLimitBytes;
}

export interface Warning { level: 'warning' | 'critical'; message: string }

/** Thresholds for a NAS that also runs its own OS and apps. */
export function warningsFor(s: {
  host: HostMemory | null;
  services: Record<string, { container: ContainerMemory | null } | null>;
  disks: DiskSpace[];
  redis?: { usedBytes: number; maxBytes: number | null } | null;
}): Warning[] {
  const w: Warning[] = [];
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (s.host) {
    const free = s.host.availableBytes / s.host.totalBytes;
    if (free < 0.08 || s.host.availableBytes < 512 * 1024 ** 2) w.push({ level: 'critical', message: `NAS memory almost exhausted: ${gb(s.host.availableBytes)} available of ${gb(s.host.totalBytes)}.` });
    else if (free < 0.15 || s.host.availableBytes < 1024 ** 3) w.push({ level: 'warning', message: `NAS memory is low: ${gb(s.host.availableBytes)} available of ${gb(s.host.totalBytes)}. Stop unused apps or add RAM.` });
    const swapUsed = s.host.swapTotalBytes - s.host.swapFreeBytes;
    if (s.host.swapTotalBytes > 0 && swapUsed / s.host.swapTotalBytes > 0.5) w.push({ level: 'warning', message: `The NAS is swapping heavily (${gb(swapUsed)} of swap in use); expect slowness.` });
  }
  for (const [name, v] of Object.entries(s.services)) {
    const c = v?.container;
    if (!c?.limitBytes) continue;
    const r = c.usageBytes / c.limitBytes;
    if (r > 0.95) w.push({ level: 'critical', message: `${name} is at ${pct(r)} of its memory limit and may be restarted.` });
    else if (r > 0.85) w.push({ level: 'warning', message: `${name} is using ${pct(r)} of its memory limit.` });
  }
  for (const d of s.disks) {
    const r = d.freeBytes / d.totalBytes;
    if (r < 0.05) w.push({ level: 'critical', message: `Almost no free space on ${d.path} (${gb(d.freeBytes)} left). Backups and the database will fail.` });
    else if (r < 0.15) w.push({ level: 'warning', message: `Free space is low on ${d.path}: ${gb(d.freeBytes)} (${pct(r)}).` });
  }
  if (s.redis?.maxBytes && s.redis.usedBytes / s.redis.maxBytes > 0.8) w.push({ level: 'warning', message: `Redis is at ${pct(s.redis.usedBytes / s.redis.maxBytes)} of its memory cap; queued jobs will be refused when it is full.` });
  return w;
}
