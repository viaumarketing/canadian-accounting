# SaaS edition

One codebase, two editions:

| | `APP_MODE=selfhosted` (default) | `APP_MODE=saas` |
|---|---|---|
| Accounts | the first administrator creates companies and users | anyone signs up at `/signup` |
| Billing | none | Stripe subscriptions, 30-day trial |
| Limits | none, every feature | per plan |
| Home page for visitors | sign in | `/welcome` and `/pricing` |

## Plans

Defined in `apps/api/src/saas/plans.ts`. Prices are **not** in the code: each plan names a Stripe Price
(`STRIPE_PRICE_STARTER`, `…_ESSENTIALS`, `…_PLUS`), and the pricing page shows what Stripe has for it.

| Plan | Users | Companies | Adds |
|---|---|---|---|
| Starter | 1 | 1 | invoicing, estimates, receipts, card payments, recurring, statements, reminders, expenses, bills, banking, deposits, GST/HST/QST/PST, reports |
| Essentials | 3 | 1 | purchase orders, time tracking |
| Plus | 5 | 3 | projects, inventory, classes and locations, budgets, Shopify |

Users are counted across all the organization's companies. A feature outside the plan answers `403 PLAN_FEATURE`; a user
or company over the limit answers `403 PLAN_LIMIT`.

## Subscription states

- **Trial**: `SAAS_TRIAL_DAYS` from sign-up, no card. Subscribing during the trial carries the remaining days over
  (`subscription_data[trial_period_days]`).
- **active**, **past_due** (Stripe is still retrying the card): full access.
- **canceled**, **unpaid**, **incomplete**, **incomplete_expired**, **paused**, or a trial that ended without a
  subscription: **read-only**. Every page and export still works; changes answer `402 SUBSCRIPTION_INACTIVE`.

## Setting it up

1. Stripe (the platform's own account, not a customer's): create a Product per plan with a recurring monthly Price in
   CAD; put the three `price_…` ids in `.env`.
2. Turn on the **customer portal** (Stripe → Settings → Billing → Customer portal) so subscribers can change plan, update
   their card and cancel.
3. Webhook endpoint `https://<site>/api/webhooks/stripe-billing` with the events `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`; put its signing
   secret in `STRIPE_WEBHOOK_SECRET`.
4. E-mail must work (docs/email.md): sign-up sends a confirmation link and refuses to start without it.
5. `APP_MODE=saas`, `APP_NAME=<your product name>`, `STRIPE_SECRET_KEY=sk_live_…`. Restart.
6. Visit the site and create the **platform administrator** first (`/setup`), before anyone signs up. The administrator
   sees subscribers under System administration → Subscribers (plan, status, usage, trial extension) and, as always,
   **no company's books**.

## Before selling subscriptions

The SaaS edition has the mechanics; selling it also needs things outside the code: terms of service and a privacy policy
(PIPEDA, and Québec's Law 25 if you have Québec customers), GST/HST registration and collection on your own
subscription sales (configure Stripe Tax or include tax in your prices), hosting in a data centre with backups you have
restored, and an incident and support process. Payroll is not included.
