'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { SidePanel } from '@/components/sales/common';
import { api, errorMessage } from '@/lib/api';

interface Preview { to: string[]; subject: string; body: string; mailConfigured: boolean }
const areaCls = 'w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const list = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

/**
 * Send a document by e-mail with its PDF attached. `path` is the document's API path (e.g. /companies/…/invoices/…);
 * the dialog loads `${path}/email` for the suggested recipient and wording, then posts to `${path}/${action}`.
 */
export function SendDialog({ path, title, action = 'send', onClose }: { path: string; title: string; action?: 'send' | 'remind'; onClose: (sent: boolean) => void }) {
  const [p, setP] = useState<Preview | null>(null);
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Preview>(`${path}/email`).then((x) => {
      setP(x); setTo(x.to.join(', '));
      if (action === 'send') { setSubject(x.subject); setBody(x.body); }
    }).catch((e) => setErr(errorMessage(e)));
  }, [path, action]);
  async function send() {
    setErr(null); setBusy(true);
    try {
      await api(`${path}/${action}`, { method: 'POST', body: { to: list(to), ...(list(cc).length ? { cc: list(cc) } : {}), ...(subject ? { subject } : {}), ...(body ? { body } : {}) } });
      onClose(true);
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <SidePanel title={title} onClose={() => onClose(false)} footer={<><Button variant="outline" onClick={() => onClose(false)}>Cancel</Button><Button disabled={busy || !p?.mailConfigured || !list(to).length} onClick={() => void send()}>{busy ? 'Sending…' : 'Send'}</Button></>}>
      <FormError message={err} />
      {p && !p.mailConfigured && <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">E-mail is not set up on this server yet (RESEND_API_KEY and MAIL_FROM). Download the PDF and send it yourself, or ask your administrator.</p>}
      <Field label="To" htmlFor="sd-to" hint="Separate several addresses with commas"><Input id="sd-to" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      <Field label="Cc" htmlFor="sd-cc"><Input id="sd-cc" value={cc} onChange={(e) => setCc(e.target.value)} /></Field>
      <Field label="Subject" htmlFor="sd-subj" hint={action === 'remind' ? 'Leave blank for your reminder wording (Settings → Collections)' : undefined}><Input id="sd-subj" value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
      <Field label="Message" htmlFor="sd-body" hint="The PDF is attached. Placeholders like {{balance}} are filled in."><textarea id="sd-body" rows={9} className={areaCls} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
    </SidePanel>
  );
}
