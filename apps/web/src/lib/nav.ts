import { BarChart3, Banknote, BookOpen, FileText, Landmark, LayoutDashboard, Receipt, Settings, ShoppingBag, ShoppingCart, Store, Users, type LucideIcon } from 'lucide-react';
import type { Permission } from '@ca/shared';

export interface NavItem {
  slug: string;
  label: string;
  icon: LucideIcon;
  permission: Permission;
  /** Milestone in which this section becomes functional. */
  milestone: number;
  blurb: string;
}

export const NAV: NavItem[] = [
  { slug: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, permission: 'company:view', milestone: 1, blurb: 'Company overview and setup status.' },
  { slug: 'banking', label: 'Banking', icon: Landmark, permission: 'banking:view', milestone: 4, blurb: 'Bank accounts, statement imports, matching and reconciliation.' },
  { slug: 'shopify', label: 'Shopify', icon: Store, permission: 'shopify:view', milestone: 3, blurb: 'Store connections, order and payout sync, reconciliation.' },
  { slug: 'sales', label: 'Sales', icon: ShoppingBag, permission: 'sales:view', milestone: 2, blurb: 'Invoices, credit notes and customer payments.' },
  { slug: 'purchases', label: 'Purchases', icon: ShoppingCart, permission: 'purchases:view', milestone: 2, blurb: 'Bills, vendor credits and supplier payments.' },
  { slug: 'expenses', label: 'Expenses', icon: Receipt, permission: 'expenses:view', milestone: 2, blurb: 'Expense claims and receipt capture.' },
  { slug: 'accounting', label: 'Accounting', icon: BookOpen, permission: 'journal:view', milestone: 2, blurb: 'Chart of accounts, journal, general ledger, periods.' },
  { slug: 'taxes', label: 'Taxes', icon: Banknote, permission: 'taxes:view', milestone: 2, blurb: 'GST/HST/QST/PST codes, rates and filing-period reports.' },
  { slug: 'reports', label: 'Reports', icon: BarChart3, permission: 'reports:view', milestone: 5, blurb: 'Financial statements, aging, tax and Shopify reports.' },
  { slug: 'contacts', label: 'Contacts', icon: Users, permission: 'sales:view', milestone: 2, blurb: 'Customers and suppliers.' },
  { slug: 'documents', label: 'Documents', icon: FileText, permission: 'documents:view', milestone: 2, blurb: 'Receipts, statements and supporting documents.' },
  { slug: 'settings', label: 'Settings', icon: Settings, permission: 'company:view', milestone: 1, blurb: 'Company, members, tax registration, security and audit log.' },
];
