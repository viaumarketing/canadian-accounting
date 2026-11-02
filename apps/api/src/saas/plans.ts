import type { PlanId } from '@ca/shared';

/** Features that are not in every plan (everything else is). */
export const FEATURES = ['purchase_orders', 'time', 'projects', 'inventory', 'tracking', 'budgets', 'shopify'] as const;
export type Feature = (typeof FEATURES)[number];

export interface Plan { id: PlanId; name: string; tagline: string; maxCompanies: number; maxUsers: number; features: readonly Feature[] }

/**
 * Plans and their limits. Prices are not here: they live in Stripe (STRIPE_PRICE_* name the Price objects), so the amount a
 * subscriber pays is always the one Stripe shows them. Self-hosted installations have no plans and every feature.
 */
export const PLANS: Record<PlanId, Plan> = {
  starter: { id: 'starter', name: 'Starter', tagline: 'Invoicing, expenses, banking and GST/HST for one business', maxCompanies: 1, maxUsers: 1, features: [] },
  essentials: { id: 'essentials', name: 'Essentials', tagline: 'Adds bills, purchase orders, time tracking and more users', maxCompanies: 1, maxUsers: 3, features: ['purchase_orders', 'time'] },
  plus: { id: 'plus', name: 'Plus', tagline: 'Adds inventory, projects, classes and locations, budgets and Shopify', maxCompanies: 3, maxUsers: 5, features: ['purchase_orders', 'time', 'projects', 'inventory', 'tracking', 'budgets', 'shopify'] },
};

/** Subscription states in which the organization may change its books. */
export function writable(o: { status: string; trialEndsAt: Date | null; stripeSubscriptionId: string | null }, now = new Date()) {
  if (o.status === 'active' || o.status === 'past_due') return true; // past_due: Stripe is still retrying the card
  if (o.status === 'trialing') return o.stripeSubscriptionId !== null || (o.trialEndsAt !== null && o.trialEndsAt > now);
  return false; // canceled, unpaid, incomplete, incomplete_expired, paused
}
