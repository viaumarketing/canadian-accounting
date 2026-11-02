'use client';
import { useState, type FormEvent } from 'react';
import { CANADIAN_PROVINCES } from '@ca/shared';
import { Shell } from '@/components/shell/shell';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { SessionProvider, useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { ResourceWarnings, Resources, type ResourcesData } from '@/components/admin/resources';

interface Row { id: string; legalName: string; province: string; isActive: boolean; createdAt: string; _count: { memberships: number } }
interface Sys {
  version: { app: string; gitSha: string | null; builtAt: string | null; node: string; environment: string; uptimeSeconds: number };
  database: { status: string; latencyMs: number; sizeBytes?: number; connections?: number; migrations?: { applied: number; lastAppliedAt: string | null; failed: number } };
  counts: { users: number; companies: number };
  jobs: { shopifyLast24h: Record<string, number>; oldestPendingAgeSeconds: number | null; deadLast7d: { id: string; error: string | null; createdAt: string; company: { legalName: string }; store: { shopDomain: string } }[]; queue: { status: string; counts?: Record<string, number> } };
  integrationErrors: { shopify: { id: string; shopDomain: string; status: string; lastError: string | null; company: { legalName: string } }[]; banking: { id: string; provider: string; institutionName: string | null; status: string; lastError: string | null; company: { legalName: string } }[] };
  backups: { status: string; count?: number; totalBytes?: number; latest?: { file: string; at: string; sizeBytes: number; ageHours: number }; note?: string; copy?: { status: string; ageHours?: number; message?: string } };
  encryptionKey: { status: 'ok' | 'mismatch' | 'no_data' | 'unknown'; checked: number; failed: number };
  securityEvents: { id: string; action: string; ip: string | null; createdAt: string }[];
}
const mb = (n?: number) => (n === undefined ? '—' : `${(n / 1_048_576).toFixed(1)} MB`);
const tone = (ok: boolean) => (ok ? 'success' : 'danger') as 'success' | 'danger';

function Companies() {
  const { data, reload } = useApi<Row[]>('/admin/companies');
  const [f, setF] = useState({ legalName: '', province: 'ON', ownerEmail: '', ownerName: '', ownerTemporaryPassword: '' });
  const [err, setErr] = useState<string | null>(null);
  async function create(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await api('/admin/companies', { method: 'POST', body: { ...f, ownerName: f.ownerName || undefined, ownerTemporaryPassword: f.ownerTemporaryPassword || undefined } });
      setF({ ...f, legalName: '', ownerEmail: '', ownerName: '', ownerTemporaryPassword: '' });
      await reload();
    } catch (x) { setErr(errorMessage(x)); }
  }
  return (
    <div className="space-y-4">
      <Card className="overflow-x-auto">
        {data && data.length === 0 ? <EmptyState title="No companies yet">Provision the first company below.</EmptyState> : (
          <table className="w-full text-sm"><thead className="border-b text-left text-muted-foreground"><tr><th className="p-3">Company</th><th className="p-3">Province</th><th className="p-3">Members</th><th className="p-3">Status</th></tr></thead>
            <tbody>{(data ?? []).map((c) => <tr key={c.id} className="border-b last:border-0"><td className="p-3 font-medium">{c.legalName}</td><td className="p-3">{c.province}</td><td className="p-3">{c._count.memberships}</td><td className="p-3"><Badge tone={c.isActive ? 'success' : 'warning'}>{c.isActive ? 'active' : 'inactive'}</Badge></td></tr>)}</tbody></table>
        )}
      </Card>
      <Card><CardHeader><CardTitle>Provision a company</CardTitle></CardHeader><CardContent>
        <p className="mb-3 max-w-2xl text-sm text-muted-foreground">You will <strong>not</strong> get access to the company’s books. Name the owner explicitly; if they have no account yet, one is created with a temporary password they must change at first sign-in. Enter your own email to make yourself a member.</p>
        <form onSubmit={create} className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><FormError message={err} /></div>
          <Field label="Legal name" htmlFor="c-name"><Input id="c-name" required value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} /></Field>
          <Field label="Province / territory" htmlFor="c-prov"><Select id="c-prov" value={f.province} onChange={(e) => setF({ ...f, province: e.target.value })}>{CANADIAN_PROVINCES.map((p) => <option key={p}>{p}</option>)}</Select></Field>
          <Field label="Owner email" htmlFor="c-oe"><Input id="c-oe" type="email" required value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} /></Field>
          <Field label="Owner name (new accounts)" htmlFor="c-on"><Input id="c-on" value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} /></Field>
          <Field label="Temporary password (new accounts)" htmlFor="c-op" hint="Min 12 characters"><Input id="c-op" type="password" autoComplete="new-password" value={f.ownerTemporaryPassword} onChange={(e) => setF({ ...f, ownerTemporaryPassword: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Button type="submit">Provision company</Button></div>
        </form></CardContent></Card>
    </div>
  );
}

function System() {
  const { data, error, reload } = useApi<Sys>('/admin/system');
  if (error) return <FormError message={errorMessage(error)} />;
  if (!data) return null;
  const b = data.backups;
  const failed = Object.entries(data.jobs.shopifyLast24h).filter(([k]) => k === 'FAILED' || k === 'DEAD').reduce((n, [, v]) => n + v, 0);
  return (
    <div className="space-y-4">
      <Button size="sm" variant="outline" onClick={() => void reload()}>Refresh</Button>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Card><CardHeader><CardTitle>Version</CardTitle></CardHeader><CardContent><p className="text-xl font-semibold">{data.version.app}</p><p className="text-xs text-muted-foreground">{data.version.gitSha ? `build ${data.version.gitSha.slice(0, 7)} · ` : ''}Node {data.version.node} · up {Math.round(data.version.uptimeSeconds / 60)} min</p></CardContent></Card>
        <Card><CardHeader><CardTitle>Database</CardTitle></CardHeader><CardContent><div className="flex items-center gap-2"><Badge tone={tone(data.database.status === 'up')}>{data.database.status}</Badge><span className="text-sm">{data.database.latencyMs} ms</span></div><p className="mt-1 text-xs text-muted-foreground">{mb(data.database.sizeBytes)} · {data.database.connections} connections · {data.database.migrations?.applied} migrations{data.database.migrations?.failed ? ` (${data.database.migrations.failed} FAILED)` : ''}</p></CardContent></Card>
        <Card><CardHeader><CardTitle>Backups</CardTitle></CardHeader><CardContent><Badge tone={b.status === 'ok' ? 'success' : b.status === 'not_configured' ? 'neutral' : 'danger'}>{b.status.replace('_', ' ')}</Badge><p className="mt-1 text-xs text-muted-foreground">{b.latest ? `latest ${b.latest.file} · ${b.latest.ageHours} h ago · ${mb(b.latest.sizeBytes)} · ${b.count} kept (${mb(b.totalBytes)})` : b.note}</p>{b.latest && b.note && <p className="text-xs text-destructive">{b.note}</p>}{b.copy && <p className={`mt-1 text-xs ${b.copy.status === 'ok' ? 'text-muted-foreground' : b.copy.status === 'not_configured' ? 'text-warning' : 'text-destructive'}`}>Off-NAS copy: {b.copy.status === 'ok' ? `ok, ${b.copy.ageHours} h ago` : b.copy.status.replace('_', ' ')}{b.copy.status !== 'ok' && b.copy.message ? ` · ${b.copy.message}` : ''}</p>}</CardContent></Card>
        <Card><CardHeader><CardTitle>Background jobs (24 h)</CardTitle></CardHeader><CardContent><div className="flex flex-wrap gap-1">{Object.entries(data.jobs.shopifyLast24h).map(([k, v]) => <Badge key={k} tone={k === 'FAILED' || k === 'DEAD' ? 'danger' : k === 'SUCCEEDED' ? 'success' : 'warning'}>{k.toLowerCase()} {v}</Badge>)}{Object.keys(data.jobs.shopifyLast24h).length === 0 && <span className="text-sm text-muted-foreground">none</span>}</div><p className="mt-1 text-xs text-muted-foreground">Queue: {data.jobs.queue.status.replace('_', ' ')}{data.jobs.queue.counts ? ` · waiting ${data.jobs.queue.counts.waiting} · failed ${data.jobs.queue.counts.failed}` : ''}{data.jobs.oldestPendingAgeSeconds !== null ? ` · oldest pending ${data.jobs.oldestPendingAgeSeconds}s` : ''}{failed ? ` · ${failed} problem(s)` : ''}</p></CardContent></Card>
        <Card><CardHeader><CardTitle>Encryption key</CardTitle></CardHeader><CardContent><Badge tone={data.encryptionKey.status === 'ok' ? 'success' : data.encryptionKey.status === 'mismatch' ? 'danger' : 'neutral'}>{data.encryptionKey.status.replace('_', ' ')}</Badge><p className="mt-1 text-xs text-muted-foreground">{data.encryptionKey.status === 'ok' ? `${data.encryptionKey.checked} stored secret(s) opened with this ENCRYPTION_KEY.` : data.encryptionKey.status === 'mismatch' ? 'ENCRYPTION_KEY cannot open the secrets in this database. Restore the original key from your saved .env.' : 'Nothing encrypted to check yet (no MFA or integrations).'}</p></CardContent></Card>
      </div>
      <Card className="overflow-x-auto"><CardHeader><CardTitle>Integration errors</CardTitle></CardHeader><CardContent>
        {data.integrationErrors.shopify.length + data.integrationErrors.banking.length + data.jobs.deadLast7d.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
          <table className="w-full text-sm"><tbody>
            {data.integrationErrors.shopify.map((x) => <tr key={x.id} className="border-b"><td className="py-2 pr-3">Shopify</td><td className="pr-3">{x.company.legalName} · {x.shopDomain}</td><td className="pr-3"><Badge tone="danger">{x.status.toLowerCase()}</Badge></td><td>{x.lastError}</td></tr>)}
            {data.integrationErrors.banking.map((x) => <tr key={x.id} className="border-b"><td className="py-2 pr-3">Bank</td><td className="pr-3">{x.company.legalName} · {x.institutionName ?? x.provider}</td><td className="pr-3"><Badge tone="danger">{x.status.toLowerCase()}</Badge></td><td>{x.lastError}</td></tr>)}
            {data.jobs.deadLast7d.map((x) => <tr key={x.id} className="border-b"><td className="py-2 pr-3">Dead job</td><td className="pr-3">{x.company.legalName} · {x.store.shopDomain}</td><td className="pr-3">{x.createdAt.slice(0, 16).replace('T', ' ')}</td><td>{x.error}</td></tr>)}
          </tbody></table>)}
      </CardContent></Card>
      <Card className="overflow-x-auto"><CardHeader><CardTitle>Recent security events</CardTitle></CardHeader><CardContent>
        {data.securityEvents.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : <table className="w-full text-sm"><tbody>{data.securityEvents.map((e) => <tr key={e.id} className="border-b last:border-0"><td className="py-2 pr-3 whitespace-nowrap">{new Date(e.createdAt).toLocaleString('en-CA')}</td><td className="py-2 pr-3 font-mono text-xs">{e.action}</td><td className="py-2">{e.ip}</td></tr>)}</tbody></table>}
      </CardContent></Card>
      <p className="text-xs text-muted-foreground">System administration shows operational metadata only. It never shows a company’s ledger, banking or Shopify business data.</p>
    </div>
  );
}

