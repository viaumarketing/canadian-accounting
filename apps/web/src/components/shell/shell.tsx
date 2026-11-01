'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronsUpDown, LogOut, Menu as MenuIcon, Moon, PanelLeftClose, PanelLeftOpen, ShieldCheck, Sun, Building2, Check } from 'lucide-react';
import { useTheme } from 'next-themes';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { roleHasPermission } from '@ca/shared';
import { NAV } from '@/lib/nav';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/menu';

function NavList({ companyId, collapsed, onNavigate }: { companyId: string | null; collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const { me } = useSession();
  const role = me.companies.find((c) => c.id === companyId)?.role;
  if (!companyId || !role) return null;
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5 px-2">
      {NAV.filter((n) => roleHasPermission(role, n.permission)).map((n) => {
        const href = `/c/${companyId}/${n.slug}`;
        const active = pathname === href;
        return (
          <Link
            key={n.slug}
            href={href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            title={collapsed ? n.label : undefined}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active && 'bg-white/10 font-medium text-white',
              collapsed && 'justify-center px-2',
            )}
          >
            <n.icon className="h-4 w-4 shrink-0" aria-hidden />
            {!collapsed && <span>{n.label}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={cn('flex h-14 items-center gap-2 px-4 text-white', collapsed && 'justify-center px-2')}>
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">CA</span>
      {!collapsed && <span className="font-semibold tracking-tight">Canadian Accounting</span>}
    </div>
  );
}

function CompanySelector({ companyId }: { companyId: string | null }) {
  const { me } = useSession();
  const router = useRouter();
  const current = me.companies.find((c) => c.id === companyId);
  if (me.companies.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="outline" className="max-w-[16rem] justify-between" aria-label="Switch company">
          <Building2 className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">{current?.operatingName || current?.legalName || 'Select company'}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
        </Button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>Companies</MenuLabel>
        {me.companies.map((c) => (
          <MenuItem key={c.id} onSelect={() => router.push(`/c/${c.id}/dashboard`)}>
            <span className="flex-1 truncate">{c.operatingName || c.legalName}</span>
            {c.id === companyId && <Check className="h-4 w-4" aria-hidden />}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === 'dark';
  return (
    <Button variant="ghost" size="icon" aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setTheme(dark ? 'light' : 'dark')}>
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}

function UserMenu() {
  const { me, signOut } = useSession();
  const router = useRouter();
  const initials = me.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account menu" className="rounded-full bg-secondary text-xs font-semibold">
          {initials}
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuLabel>{me.email}</MenuLabel>
        {me.isSuperAdmin && (
          <MenuItem onSelect={() => router.push('/admin')}>
            <ShieldCheck className="h-4 w-4" aria-hidden /> System administration
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem onSelect={() => void signOut()}>
          <LogOut className="h-4 w-4" aria-hidden /> Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function Shell({ companyId, title, children }: { companyId: string | null; title?: string; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem('ca.sidebar') === 'collapsed');
    } catch { /* storage unavailable */ }
  }, []);
  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem('ca.sidebar', c ? 'open' : 'collapsed');
      } catch { /* storage unavailable */ }
      return !c;
    });
  };

  return (
    <div className="flex min-h-screen">
      <aside className={cn('sticky top-0 hidden h-screen shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-[width] md:flex', collapsed ? 'w-16' : 'w-60')}>
        <Brand collapsed={collapsed} />
        <div className="flex-1 overflow-y-auto py-2">
          <NavList companyId={companyId} collapsed={collapsed} />
        </div>
        <button
          onClick={toggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="m-2 flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs text-sidebar-foreground/70 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <><PanelLeftClose className="h-4 w-4" /> Collapse</>}
        </button>
      </aside>

      <Dialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 md:hidden" />
          <Dialog.Content className="fixed inset-y-0 left-0 z-50 w-64 bg-sidebar text-sidebar-foreground md:hidden" aria-describedby={undefined}>
            <Dialog.Title className="sr-only">Navigation</Dialog.Title>
            <Brand collapsed={false} />
            <NavList companyId={companyId} collapsed={false} onNavigate={() => setMobileOpen(false)} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur">
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation" onClick={() => setMobileOpen(true)}>
            <MenuIcon className="h-5 w-5" />
          </Button>
          <CompanySelector companyId={companyId} />
          {title && <h1 className="ml-2 hidden truncate text-sm font-medium text-muted-foreground sm:block">{title}</h1>}
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
