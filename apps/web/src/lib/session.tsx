'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError } from './api';
import type { Me } from './types';

interface SessionCtx {
  me: Me;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}
const Ctx = createContext<SessionCtx | null>(null);

export const useSession = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
};

/** Gate: loads /auth/me, redirects to login / first-run setup / forced password change as needed. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('/auth/me'));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PASSWORD_CHANGE_REQUIRED') return router.replace('/change-password');
      if (e instanceof ApiError && e.status === 401) {
        const s = await api<{ needsSetup: boolean }>('/setup/status').catch(() => null);
        return router.replace(s?.needsSetup ? '/setup' : '/login');
      }
      throw e;
    }
  }, [router]);

  useEffect(() => {
    void refresh();
  }, [refresh, pathname]);

  const signOut = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setMe(null);
    router.replace('/login');
  }, [router]);

  if (!me) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground" role="status">
        Loading…
      </div>
    );
  }
  if (me.mustChangePassword) {
    router.replace('/change-password');
    return null;
  }
  return <Ctx.Provider value={{ me, refresh, signOut }}>{children}</Ctx.Provider>;
}
