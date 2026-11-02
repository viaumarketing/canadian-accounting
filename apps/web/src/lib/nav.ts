import { BarChart3, Banknote, BookOpen, FileText, Landmark, LayoutDashboard, Receipt, Settings, ShoppingBag, Store, type LucideIcon } from 'lucide-react';
import type { Permission } from '@ca/shared';

export interface NavChild { label: string; href: string; permission: Permission }
export interface NavItem {
  slug: string;
  label: string;
  icon: LucideIcon;
  permission: Permission;
  /** Milestone in which this section becomes functional. */
  milestone: number;
  blurb: string;
  /** Pages shown under the section when it is open (href relative to /c/:companyId/) */
  children?: NavChild[];
}

/** Left navigation, grouped the way bookkeeping apps usually are: money in (Sales), money out (Expenses), then the books. */
export const NAV: NavItem[] = [
  { slug: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, permission: 'company:view', milestone: 1, blurb: 'Company overview and setup status.' },
  { slug: 'banking', label: 'Banking', icon: Landmark, permission: 'banking:view', milestone: 4, blurb: 'Bank accounts, statement imports, matching and reconciliation.' },
  {
    slug: 'sales', label: 'Sales', icon: ShoppingBag, permission: 'sales:view', milestone: 2, blurb: 'Invoices, sales receipts, customers and products.',
    children: [
      { label: 'All sales', href: 'sales', permission: 'sales:view' },
      { label: 'Invoices', href: 'sales/invoices', permission: 'sales:view' },
      { label: 'Sales receipts', href: 'sales/receipts', permission: 'sales:view' },
      { label: 'Customers', href: 'sales/customers', permission: 'sales:view' },
      { label: 'Products & services', href: 'sales/products', permission: 'sales:view' },
    ],
  },
  {
    slug: 'expenses', label: 'Expenses', icon: Receipt, permission: 'expenses:view', milestone: 2, blurb: 'Expenses, bills and suppliers.',
    children: [
      { label: 'Expenses', href: 'expenses', permission: 'expenses:view' },
      { label: 'Bills', href: 'purchases', permission: 'purchases:view' },
      { label: 'Suppliers', href: 'contacts', permission: 'sales:view' },
    ],
  },
  { slug: 'shopify', label: 'Shopify', icon: Store, permission: 'shopify:view', milestone: 3, blurb: 'Store connections, order and payout sync, reconciliation.' },
  { slug: 'reports', label: 'Reports', icon: BarChart3, permission: 'reports:view', milestone: 5, blurb: 'Financial statements, aging, tax and Shopify reports.' },
  { slug: 'taxes', label: 'Taxes', icon: Banknote, permission: 'taxes:view', milestone: 2, blurb: 'GST/HST/QST/PST codes, rates, Quick Method and filing reports.' },
  { slug: 'accounting', label: 'Accounting', icon: BookOpen, permission: 'journal:view', milestone: 2, blurb: 'Chart of accounts, journal entries, trial balance and year-end.' },
  { slug: 'documents', label: 'Documents', icon: FileText, permission: 'documents:view', milestone: 2, blurb: 'Receipts, statements and supporting documents.' },
  { slug: 'settings', label: 'Settings', icon: Settings, permission: 'company:view', milestone: 1, blurb: 'Company, members, tax registration, security and audit log.' },
];

/** Section owning a path (the Expenses group also owns /purchases and /contacts). */
export const sectionOf = (path: string) => {
  const seg = path.split('/')[3] ?? '';
  return NAV.find((n) => n.slug === seg || n.children?.some((c) => c.href.split('/')[0] === seg))?.slug ?? null;
};
