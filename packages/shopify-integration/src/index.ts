export * from './types';
export * from './oauth';
export * from './webhook';
export * from './queries';
export * from './client';
export * from './mappers';
export * from './posting';

/** OAuth scopes we request; read-only. `read_all_orders` is opt-in because it needs Shopify approval for most apps. */
export function requiredScopes(opts: { allOrders: boolean }): string[] {
  return ['read_orders', ...(opts.allOrders ? ['read_all_orders'] : []), 'read_shopify_payments_accounts', 'read_shopify_payments_payouts', 'read_shopify_payments_disputes'];
}
