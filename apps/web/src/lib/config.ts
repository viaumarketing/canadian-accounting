'use client';
import { useEffect, useState } from 'react';
import { api } from './api';

export interface PlanInfo { id: 'starter' | 'essentials' | 'plus'; name: string; tagline: string; maxCompanies: number; maxUsers: number; features: string[]; available: boolean; price: { amount: number; currency: string; interval: string } | null }
export interface PublicConfig { mode: 'selfhosted' | 'saas'; appName: string; trialDays?: number; signup?: boolean; plans?: PlanInfo[] }

/** Which edition this server runs (and, for SaaS, its plans). */
export function usePublicConfig() {
  const [c, setC] = useState<PublicConfig | null>(null);
  useEffect(() => { api<PublicConfig>('/config').then(setC).catch(() => setC({ mode: 'selfhosted', appName: 'Canadian Accounting' })); }, []);
  return c;
}

export const FEATURE_LABEL: Record<string, string> = { purchase_orders: 'Purchase orders', time: 'Time tracking', projects: 'Projects and profitability', inventory: 'Inventory (weighted-average cost)', tracking: 'Classes and locations', budgets: 'Budgets', shopify: 'Shopify integration' };
export const priceLabel = (p: PlanInfo['price']) => (p ? `${new Intl.NumberFormat('en-CA', { style: 'currency', currency: p.currency.toUpperCase() }).format(p.amount / 100)} / ${p.interval}` : 'Price shown at checkout');
