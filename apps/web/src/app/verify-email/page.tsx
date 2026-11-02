'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { AuthCard } from '@/components/auth-card';
import { api, errorMessage } from '@/lib/api';

function Verify() {
  const token = useSearchParams().get('token');
  const [state, setState] = useState<'working' | 'ok' | string>('working');
  useEffect(() => { if (!token) { setState('This link is missing its code.'); return; } api('/signup/verify', { method: 'POST', body: { token } }).then(() => setState('ok')).catch((e) => setState(errorMessage(e))); }, [token]);
  if (state === 'working') return <AuthCard title="Confirming your e-mail…"><p className="text-sm text-muted-foreground">One moment.</p></AuthCard>;
  if (state === 'ok') return <AuthCard title="E-mail confirmed" subtitle="Your trial has started."><Link href="/login" className="inline-flex h-9 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90">Sign in</Link></AuthCard>;
  return <AuthCard title="We could not confirm your e-mail" subtitle={state}><Link href="/signup" className="text-sm text-primary hover:underline">Sign up again or ask for a new link</Link></AuthCard>;
}
export default function VerifyPage() {
  return <Suspense><Verify /></Suspense>;
}
