'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';

export default function ChangePasswordPage() {
  const router = useRouter();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
      router.replace('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthCard title="Choose a new password" subtitle="Your administrator gave you a temporary password. Set your own to continue.">
      <form onSubmit={submit} className="space-y-4">
        <FormError message={error} />
        <Field label="Temporary / current password" htmlFor="cur"><Input id="cur" type="password" autoComplete="current-password" required value={currentPassword} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New password" htmlFor="new" hint="At least 12 characters."><Input id="new" type="password" autoComplete="new-password" minLength={12} required value={newPassword} onChange={(e) => setNew(e.target.value)} /></Field>
        <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Saving…' : 'Update password'}</Button>
      </form>
    </AuthCard>
  );
}
