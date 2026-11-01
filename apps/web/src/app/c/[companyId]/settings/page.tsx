'use client';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { CANADIAN_PROVINCES, COMPANY_ROLES, ROLE_LABELS, roleHasPermission, type CompanyRole } from '@ca/shared';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface CompanyFull { legalName: string; operatingName: string | null; businessNumber: string | null; province: string }
const fmt = (s: string) => new Date(s).toLocaleString('en-CA');

function CompanyTab({ companyId, canEdit }: { companyId: string; canEdit: boolean }) {
  const { data, reload } = useApi<CompanyFull>(`/companies/${companyId}`);
  const [f, setF] = useState<Partial<CompanyFull> | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!data) return null;
  const v = { ...data, ...f };
  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/companies/${companyId}`, { method: 'PATCH', body: { legalName: v.legalName, operatingName: v.operatingName || undefined, businessNumber: v.businessNumber || undefined, province: v.province } });
      setMsg({ ok: true, text: 'Saved' });
      setF(null);
      await reload();
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    }
  }
  return (
    <Card><CardContent className="p-5">
      <form onSubmit={save} className="grid max-w-xl gap-4">
        {msg && (msg.ok ? <p role="status" className="text-sm text-success">{msg.text}</p> : <FormError message={msg.text} />)}
        <Field label="Legal name" htmlFor="legal"><Input id="legal" disabled={!canEdit} value={v.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} required /></Field>
        <Field label="Operating name" htmlFor="op"><Input id="op" disabled={!canEdit} value={v.operatingName ?? ''} onChange={(e) => setF({ ...f, operatingName: e.target.value })} /></Field>
        <Field label="CRA business number" htmlFor="bn" hint="9 digits"><Input id="bn" disabled={!canEdit} inputMode="numeric" pattern="\d{9}" value={v.businessNumber ?? ''} onChange={(e) => setF({ ...f, businessNumber: e.target.value })} /></Field>
        <Field label="Province / territory" htmlFor="prov">
          <Select id="prov" disabled={!canEdit} value={v.province} onChange={(e) => setF({ ...f, province: e.target.value })}>
            {CANADIAN_PROVINCES.map((p) => <option key={p}>{p}</option>)}
          </Select>
        </Field>
        {canEdit && <div><Button type="submit">Save changes</Button></div>}
      </form>
    </CardContent></Card>
  );
}

interface Member { id: string; role: CompanyRole; status: string; user: { id: string; email: string; name: string; mfaEnabled: boolean } }

function MembersTab({ companyId, canInvite, myRole }: { companyId: string; canInvite: boolean; myRole: CompanyRole }) {
  const { data, error, reload } = useApi<Member[]>(`/companies/${companyId}/members`);
  const { me } = useSession();
  const [f, setF] = useState({ name: '', email: '', role: 'BOOKKEEPER' as CompanyRole, temporaryPassword: '' });
  const [err, setErr] = useState<string | null>(null);
  const grantable = COMPANY_ROLES.filter((r) => r !== 'OWNER' || myRole === 'OWNER');
  async function invite(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await api(`/companies/${companyId}/members`, { method: 'POST', body: f });
      setF({ ...f, name: '', email: '', temporaryPassword: '' });
      await reload();
    } catch (x) { setErr(errorMessage(x)); }
  }
  async function act(fn: () => Promise<unknown>) {
    setErr(null);
    try { await fn(); await reload(); } catch (x) { setErr(errorMessage(x)); }
  }
  return (
    <div className="space-y-4">
      <FormError message={err ?? (error ? errorMessage(error) : null)} />
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b text-left text-muted-foreground"><tr><th className="p-3">Name</th><th className="p-3">Role</th><th className="p-3">MFA</th><th className="p-3">Status</th><th className="p-3" /></tr></thead>
          <tbody>
            {(data ?? []).map((m) => (
              <tr key={m.id} className="border-b last:border-0">
                <td className="p-3"><div className="font-medium">{m.user.name}</div><div className="text-xs text-muted-foreground">{m.user.email}</div></td>
                <td className="p-3">
                  {canInvite && m.user.id !== me.id && m.status === 'ACTIVE' ? (
                    <Select aria-label={`Role for ${m.user.name}`} value={m.role} onChange={(e) => void act(() => api(`/companies/${companyId}/members/${m.id}`, { method: 'PATCH', body: { role: e.target.value } }))} className="h-8 w-48">
                      {grantable.concat(m.role === 'OWNER' && myRole !== 'OWNER' ? ['OWNER'] : []).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </Select>
                  ) : ROLE_LABELS[m.role]}
                </td>
                <td className="p-3">{m.user.mfaEnabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}</td>
                <td className="p-3"><Badge tone={m.status === 'ACTIVE' ? 'success' : 'warning'}>{m.status.toLowerCase()}</Badge></td>
                <td className="p-3 text-right">
                  {canInvite && m.user.id !== me.id && m.status === 'ACTIVE' && (
                    <Button size="sm" variant="outline" onClick={() => void act(() => api(`/companies/${companyId}/members/${m.id}`, { method: 'DELETE' }))}>Suspend</Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {canInvite && (
        <Card>
          <CardHeader><CardTitle>Add a member</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={invite} className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="m-name"><Input id="m-name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
              <Field label="Email" htmlFor="m-email"><Input id="m-email" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
              <Field label="Role" htmlFor="m-role"><Select id="m-role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as CompanyRole })}>{grantable.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</Select></Field>
              <Field label="Temporary password" htmlFor="m-pw" hint="Min 12 characters. Ignored if the person already has an account. They must change it at first sign-in."><Input id="m-pw" type="password" autoComplete="new-password" minLength={12} required value={f.temporaryPassword} onChange={(e) => setF({ ...f, temporaryPassword: e.target.value })} /></Field>
              <div className="sm:col-span-2"><Button type="submit">Add member</Button></div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

interface Reg { id: string; kind: string; registrationNumber: string; filingFrequency: string; effectiveFrom: string }

function TaxTab({ companyId, canAdd }: { companyId: string; canAdd: boolean }) {
  const { data, reload } = useApi<Reg[]>(`/companies/${companyId}/tax-registrations`);
  const [f, setF] = useState({ kind: 'GST_HST', registrationNumber: '', filingFrequency: 'QUARTERLY', effectiveFrom: '' });
  const [err, setErr] = useState<string | null>(null);
  async function add(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try { await api(`/companies/${companyId}/tax-registrations`, { method: 'POST', body: f }); setF({ ...f, registrationNumber: '' }); await reload(); } catch (x) { setErr(errorMessage(x)); }
  }
  return (
    <div className="space-y-4">
      <Card>
        {data && data.length === 0 ? <EmptyState title="No tax registrations">Add your GST/HST account, and QST or provincial PST registration if applicable. Rates and filing rules arrive in Milestone 2.</EmptyState> : (
          <table className="w-full text-sm"><thead className="border-b text-left text-muted-foreground"><tr><th className="p-3">Type</th><th className="p-3">Number</th><th className="p-3">Filing</th><th className="p-3">Effective</th></tr></thead>
            <tbody>{(data ?? []).map((r) => <tr key={r.id} className="border-b last:border-0"><td className="p-3">{r.kind.replace('_', '/')}</td><td className="p-3 font-mono">{r.registrationNumber}</td><td className="p-3">{r.filingFrequency.toLowerCase()}</td><td className="p-3">{r.effectiveFrom.slice(0, 10)}</td></tr>)}</tbody></table>
        )}
      </Card>
      {canAdd && (
        <Card><CardHeader><CardTitle>Add registration</CardTitle></CardHeader><CardContent>
          <form onSubmit={add} className="grid gap-4 sm:grid-cols-2">
            <FormError message={err} />
            <Field label="Type" htmlFor="t-kind"><Select id="t-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{['GST_HST', 'QST', 'PST_BC', 'PST_SK', 'PST_MB'].map((k) => <option key={k} value={k}>{k.replace('_', '/')}</option>)}</Select></Field>
            <Field label="Registration number" htmlFor="t-num" hint={f.kind === 'GST_HST' ? 'Format: 123456789RT0001' : undefined}><Input id="t-num" required value={f.registrationNumber} onChange={(e) => setF({ ...f, registrationNumber: e.target.value })} /></Field>
            <Field label="Filing frequency" htmlFor="t-freq"><Select id="t-freq" value={f.filingFrequency} onChange={(e) => setF({ ...f, filingFrequency: e.target.value })}>{['MONTHLY', 'QUARTERLY', 'ANNUAL'].map((k) => <option key={k} value={k}>{k.toLowerCase()}</option>)}</Select></Field>
            <Field label="Effective from" htmlFor="t-from"><Input id="t-from" type="date" required value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></Field>
            <div className="sm:col-span-2"><Button type="submit">Add registration</Button></div>
          </form></CardContent></Card>
      )}
    </div>
  );
}

interface AuditPage { items: { id: string; action: string; createdAt: string; actor: { name: string } | null }[]; nextCursor: string | null }

function AuditTab({ companyId }: { companyId: string }) {
  const { data, error } = useApi<AuditPage>(`/companies/${companyId}/audit?take=100`);
  if (error) return <FormError message={errorMessage(error)} />;
  if (!data) return null;
  return (
    <Card className="overflow-x-auto">
      {data.items.length === 0 ? <EmptyState title="No audit events yet" /> : (
        <table className="w-full text-sm"><thead className="border-b text-left text-muted-foreground"><tr><th className="p-3">When</th><th className="p-3">Who</th><th className="p-3">Action</th></tr></thead>
          <tbody>{data.items.map((e) => <tr key={e.id} className="border-b last:border-0"><td className="p-3 whitespace-nowrap">{fmt(e.createdAt)}</td><td className="p-3">{e.actor?.name ?? 'System'}</td><td className="p-3 font-mono text-xs">{e.action}</td></tr>)}</tbody></table>
      )}
    </Card>
  );
}

function SecurityTab() {
  const { me, refresh } = useSession();
  const [enroll, setEnroll] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [off, setOff] = useState({ password: '', code: '' });
  const [showOff, setShowOff] = useState(false);
  const run = async (fn: () => Promise<void>) => { setErr(null); try { await fn(); } catch (x) { setErr(errorMessage(x)); } };
  return (
    <Card><CardContent className="space-y-4 p-5">
      <FormError message={err} />
      <div className="flex items-center gap-2"><h2 className="font-medium">Two-factor authentication</h2>{me.mfaEnabled ? <Badge tone="success">Enabled</Badge> : <Badge tone="warning">Not enabled</Badge>}</div>
      {codes && (
        <div className="rounded-md border bg-muted p-4">
          <p className="mb-2 text-sm font-medium">Save these recovery codes now. Each works once and they will not be shown again.</p>
          <ul className="grid grid-cols-2 gap-1 font-mono text-sm">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      )}
      {!me.mfaEnabled && !enroll && <Button onClick={() => void run(async () => setEnroll(await api('/auth/mfa/enroll', { method: 'POST' })))}>Set up authenticator app</Button>}
      {enroll && !me.mfaEnabled && (
        <form className="max-w-sm space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await api<{ recoveryCodes: string[] }>('/auth/mfa/activate', { method: 'POST', body: { code } }); setCodes(r.recoveryCodes); setEnroll(null); setCode(''); await refresh(); }); }}>
          <img src={enroll.qrDataUrl} alt="QR code for your authenticator app" width={180} height={180} className="rounded-md border bg-white p-2" />
          <p className="text-xs text-muted-foreground">Can’t scan? Enter this key manually: <span className="font-mono">{enroll.secret}</span></p>
          <Field label="6-digit code" htmlFor="mfa-code"><Input id="mfa-code" inputMode="numeric" required value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Button type="submit">Verify and enable</Button>
        </form>
      )}
      {me.mfaEnabled && !showOff && <Button variant="outline" onClick={() => setShowOff(true)}>Disable two-factor…</Button>}
      {me.mfaEnabled && showOff && (
        <form className="max-w-sm space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('/auth/mfa/disable', { method: 'POST', body: off }); setShowOff(false); setOff({ password: '', code: '' }); await refresh(); }); }}>
          <Field label="Password" htmlFor="off-pw"><Input id="off-pw" type="password" required value={off.password} onChange={(e) => setOff({ ...off, password: e.target.value })} /></Field>
          <Field label="Authenticator or recovery code" htmlFor="off-code"><Input id="off-code" required value={off.code} onChange={(e) => setOff({ ...off, code: e.target.value })} /></Field>
          <Button type="submit" variant="destructive">Disable two-factor</Button>
        </form>
      )}
    </CardContent></Card>
  );
}

export default function SettingsPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const { me } = useSession();
  const role = me.companies.find((c) => c.id === companyId)!.role;
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(role, p);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <Tabs defaultValue="company">
        <TabsList>
          <TabsTrigger value="company">Company</TabsTrigger>
          {can('members:view') && <TabsTrigger value="members">Members</TabsTrigger>}
          {can('taxes:view') && <TabsTrigger value="tax">Tax registration</TabsTrigger>}
          <TabsTrigger value="security">Security</TabsTrigger>
          {can('audit:view') && <TabsTrigger value="audit">Audit log</TabsTrigger>}
        </TabsList>
        <TabsContent value="company"><CompanyTab companyId={companyId} canEdit={can('settings:create')} /></TabsContent>
        {can('members:view') && <TabsContent value="members"><MembersTab companyId={companyId} canInvite={can('members:create')} myRole={role} /></TabsContent>}
        {can('taxes:view') && <TabsContent value="tax"><TaxTab companyId={companyId} canAdd={can('taxes:create')} /></TabsContent>}
        <TabsContent value="security"><SecurityTab /></TabsContent>
        {can('audit:view') && <TabsContent value="audit"><AuditTab companyId={companyId} /></TabsContent>}
      </Tabs>
    </div>
  );
}
