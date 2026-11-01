'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';

export default function SetupPage() {
  const router = useRouter();
  const [status, setStatus] = useState<{ needsSetup: boolean; requiresToken: boolean } | null>(null);
  const [f, setF] = useState({ name: '', email: '', password: '', setupToken: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    api<{ needsSetup: boolean; requiresToken: boolean }>('/setup/status').then((s) => (s.needsSetup ? setStatus(s) : router.replace('/login')));
  }, [router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/setup', { method: 'POST', body: { ...f, setupToken: f.setupToken || undefined } });
      await api('/auth/login', { method: 'POST', body: { email: f.email, password: f.password } });
      router.replace('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  return (
    <AuthCard title="Create the first administrator" subtitle="This platform administrator provisions companies. It has no access to a company's books unless explicitly added as a member.">
      <form onSubmit={submit} className="space-y-4">
        <FormError message={error} />
        <Field label="Full name" htmlFor="name"><Input id="name" required value={f.name} onChange={set('name')} /></Field>
        <Field label="Email" htmlFor="email"><Input id="email" type="email" autoComplete="username" required value={f.email} onChange={set('email')} /></Field>
        <Field label="Password" htmlFor="password" hint="At least 12 characters. A passphrase works well.">
          <Input id="password" type="password" autoComplete="new-password" minLength={12} required value={f.password} onChange={set('password')} />
        </Field>
        {status.requiresToken && (
          <Field label="Setup token" htmlFor="token" hint="The SETUP_TOKEN value from your .env file.">
            <Input id="token" type="password" required value={f.setupToken} onChange={set('setupToken')} />
          </Field>
        )}
        <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Creating…' : 'Create administrator'}</Button>
      </form>
    </AuthCard>
  );
}
