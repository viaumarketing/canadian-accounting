# Connecting Shopify

You create **your own Shopify app** (this software is self-hosted; there is no shared app). It only needs read access.

1. In Shopify, open the **Dev Dashboard** (dev.shopify.com) and create an app. Pick *custom distribution* for a single merchant or your own organization.
2. Set the **redirect URL** to `https://<your SITE_ADDRESS>/api/shopify/callback` (e.g. `https://ca.home.arpa/api/shopify/callback`). It must match exactly.
   OAuth happens in *your browser*, so a private hostname works; Shopify never calls this URL itself.
3. Scopes requested (read-only): `read_orders`, `read_shopify_payments_accounts`, `read_shopify_payments_payouts`, `read_shopify_payments_disputes`.
   - Shopify returns only the **last 60 days** of orders with `read_orders`. For full history your app needs `read_all_orders`
     (Shopify says apps in the Dev Dashboard under your own organization don't need approval; Partner-org apps must request it). Set `SHOPIFY_REQUEST_ALL_ORDERS=true` only once you have it.
   - Shopify Payments data requires the store to use Shopify Payments and the installing user to have the *view payouts* permission.
4. Copy the app's **Client ID** and **Client secret** into `.env` as `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`, and restart the API and worker.
5. In the app: **Shopify → Stores → Connect with Shopify**, enter `your-store.myshopify.com`, approve. An incremental sync starts; use **Historical sync** to import older data.

## Webhooks (optional)
Shopify can only call a **public HTTPS** URL. A private NAS deployment cannot receive them, and that is fine: the worker polls every 15 minutes, and "Sync now" is always available.
If you do expose an endpoint, set `SHOPIFY_WEBHOOK_BASE_URL=https://your.public.host`; subscriptions for orders/updated, orders/cancelled, refunds/create, disputes and app/uninstalled are registered when you connect.
Webhooks only *trigger* a pull; their payloads are never trusted as data. Shopify has no webhook for payouts, so those are always polled.

## Accounting you should know about
- Revenue is posted **once, from the order**, when its full payment has been captured. Payouts move money from *Shopify Payments Clearing* to your bank; they never touch revenue.
- A healthy clearing account trends to zero between payouts. A persistent balance means a payout, fee or adjustment is unposted: check **Needs review**.
- Processing fees are booked gross; GST/QST on the fee is not separated in this version.
- Anything uncertain (unknown tax name, partial payment, edited order, unmapped balance-transaction type, payout that doesn't tie out, locked period) stops in **Needs review** with the reason. Nothing posts silently.
- Orders edited in Shopify after posting are flagged; the journal is never rewritten. Reverse and re-post manually.
