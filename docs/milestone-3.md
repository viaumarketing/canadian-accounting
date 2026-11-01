# Milestone 3 — Shopify (plan)

## What was verified, and how
Everything Shopify-specific below was checked against shopify.dev docs **and the live Admin GraphQL schema for API version 2026-10**
(downloaded via shopify.dev's public introspection proxy). `packages/shopify-integration/scripts/validate-queries.mjs` re-validates every
query we send against that schema (`pnpm --filter @ca/shopify-integration validate:queries`). **No live Shopify store was available**, so
nothing here has run against real Shopify data; tests use synthetic fixtures shaped like the verified schema.

Confirmed facts that shape the design:
- OAuth authorization-code grant; callback `hmac` + `state` + `shop` regex checks; new apps must request **expiring offline tokens** (`expiring=1`) and refresh them (`grant_type=refresh_token`).
- Scopes: `read_orders` (only last 60 days), `read_all_orders` (approval/Dev Dashboard), `read_shopify_payments_accounts`, `read_shopify_payments_payouts` (payouts + balance transactions), `read_shopify_payments_disputes`.
- Webhooks: `X-Shopify-Hmac-Sha256` = base64 HMAC-SHA256 of the raw body keyed by the app secret; dedupe on `X-Shopify-Webhook-Id`; headers `X-Shopify-Topic`, `X-Shopify-Shop-Domain`; 5 s response budget; 8 retries then subscription deletion. **There is no payout webhook topic**, so payouts and balance transactions are always polled.
- Throttling: leaky-bucket; responses carry `extensions.cost.throttleStatus {maximumAvailable, currentlyAvailable, restoreRate}`; recommended back-off 1 s.
- Payout `summary` gives charges/refunds/adjustments/reserved-funds/advance gross+fee, which drives the reconciliation screen.

## Scope
Store connection (OAuth, encrypted tokens, refresh), historical + incremental + manual sync of orders, transactions, refunds, Shopify Payments
payouts, balance transactions and disputes; verified webhooks as *triggers*; accounting for sales, tax, shipping, gift-card sales, refunds,
processing fees, payouts, reserves and chargeback holds through a clearing account; payout reconciliation view.

**Deferred / not in M3:** matching payouts to bank deposits (needs the banking module, Milestone 4: the payout screen exposes the data and a `matchedBankTransaction` slot);
multi-currency stores (non-CAD shops are refused at connect); `ImportBatch` model (Milestone 4 statement imports); splitting GST/QST on processing fees;
gift-card *redemption* accounting beyond clearing/liability posting; per-gateway reconciliation for third-party gateways beyond a separate clearing account; POS/tender specifics; Shopify Capital/advances (flagged for review).

## Accounting rules (the part that must be right)
1. **Revenue is recognised once, from the order**, when captured payments (SALE/CAPTURE, status SUCCESS, shop currency) equal the order total. Dr clearing (Shopify Payments → *Shopify Payments Clearing*; any other gateway → *Third-party Gateway Clearing*), Cr Sales, Cr Shipping revenue, Cr Gift Card liability (gift-card line items), Cr GST/HST/QST/PST payable by tax-line title.
   Net sales = order total − tax − gift cards − shipping, so the entry always equals what the customer paid; discounts are netted (reported as data, not a contra account).
2. **Refunds** post from Shopify refund records: Dr Sales Returns, Dr tax payable (taxes from the refund line items, allocated across components in the order's own proportions), Cr clearing for the refund transactions.
3. **Balance transactions never re-post sales or refunds.** `CHARGE`/`REFUND` types only contribute their *fee* (Dr Processing Fees, Cr clearing) and are used to verify lineage. Reserves, chargeback holds, chargeback fees and shipping labels have fixed mappings; **every other type is `NEEDS_REVIEW`** and posts only after a human assigns an account.
4. **Payouts** post when `PAID`: Dr Bank, Cr clearing (reverse for withdrawals), but only when Σ(net of its balance transactions) equals the payout net; otherwise `NEEDS_REVIEW`.
5. Nothing uncertain posts silently: unmapped tax titles, tax totals that don't tie, partial/pending payments, locked periods, orders edited after posting, and unmapped balance-transaction types all become `NEEDS_REVIEW` with a reason.
6. Duplicate protection in three layers: unique `(storeId, shopifyId)`, one journal per source row (`journalEntryId` unique), and a database unique index on `(companyId, sourceType, sourceId)` for `shopify_*` journals.

## Database
ShopifyStore, ShopifyOAuthState, ShopifyOrder, ShopifyTransaction, ShopifyRefund, ShopifyPayout, ShopifyBalanceTransaction, ShopifyDispute, ShopifySyncJob, ShopifyWebhookEvent. All carry `companyId`.

## Security
Tokens AES-256-GCM encrypted (`ENCRYPTION_KEY`); OAuth `state` is single-use, bound to user+company, 10 min; callback HMAC and shop-domain regex verified; webhook HMAC verified on the raw body with timing-safe compare; a shop domain can be connected to only one company; all routes are tenant-guarded and permission-checked (`shopify:*`); credentials never returned by any API.

## Acceptance criteria
1. Webhook with bad/missing HMAC → 401; duplicate `X-Shopify-Webhook-Id` processed once.
2. OAuth callback rejects bad state / bad HMAC / bad shop domain; tokens stored encrypted.
3. Syncing the same orders/payouts twice (or via webhook + poll) creates no duplicate rows and no duplicate journals.
4. A paid order posts exactly one balanced journal; revenue + tax + shipping + gift-card figures match the order; the trial balance clearing account = captured − fees − payouts.
5. Refund posts once and reduces revenue/tax; fees, reserves, chargeback holds and payouts post per the rules; unmapped types wait for review.
6. Rate-limit (HTTP 429 / THROTTLED) and transient errors are retried with back-off; exhausted jobs end `DEAD` with the error recorded.
7. Payout detail shows source transactions, gross, fees, refunds, adjustments, reserves, net, tie-out status and posting status.
8. Tenant isolation and role permissions hold on every new route.

---

# Milestone 3 — Result

## Verified
`pnpm build` (incl. Next.js), `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass: shopify-integration 27, engine 9, tax 11, shared 10, API 86 (real PostgreSQL + in-process fake Shopify).
All six GraphQL documents validate against the real 2026-10 schema. A browser pass confirmed the store, payout-reconciliation and review screens against a database seeded through the real OAuth + sync + posting code.

## What was built
`@ca/shopify-integration` (OAuth helpers, webhook HMAC, throttle-aware GraphQL client with cursor pagination, mappers, pure posting rules) · schema + migration (10 tables, DB-level one-journal-per-source and one-active-job indexes) ·
store connection with encrypted, auto-refreshing expiring tokens · webhook receiver (raw-body HMAC, dedupe, collapse bursts) · sync engine (historical/incremental/manual, watermarks, per-record error log, progress, FAILED→DEAD) ·
posting of sales/tax/shipping/gift cards/refunds/fees/reserves/holds/payouts through clearing accounts · review queue with human classification · payout reconciliation endpoint and screen · worker that runs the same Nest modules headless under BullMQ with a 15-minute scheduler · Shopify screens.

## Not done / not verified (read this)
- **Never run against a real Shopify store.** Request/response shapes were checked against the published schema and docs, but live behaviour (cost limits, field edge cases, real tax-line titles, how `associatedPayout` relates to the payout's own TRANSFER line) is unproven. The first real sync will likely surface items in *Needs review*; that is the safety net working.
- **BullMQ/Redis path is untested** (no Redis available here). Tests use `QUEUE_MODE=none` and call `runJob` directly. The worker entry, retry back-off and scheduler need a first run with Redis; DEAD jobs are recorded in the database, not left in BullMQ's failed set.
- Docker images and compose still never built (worker now also needs `@ca/api` in its image; the multi-target Dockerfile builds it, untested).
- **Bank deposit matching** is Milestone 4 (the payout view returns `bankMatch: null`). `ImportBatch` also moves to M4.
- Processing-fee tax (GST/QST) is booked inside the fee expense, not as an ITC. Discounts are netted into sales, not a contra account. Gift-card *redemption* relies on the gateway name `gift_card` (my understanding, not confirmed in docs).
- Refund tax is allocated across components in the order's own proportions (the refund line items give a total only); a refund with `restock`/order adjustments that doesn't tie out goes to review.
- Orders with more than 100 line items, 10 shipping lines, or 20 refunds are flagged/limited (truncation is detected for line items and shipping; the `refunds`/`transactions` list fields cannot signal truncation, but the payment tie-out would flag the order).
- Only CAD stores are accepted; Shopify Markets/multi-currency and FX are deferred. POS, draft orders, subscriptions, and Capital/advances are not handled specially (unmapped types go to review).
- Token refresh handles Shopify's documented expiring-token flow; a refresh failure marks the job DEAD and the store ERROR (reconnect required). Access-scope loss is detected only when a call fails.
- Shopify Payments payout schedule changes, multiple Shopify Payments currencies per store, and the `business entity` field are not modelled.

## Manual test script
1. Follow `docs/shopify-setup.md` with a Shopify development store (Shopify Payments Bogus gateway orders are *test* orders and are skipped by design; use real test-mode Shopify Payments data if available).
2. Shopify → Connect; after approval check **Stores** (health), then **Import health** (job progress, throttle counts, errors).
3. **Orders** shows posting state per order; Accounting → Trial balance should show Sales, Shipping, GST/HST payable, Processing fees, and **Shopify Payments Clearing** near zero once payouts are posted.
4. **Payouts → Reconcile** on a paid payout: components, tie-out, per-transaction posting state.
5. **Needs review**: assign an account to an unmapped balance transaction and watch it post once.
6. Press **Sync now** repeatedly: no duplicate journals. Disconnect and reconnect: data is kept, no duplicates.
