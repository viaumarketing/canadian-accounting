'use client';
import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';
import { useApi } from '@/lib/use-api';

interface Mem { usageBytes: number; limitBytes: number | null }
interface Svc { name: string; at: string; container: Mem | null; process: { rssBytes: number; heapUsedBytes: number; heapLimitBytes: number }; paused?: boolean }
interface Warning { level: 'warning' | 'critical'; message: string }
export interface ResourcesData {
  now: {
    at: string;
    host: { totalBytes: number; availableBytes: number; swapTotalBytes: number; swapFreeBytes: number; cpus: number; load1: number; load5: number; load15: number } | null;
    services: Partial<Record<'api' | 'worker', Svc>>;
    redis: { usedBytes: number; maxBytes: number | null } | null;
    database: { sizeBytes: number; connections: number } | null;
    disks: { path: string; totalBytes: number; freeBytes: number }[];
    warnings: Warning[];
  };
  history: { at: string; hostTotal: number | null; hostAvailable: number | null; api: number | null; worker: number | null; load1: number | null }[];
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
const mb = (n: number) => `${Math.round(n / 1024 ** 2)} MB`;
const size = (n: number) => (n >= 1024 ** 3 ? gb(n) : mb(n));

function Meter({ used, total, label }: { used: number; total: number; label: string }) {
  const r = Math.min(used / total, 1);
  const color = r > 0.95 ? 'bg-destructive' : r > 0.85 ? 'bg-warning' : 'bg-primary';
  return (
    <div>
      <div className="flex justify-between text-xs text-muted-foreground"><span>{label}</span><span>{size(used)} / {size(total)} ({Math.round(r * 100)}%)</span></div>
      <div className="mt-1 h-2 rounded bg-secondary" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r * 100)}>
        <div className={`h-2 rounded ${color}`} style={{ width: `${r * 100}%` }} />
      </div>
    </div>
  );
}

/** Warnings banner, shown on every admin tab so low memory or disk is hard to miss. */
export function ResourceWarnings({ warnings }: { warnings: Warning[] }) {
  if (!warnings.length) return null;
  const critical = warnings.some((w) => w.level === 'critical');
  return (
    <div role="alert" className={`rounded-md border p-3 text-sm ${critical ? 'border-destructive/40 bg-destructive/10' : 'border-warning/40 bg-warning/10'}`}>
      <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" aria-hidden /> {critical ? 'Resources critically low' : 'Resources running low'}</p>
      <ul className="mt-1 list-disc pl-6">{warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
    </div>
  );
}

/** Available NAS memory and our two Node services over time, as a small inline SVG chart. */
function History({ h }: { h: ResourcesData['history'] }) {
  const pts = h.filter((p) => p.hostTotal && p.hostAvailable !== null);
  if (pts.length < 2) return <p className="text-sm text-muted-foreground">History appears after the worker has taken a few samples (one every 5 minutes).</p>;
  const W = 600, H = 140, max = Math.max(...pts.map((p) => p.hostTotal!));
  const t0 = new Date(pts[0].at).getTime(), t1 = new Date(pts[pts.length - 1].at).getTime();
  const x = (at: string) => ((new Date(at).getTime() - t0) / Math.max(t1 - t0, 1)) * W;
  const y = (v: number) => H - (v / max) * H;
  const line = (k: 'hostAvailable' | 'api' | 'worker') => pts.filter((p) => p[k] !== null).map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p[k]!).toFixed(1)}`).join(' ');
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-36 w-full" role="img" aria-label="Memory over time">
        <path d={line('hostAvailable')} fill="none" stroke="hsl(var(--primary))" strokeWidth="2" />
        <path d={line('api')} fill="none" stroke="hsl(var(--warning))" strokeWidth="1.5" />
        <path d={line('worker')} fill="none" stroke="hsl(var(--success))" strokeWidth="1.5" />
      </svg>
      <figcaption className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span><span className="mr-1 inline-block h-2 w-3 rounded bg-primary" />NAS memory available</span>
        <span><span className="mr-1 inline-block h-2 w-3 rounded bg-warning" />api</span>
        <span><span className="mr-1 inline-block h-2 w-3 rounded bg-success" />worker</span>
        <span>scale 0 – {gb(max)} · {new Date(t0).toLocaleString('en-CA')} → {new Date(t1).toLocaleString('en-CA')}</span>
      </figcaption>
    </figure>
  );
}

export function Resources() {
  const { data, error, reload } = useApi<ResourcesData>('/admin/resources?hours=24');
  useEffect(() => {
    const t = setInterval(() => void reload(), 30_000);
    return () => clearInterval(t);
  }, [reload]);
  if (error) return <Card><EmptyState title="Could not load resources">{errorMessage(error)}</EmptyState></Card>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const { now } = data;
  const host = now.host;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" onClick={() => void reload()}>Refresh</Button>
        <span className="text-xs text-muted-foreground">Updated {new Date(now.at).toLocaleTimeString('en-CA')} · refreshes every 30 s</span>
      </div>
      <ResourceWarnings warnings={now.warnings} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card><CardHeader><CardTitle>NAS memory</CardTitle></CardHeader><CardContent className="space-y-3">
          {host ? <>
            <Meter label="In use" used={host.totalBytes - host.availableBytes} total={host.totalBytes} />
            {host.swapTotalBytes > 0 && <Meter label="Swap" used={host.swapTotalBytes - host.swapFreeBytes} total={host.swapTotalBytes} />}
            <p className="text-xs text-muted-foreground">{gb(host.availableBytes)} available. Load {host.load1.toFixed(2)} / {host.load5.toFixed(2)} / {host.load15.toFixed(2)} on {host.cpus} cores.</p>
          </> : <p className="text-sm text-muted-foreground">Not available on this host (no /proc/meminfo).</p>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Services</CardTitle></CardHeader><CardContent className="space-y-3">
          {(['api', 'worker'] as const).map((n) => {
            const s = now.services[n];
            if (!s) return <p key={n} className="text-sm text-muted-foreground">{n}: no recent report</p>;
            return (
              <div key={n}>
                {s.container?.limitBytes ? <Meter label={n} used={s.container.usageBytes} total={s.container.limitBytes} /> : <p className="text-xs">{n}: {mb(s.process.rssBytes)} (no container limit)</p>}
                <p className="text-xs text-muted-foreground">heap {mb(s.process.heapUsedBytes)} of {mb(s.process.heapLimitBytes)}</p>
                {s.paused && <Badge tone="warning">paused: memory high, waiting before taking new jobs</Badge>}
              </div>
            );
          })}
          {now.redis && (now.redis.maxBytes ? <Meter label="redis" used={now.redis.usedBytes} total={now.redis.maxBytes} /> : <p className="text-xs">redis: {mb(now.redis.usedBytes)}</p>)}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Storage</CardTitle></CardHeader><CardContent className="space-y-3">
          {now.disks.length ? now.disks.map((d) => <Meter key={d.path} label={`NAS volume (${d.path})`} used={d.totalBytes - d.freeBytes} total={d.totalBytes} />) : <p className="text-sm text-muted-foreground">No data folders mounted.</p>}
          {now.database && <p className="text-xs text-muted-foreground">Database {size(now.database.sizeBytes)} · {now.database.connections} connections</p>}
        </CardContent></Card>
      </div>
      <Card><CardHeader><CardTitle>Last 24 hours</CardTitle></CardHeader><CardContent><History h={data.history} /></CardContent></Card>
    </div>
  );
}