interface UserRow { id: string; email: string; name: string; isSuperAdmin: boolean; isActive: boolean; mfaEnabled: boolean; mustChangePassword: boolean; lastLoginAt: string | null; lockedUntil: string | null; companies: number; activeSessions: number }
function Users() {
  const { me } = useSession();
  const { data, reload, error } = useApi<UserRow[]>('/admin/users');
  const [err, setErr] = useState<string | null>(null);
  const [pw, setPw] = useState<{ id: string; value: string } | null>(null);
  const act = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); await reload(); } catch (x) { setErr(errorMessage(x)); } };
  return (
    <div className="space-y-4">
      <FormError message={err ?? (error ? errorMessage(error) : null)} />
      <Card className="overflow-x-auto"><table className="w-full text-sm">
        <thead className="border-b text-left text-muted-foreground"><tr><th className="p-3">User</th><th className="p-3">Status</th><th className="p-3">MFA</th><th className="p-3">Companies</th><th className="p-3">Last sign-in</th><th className="p-3">Actions</th></tr></thead>
        <tbody>{(data ?? []).map((u) => (
          <tr key={u.id} className="border-b last:border-0 align-top">
            <td className="p-3"><div className="font-medium">{u.name}{u.isSuperAdmin && <Badge tone="warning"> platform admin</Badge>}</div><div className="text-xs text-muted-foreground">{u.email}</div></td>
            <td className="p-3"><Badge tone={u.isActive ? 'success' : 'danger'}>{u.isActive ? 'active' : 'deactivated'}</Badge>{u.lockedUntil && new Date(u.lockedUntil) > new Date() && <Badge tone="warning"> locked</Badge>}{u.mustChangePassword && <div className="text-xs text-muted-foreground">must change password</div>}</td>
            <td className="p-3">{u.mfaEnabled ? <Badge tone="success">on</Badge> : <Badge>off</Badge>}</td>
            <td className="p-3">{u.companies}</td>
            <td className="p-3 text-xs">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('en-CA') : 'never'}<div>{u.activeSessions} session(s)</div></td>
            <td className="p-3"><div className="flex flex-wrap gap-1">
              {u.id !== me.id && <Button size="sm" variant="outline" onClick={() => void act(() => api(`/admin/users/${u.id}/active`, { method: 'PATCH', body: { active: !u.isActive } }))}>{u.isActive ? 'Deactivate' : 'Activate'}</Button>}
              <Button size="sm" variant="ghost" onClick={() => void act(() => api(`/admin/users/${u.id}/unlock`, { method: 'POST' }))}>Unlock</Button>
              <Button size="sm" variant="ghost" onClick={() => void act(() => api(`/admin/users/${u.id}/revoke-sessions`, { method: 'POST' }))}>Sign out everywhere</Button>
              {u.mfaEnabled && <Button size="sm" variant="ghost" onClick={() => { if (confirm(`Remove two-factor for ${u.email}? They will be signed out.`)) void act(() => api(`/admin/users/${u.id}/reset-mfa`, { method: 'POST' })); }}>Reset MFA</Button>}
              <Button size="sm" variant="ghost" onClick={() => setPw({ id: u.id, value: '' })}>Set temporary password</Button>
              {u.id !== me.id && <Button size="sm" variant="ghost" onClick={() => void act(() => api(`/admin/users/${u.id}/super-admin`, { method: 'PATCH', body: { value: !u.isSuperAdmin } }))}>{u.isSuperAdmin ? 'Remove platform admin' : 'Make platform admin'}</Button>}
            </div></td>
          </tr>))}</tbody></table></Card>
      {pw && (
        <Card><CardHeader><CardTitle>Temporary password</CardTitle></CardHeader><CardContent>
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api(`/admin/users/${pw.id}/temp-password`, { method: 'POST', body: { password: pw.value } }); setPw(null); }); }}>
            <Field label="New temporary password" htmlFor="tp" hint="12+ characters. The user must change it at next sign-in, and is signed out now."><Input id="tp" type="password" autoComplete="new-password" minLength={12} required value={pw.value} onChange={(e) => setPw({ ...pw, value: e.target.value })} className="w-72" /></Field>
            <Button type="submit">Set</Button><Button type="button" variant="ghost" onClick={() => setPw(null)}>Cancel</Button>
          </form></CardContent></Card>
      )}
    </div>
  );
}

/** Low-memory / low-disk warnings on every admin tab, not only on Resources. */
function TopWarnings() {
  const { data } = useApi<ResourcesData>('/admin/resources?hours=1');
  return data ? <ResourceWarnings warnings={data.now.warnings} /> : null;
}

function AdminInner() {
  const { me } = useSession();
  if (!me.isSuperAdmin) return <FormError message="Platform administrators only." />;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">System administration</h1>
      <TopWarnings />
      <Tabs defaultValue="companies">
        <TabsList><TabsTrigger value="companies">Companies</TabsTrigger><TabsTrigger value="users">Users</TabsTrigger><TabsTrigger value="system">System health</TabsTrigger><TabsTrigger value="resources">Resources</TabsTrigger></TabsList>
        <TabsContent value="companies"><Companies /></TabsContent>
        <TabsContent value="users"><Users /></TabsContent>
        <TabsContent value="system"><System /></TabsContent>
        <TabsContent value="resources"><Resources /></TabsContent>
      </Tabs>
    </div>
  );
}

export default function AdminPage() {
  return <SessionProvider><AdminShell /></SessionProvider>;
}
function AdminShell() {
  return <Shell companyId={null}><AdminInner /></Shell>;
}
