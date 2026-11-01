'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { api, ApiError, errorMessage } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [needsMfa, setNeedsMfa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ needsSetup: boolean }>('/setup/status').then((s) => s.needsSetup && router.replace('/setup')).catch(() => undefined);
  }, [router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login', { method: 'POST', body: { email, password, ...(needsMfa ? { mfaCode } : {}) } });
      router.replace('/');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MFA_REQUIRED') setNeedsMfa(true);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Sign in" subtitle={needsMfa ? 'Enter the code from your authenticator app, or a recovery code.' : 'Welcome back.'}>
      <form onSubmit={submit} className="space-y-4">
        <FormError message={error} />
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={needsMfa} />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={needsMfa} />
        </Field>
        {needsMfa && (
          <Field label="Verification code" htmlFor="mfa">
            <Input id="mfa" inputMode="numeric" autoComplete="one-time-code" autoFocus required value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} />
          </Field>
        )}
        <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
      </form>
    </AuthCard>
  );
}
