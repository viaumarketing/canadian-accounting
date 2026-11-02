'use client';
import * as Dialog from '@radix-ui/react-dialog';
import * as M from '@radix-ui/react-dropdown-menu';
import { Building2, Check, ChevronDown, ChevronsUpDown, CreditCard, LogOut, Menu as MenuIcon, Moon, PanelLeftClose, PanelLeftOpen, Plus, Settings, ShieldCheck, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { roleHasPermission, type CompanyRole, type Permission } from '@ca/shared';
import { NAV, sectionOf } from '@/lib/nav';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/menu';

function useRole(companyId: string | null) {
  const { me } = useSession();
  return me.companies.find((c) => c.id === companyId)?.role as CompanyRole | undefined;
}

function NavList({ companyId, collapsed, onNavigate }: { companyId: string | null; collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const role = useRole(companyId);
  if (!companyId || !role) return null;
  const open = sectionOf(pathname);
  const link = 'flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground/85 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5 px-2">
      {NAV.filter((n) => roleHasPermission(role, n.permission)).map((n) => {
        const kids = (n.children ?? []).filter((k) => roleHasPermission(role, k.permission));
        const isOpen = open === n.slug;
        const href = `/c/${companyId}/${kids[0]?.href ?? n.slug}`;
        return (
          <div key={n.slug}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={!kids.length && isOpen ? 'page' : undefined}
              aria-expanded={kids.length && !collapsed ? isOpen : undefined}
              title={collapsed ? n.label : undefined}
              className={cn(link, isOpen && 'bg-white/10 font-medium text-white', collapsed && 'justify-center px-2')}
            >
              <n.icon className="h-4 w-4 shrink-0" aria-hidden />
              {!collapsed && <span className="flex-1">{n.label}</span>}
              {!collapsed && kids.length > 0 && <ChevronDown className={cn('h-3.5 w-3.5 opacity-60 transition-transform', !isOpen && '-rotate-90')} aria-hidden />}
            </Link>
            {!collapsed && isOpen && kids.length > 0 && (
              <ul className="mb-1 mt-0.5 space-y-0.5 pl-9">
                {kids.map((k) => {
                  const kHref = `/c/${companyId}/${k.href}`;
                  const active = pathname === kHref || (k.href !== n.slug && k.href.includes('/') && pathname.startsWith(`${kHref}/`));
                  return (
                    <li key={k.href}>
                      <Link href={kHref} onClick={onNavigate} aria-current={active ? 'page' : undefined}
                        className={cn('block rounded-md px-3 py-1.5 text-[13px] text-sidebar-foreground/75 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', active && 'bg-white/15 font-medium text-white')}>
                        {k.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}

/** "+ New": everything you can create, grouped by who it is with, in one place. */
const NEW_MENU: { group: string; items: { label: string; href: string; permission: Permission }[] }[] = [
  { group: 'Customers', items: [
    { label: 'Invoice', href: 'sales/invoices/new', permission: 'sales:create' },
    { label: 'Receive payment', href: 'sales/invoices?status=open', permission: 'sales:post' },
    { label: 'Estimate', href: 'sales/estimates/new', permission: 'sales:create' },
    { label: 'Sales receipt', href: 'sales/receipts/new', permission: 'sales:create' },
    { label: 'Credit note', href: 'sales/invoices/new?kind=credit', permission: 'sales:create' },
    { label: 'Customer', href: 'sales/customers?new=1', permission: 'sales:create' },
  ] },
  { group: 'Suppliers', items: [
    { label: 'Expense', href: 'expenses', permission: 'expenses:create' },
    { label: 'Bill', href: 'purchases/new', permission: 'purchases:create' },
    { label: 'Pay bills', href: 'purchases/pay', permission: 'purchases:post' },
    { label: 'Purchase order', href: 'purchases/orders/new', permission: 'purchases:create' },
    { label: 'Supplier credit', href: 'purchases/new?kind=credit', permission: 'purchases:create' },
    { label: 'Supplier', href: 'contacts', permission: 'purchases:create' },
  ] },
  { group: 'Other', items: [
    { label: 'Bank deposit', href: 'deposits', permission: 'banking:post' },
    { label: 'Journal entry', href: 'accounting', permission: 'journal:create' },
    { label: 'Inventory adjustment', href: 'inventory', permission: 'journal:post' },
    { label: 'Time entry', href: 'time', permission: 'expenses:create' },
    { label: 'Bank statement import', href: 'banking', permission: 'banking:create' },
    { label: 'Product or service', href: 'sales/products?new=1', permission: 'sales:create' },
  ] },
];

function NewMenu({ companyId, collapsed }: { companyId: string | null; collapsed: boolean }) {
  const role = useRole(companyId);
  const router = useRouter();
  if (!companyId || !role) return null;
  const groups = NEW_MENU.map((g) => ({ ...g, items: g.items.filter((i) => roleHasPermission(role, i.permission)) })).filter((g) => g.items.length);
  if (!groups.length) return null;
  return (
    <M.Root>
      <M.Trigger asChild>
        <button
          className={cn('mx-3 mb-3 flex items-center justify-center gap-2 rounded-full bg-primary py-2 text-sm font-semibold text-primary-foreground shadow hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', collapsed ? 'mx-2 px-0' : 'px-4')}
          aria-label="Create new"
        >
          <Plus className="h-4 w-4" aria-hidden />{!collapsed && 'New'}
        </button>
      </M.Trigger>
      <M.Portal>
        <M.Content side="right" align="start" sideOffset={8} className="z-50 grid max-w-[calc(100vw-2rem)] gap-6 rounded-lg border bg-card p-5 text-card-foreground shadow-xl sm:grid-cols-3">
          {groups.map((g) => (
            <M.Group key={g.group} className="min-w-40">
              <M.Label className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.group}</M.Label>
              {g.items.map((i) => (
                <M.Item key={i.label} onSelect={() => router.push(`/c/${companyId}/${i.href}`)}
                  className="cursor-pointer rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground">
                  {i.label}
                </M.Item>
              ))}
            </M.Group>
          ))}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={cn('flex h-14 items-center gap-2 px-4 text-white', collapsed && 'justify-center px-2')}>
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">CA</span>
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
        <button className="flex min-w-0 max-w-[9.5rem] items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-[18rem]" aria-label="Switch company">
          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate text-sm font-semibold">{current?.operatingName || current?.legalName || 'Select company'}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
        </button>
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
  const { data: cfg } = useApi<{ mode: string }>('/config');
  const saas = cfg?.mode === 'saas';
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account menu" className="rounded-full bg-primary text-xs font-semibold text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground">
          {initials}
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuLabel>{me.email}</MenuLabel>
        {saas && (
          <MenuItem onSelect={() => router.push('/billing')}>
            <CreditCard className="h-4 w-4" aria-hidden /> Billing
          </MenuItem>
        )}
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
  const role = useRole(companyId);
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
        <NewMenu companyId={companyId} collapsed={collapsed} />
        <div className="flex-1 overflow-y-auto pb-2">
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
          <Dialog.Content className="fixed inset-y-0 left-0 z-50 w-64 overflow-y-auto bg-sidebar text-sidebar-foreground md:hidden" aria-describedby={undefined}>
            <Dialog.Title className="sr-only">Navigation</Dialog.Title>
            <Brand collapsed={false} />
            <NewMenu companyId={companyId} collapsed={false} />
            <NavList companyId={companyId} collapsed={false} onNavigate={() => setMobileOpen(false)} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-card px-4 shadow-sm">
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation" onClick={() => setMobileOpen(true)}>
            <MenuIcon className="h-5 w-5" />
          </Button>
          <CompanySelector companyId={companyId} />
          {title && <h1 className="ml-2 hidden truncate text-sm font-medium text-muted-foreground sm:block">{title}</h1>}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {companyId && role && roleHasPermission(role, 'company:view') && (
              <Link href={`/c/${companyId}/settings`} aria-label="Settings" className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Settings className="h-4 w-4" />
              </Link>
            )}
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 p-4 sm:p-6"><SubscriptionBanner />{children}</main>
      </div>
    </div>
  );
}

/** SaaS edition, organization owners: trial ending soon, or books read-only because the subscription lapsed. */
function SubscriptionBanner() {
  const { data: cfg } = useApi<{ mode: string }>('/config');
  const { data } = useApi<{ status: string; trialEndsAt: string | null; subscribed: boolean; writable: boolean }>(cfg?.mode === 'saas' ? '/billing' : null);
  if (!data) return null;
  const days = data.trialEndsAt ? Math.ceil((Date.parse(data.trialEndsAt) - Date.now()) / 86_400_000) : null;
  if (data.writable && (data.subscribed || days === null || days > 7)) return null;
  return (
    <div role="status" className={cn('mb-4 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm', data.writable ? 'border-warning/40 bg-warning/10' : 'border-destructive/40 bg-destructive/10 text-destructive')}>
      {data.writable ? `Your free trial ends in ${days} day${days === 1 ? '' : 's'}.` : 'Your subscription is not active: the books are read-only.'}
      <a href="/billing" className="ml-auto font-medium underline">{data.writable ? 'Choose a plan' : 'Renew now'}</a>
    </div>
  );
}
