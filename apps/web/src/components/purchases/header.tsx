'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useCompany } from '@/lib/company';
import { cn } from '@/lib/utils';

/** Tabs across the top of the purchasing pages. */
export function PurchasesHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  const { companyId, can } = useCompany();
  const pathname = usePathname();
  const router = useRouter();
  const base = `/c/${companyId}`;
  const tabs: [string, string, boolean][] = [['Expenses', `${base}/expenses`, can('expenses:view')], ['Bills', `${base}/purchases`, can('purchases:view')], ['Purchase orders', `${base}/purchases/orders`, can('purchases:view')], ['Pay bills', `${base}/purchases/pay`, can('purchases:post')], ['Suppliers', `${base}/contacts`, can('sales:view')]];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <div className="ml-auto flex items-center gap-2">
          {actions}
          {can('purchases:create') && <Button onClick={() => router.push(`${base}/purchases/new`)}>New bill</Button>}
        </div>
      </div>
      <nav aria-label="Expenses" className="flex gap-1 overflow-x-auto border-b">
        {tabs.filter((t) => t[2]).map(([label, href]) => {
          const active = href === `${base}/purchases` ? pathname === href || /\/purchases\/[0-9a-f-]{36}$/.test(pathname) || pathname.endsWith('/purchases/new') : pathname.startsWith(href);
          return <Link key={href} href={href} aria-current={active ? 'page' : undefined} className={cn('whitespace-nowrap border-b-2 px-3 pb-2 pt-1 text-sm font-medium text-muted-foreground hover:text-foreground', active ? 'border-primary text-foreground' : 'border-transparent')}>{label}</Link>;
        })}
      </nav>
    </div>
  );
}
