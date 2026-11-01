'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Me } from '@/lib/types';

/** Entry point: send the visitor wherever they belong. */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    (async () => {
      try {
        const me = await api<Me>('/auth/me');
        let last: string | null = null;
        try {
          last = localStorage.getItem('ca.company');
        } catch { /* storage unavailable */ }
        const target = me.companies.find((c) => c.id === last) ?? me.companies[0];
        router.replace(target ? `/c/${target.id}/dashboard` : me.isSuperAdmin ? '/admin' : '/no-company');
      } catch (e) {
        if (e instanceof ApiError && e.code === 'PASSWORD_CHANGE_REQUIRED') return router.replace('/change-password');
        const s = await api<{ needsSetup: boolean }>('/setup/status').catch(() => null);
        router.replace(s?.needsSetup ? '/setup' : '/login');
      }
    })();
  }, [router]);
  return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>;
}
