# Canadian Accounting

**Version 1.0.1** · accounting for Canadian small businesses, in the browser.

It covers invoicing, estimates, bills, banking, inventory, projects and GST/HST/QST/PST on a double-entry ledger that cannot be
edited after posting. It runs in two editions from one codebase:

- **Self-hosted** (`APP_MODE=selfhosted`, the default): your own companies on your own hardware, built and sized for a
  UGREEN DXP2800 NAS. No subscriptions, every feature.
- **SaaS** (`APP_MODE=saas`): public sign-up, a free trial, and plans sold as Stripe subscriptions.

The interface follows the layout of QuickBooks Online: a left navigation, a **+ New** menu, a Sales hub with a money bar,
and full-page invoice editors. It does not copy Intuit's name, logo or other brand assets.

---

## Contents

- [Features](#features)
- [What it does not do](#what-it-does-not-do)
- [Quick start (development on a Mac)](#quick-start-development-on-a-mac)
- [Production on a UGREEN NAS](#production-on-a-ugreen-nas)
- [Configuration](#configuration)
- [Integrations](#integrations)
- [Selling it as a service (SaaS edition)](#selling-it-as-a-service-saas-edition)
- [How it is built](#how-it-is-built)
- [Accounting and security guarantees](#accounting-and-security-guarantees)
- [Quality gates](#quality-gates)
- [Releases and upgrades](#releases-and-upgrades)
- [Status: what has and has not been verified](#status-what-has-and-has-not-been-verified)
- [Documentation](#documentation)

---

## Features

### Sales
- **Invoices and credit notes**: terms (Due on receipt, Net 15/30/60), billing address, products and services, service
  dates, amounts with or without tax, a message and an internal memo, drafts you can edit, posting and voiding.
- **Estimates**: numbered EST-0001…, sent by e-mail, marked accepted or declined, and **converted to an invoice in one
  click**.
- **Sales receipts**: paid at the time of sale, deposited to a bank account or to Undeposited Funds.
- **E-mail any document**: PDF attached, your logo and wording, a **customer link** to view and download the invoice and
  **pay by card**. Every send is logged with the provider's id or its error.
- **Recurring transactions**: invoices, bills and expenses on daily, weekly, monthly or yearly schedules. Each run creates
  a draft, posts it, or posts and e-mails it (invoices). Missed dates are caught up; a schedule pauses itself with the reason
  if it can no longer run.
- **Customer statements**: balance-forward or open-item, with aging, as a PDF or by e-mail.
- **Collections**: automatic overdue reminders (up to five stages, each sent once per invoice), and optional **late fees**
  (flat or percent, once per invoice, after a grace period).
- **Credit notes applied to invoices**, with no journal entry needed (both are already in A/R) and undoable.
- **Card payments** through the company's own Stripe account, recorded automatically from the signed webhook.
- Sales hub with **All sales**, a money bar (overdue / not due yet / paid in 30 days), customers with balances, and
  products and services.

### Purchases and expenses
- **Bills and supplier credits** in a full-page editor: products, accounts, tax, billable-to customer, class and project per
  line; drafts are editable.
- **Purchase orders**: numbered PO-0001…, printed and e-mailed, **converted to a bill** when the goods and invoice arrive.
- **Pay bills**: tick several bills and record one payment per supplier, all or nothing.
- **Supplier credits applied to bills.**
- **Expenses** with a submit → approve → post flow (the approver cannot be the submitter).
- **Billable costs**: mark a bill or expense line billable to a customer and add it to their next invoice.

### Banking
- Bank and credit-card accounts, **CSV/OFX statement import**, optional bank feeds (Plaid), matching rules,
  **reconciliation**.
- **Undeposited Funds and bank deposits**: group cheques, cash and card payments into the one deposit that appears on the
  bank statement, with fees as negative lines.

### Inventory
- **Inventory products** with quantity on hand, weighted-average cost, inventory asset and cost-of-goods-sold accounts,
  and reorder points.
- Bills bring stock in at cost (including non-recoverable tax); invoices and sales receipts post **cost of goods sold**
  automatically; credit notes and supplier credits move stock back. Stock never goes negative.
- **Adjustments** (counts, shrinkage, opening stock), **low-stock** list, **valuation summary checked against the ledger**,
  and the movement history.

### Projects and time
- **Projects** per customer with a cost budget and status.
- **Timesheets**: hours by person, project, customer and service, billable or not, with a rate. Everyone logs their own;
  managers can log and see everyone's.
- **Add billable time and costs to an invoice**, each billed only once (voiding the invoice releases them).
- **Project profitability** from the ledger: income, costs, profit, margin and hours.

### Reports, budgets and tracking
- Balance sheet, income statement, cash flow, trial balance, general ledger, A/R and A/P aging, sales tax, revenue by
  channel and Shopify reports, exported to **CSV, Excel and PDF**.
- **Classes** (per line) and **locations** (per transaction), with **profit and loss by class** and **by location**.
- **Budgets** by account and month, and **budget vs. actual**.
- **Dashboard charts**: 12 months of income and expenses, A/R aging, bills owed, bank balances.

### Canadian tax
- GST, HST, QST and PST codes with **effective-dated rates** from CRA and Revenu Québec sources; recoverable ITCs/ITRs
  versus tax added to cost; place of supply by province.
- GST/HST return figures by line with schedules and consistency checks; the **Quick Method** (RC4058).
- Registration numbers printed on every document.

### Books and administration
- Chart of accounts (a Canadian template), journal entries, accounting periods and locks, **year-end close and reopen**.
- **Multi-company**: one login, several companies, a role per company (owner, admin, accountant, bookkeeper, finance
  manager, employee, read-only auditor).
- **Branding**: logo, accent colour, three layouts (modern, classic, compact), footer, payment instructions, e-mail wording.
- **Shopify**: orders, refunds, payouts, fees, disputes and gift cards posted and reconciled.
- System administration: users, companies, health, resource monitoring, backups; in the SaaS edition, subscribers.

## What it does not do

- **Payroll** (source deductions, T4, ROE). Canadian payroll needs CRA payroll tables and filings; use a payroll provider and
  post its journal.
- Multi-currency (every company has one currency, CAD by default).
- FIFO inventory, assemblies or bundles.
- Stripe Connect (each company uses its own Stripe account), and automatic import of Stripe payouts. Record payouts as bank
  deposits.
- Mobile apps.

## Quick start (development on a Mac)

Full walkthrough: [docs/macos-setup.md](docs/macos-setup.md).

```bash
cp .env.example .env            # then fill in ENCRYPTION_KEY (openssl rand -base64 32) and the database URL
pnpm install
docker compose up -d            # PostgreSQL and Redis on 127.0.0.1 only
pnpm build:packages
pnpm db:deploy                  # apply migrations
pnpm dev:api                    # http://localhost:4000
pnpm dev:web                    # http://localhost:3000  → create the first administrator
```

Requirements: Node 22, pnpm 10, Docker Desktop.

## Production on a UGREEN NAS

Target: **UGREEN DXP2800** (Intel N100, 8 GB RAM). Images (`server`, `web`, `backup`, linux/amd64) are built by GitHub
Actions and pulled from GHCR; nothing is compiled on the NAS.

- **Step-by-step guide for beginners: [docs/dxp2800-install-guide.md](docs/dxp2800-install-guide.md)**
- Ports, certificates, folders: [docs/ugreen-nas.md](docs/ugreen-nas.md)
- Sizing, load tests and the production-readiness gate: [docs/dxp2800.md](docs/dxp2800.md)
- Backups (encrypted, nightly, with a copy to a second folder), restore tests, disaster recovery, upgrade and rollback:
  [docs/backup-and-recovery.md](docs/backup-and-recovery.md)

```bash
./scripts/install.sh            # asks for the folder, site name and release; generates secrets; starts everything
./scripts/upgrade.sh 1.0.1      # backs up, migrates, switches images, checks health
./scripts/rollback.sh           # back to the previous release (app-only when the schema allows it)
```

Keep it private: reach it over a VPN rather than forwarding ports. **Save `.env.production` somewhere else**: without
`ENCRYPTION_KEY` and `BACKUP_PASSPHRASE` the backups cannot be restored.

Card payments and the SaaS edition need webhooks from Stripe, which need a public HTTPS address; a LAN-only NAS can run
everything else.

## Configuration

Everything is set in `.env` (development) or `.env.production` (NAS). The templates `.env.example` and
`.env.production.example` list every key with a comment.

| Key | Needed for | Notes |
|---|---|---|
| `DATABASE_URL`, `REDIS_URL` | always | set by the compose file in production |
| `ENCRYPTION_KEY` | always | 32 bytes, base64; encrypts MFA secrets and integration keys (Stripe, Plaid, Shopify) |
| `WEB_ORIGIN` | always | the address people use; also used in e-mailed links and Stripe redirect URLs |
| `SETUP_TOKEN` | optional | required to create the first administrator, if set |
| `RESEND_API_KEY`, `MAIL_FROM` | e-mail | see [docs/email.md](docs/email.md) |
| `APP_MODE`, `APP_NAME` | edition | `selfhosted` (default) or `saas` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*`, `SAAS_TRIAL_DAYS` | SaaS edition only | the platform's Stripe account; see [docs/saas.md](docs/saas.md) |
| `SHOPIFY_*` | Shopify | [docs/shopify-setup.md](docs/shopify-setup.md) |
| `PLAID_*` | bank feeds | [docs/banking-setup.md](docs/banking-setup.md) |
| `WORKER_CONCURRENCY`, `SYNC_MAX_BACKLOG`, `BANK_MAX_PAGES_PER_RUN` | tuning | sized for the N100 by default |

A company's own Stripe keys are **not** environment variables: they are entered in the app (Settings → Online payments)
and stored encrypted.

## Integrations

| Service | Used for | Set up | Verified live? |
|---|---|---|---|
| **Resend** | sending e-mail | [docs/email.md](docs/email.md) | **No**: built from the API reference, tested against a strict fake |
| **Stripe** (company's account) | Pay now on invoices | [docs/payments.md](docs/payments.md) | **No**: run one test-mode payment first |
| **Stripe** (platform account) | SaaS subscriptions | [docs/saas.md](docs/saas.md) | **No** |
| **Shopify** | orders, payouts, fees | [docs/shopify-setup.md](docs/shopify-setup.md) | No live store connected yet |
| **Plaid** | bank feeds (optional) | [docs/banking-setup.md](docs/banking-setup.md) | Sandbox only |

Each integration is written from the provider's official documentation, and nothing pretends to work when it is not
configured: the app says so plainly.

## Selling it as a service (SaaS edition)

Set `APP_MODE=saas`. Visitors see a home page and pricing; they sign up with e-mail confirmation and get a 30-day trial,
no card needed. They subscribe through Stripe Checkout and manage the subscription in Stripe's customer portal. Plans
(Starter, Essentials, Plus) limit users, companies and features. A lapsed subscription makes the books **read-only**, never
deleted. Platform administrators see subscribers and usage, and still cannot open any customer's books.

Details, the Stripe set-up and the non-code things you need before selling (terms, privacy under PIPEDA and Québec's
Law 25, tax on your own subscriptions, hosting and backups): **[docs/saas.md](docs/saas.md)**.

## How it is built

A TypeScript monorepo (pnpm workspaces):

| Path | What |
|---|---|
| `apps/web` | Next.js 15 interface (React, Tailwind, Radix) |
| `apps/api` | NestJS 11 API: auth, tenancy, ledger, documents, banking, Shopify, reports, SaaS |
| `apps/worker` | BullMQ worker: Shopify and bank syncs, recurring transactions, reminders, late fees |
| `packages/accounting-engine` | balance checks and document → journal builders |
| `packages/canadian-tax` | effective-dated GST/HST/QST/PST calculation |
| `packages/reporting` | report model; CSV, Excel and PDF renderers; customer documents and statements |
| `packages/banking` | CSV/OFX parsing, matching, reconciliation, Plaid adapter |
| `packages/shopify-integration` | Shopify OAuth, GraphQL client, posting rules |
| `packages/shared` | Zod validation schemas, roles and permissions |
| `packages/database` | Prisma schema and migrations (PostgreSQL 17) |
| `infrastructure/`, `compose.production.yaml`, `scripts/` | images, Caddy, backups, install/upgrade/rollback |

Architecture and the security model: [docs/architecture.md](docs/architecture.md).

## Accounting and security guarantees

- **One posting path.** Every document posts through the same ledger service, which checks balance, accounts and open
  periods. The database re-checks balance and **refuses edits to posted entries**: corrections are reversals.
- **Exact arithmetic.** Money is decimal end to end (strings in the API, `decimal.js`, `NUMERIC` columns), never floating
  point.
- **Gap-free numbering** per company for journals, invoices, bills and receipts.
- **Tenant isolation.** Every query is scoped to a company the user belongs to; another company's records answer 404.
  This is proven by tests generated from every route.
- **Super administrators get no access to company books.** Platform administration and company access are separate.
- **Permissions** per role on every company route, pinned in a reviewed snapshot (`apps/api/test/route-permissions.snap.txt`).
- Sessions in httpOnly cookies, CSRF origin checks, Argon2id passwords, optional TOTP with recovery codes, account
  lock-out, rate limits, an **append-only audit log**, encrypted integration keys, signed webhooks (Shopify, Stripe),
  PostgreSQL and Redis never exposed.

Details and known gaps: [docs/security.md](docs/security.md).

## Quality gates

Run on every push by GitHub Actions (`.github/workflows/ci.yml`), and locally:

```bash
pnpm lint
pnpm typecheck
pnpm test                                  # unit tests + API integration tests on a real PostgreSQL
node scripts/check-migrations.mjs          # every migration declares itself additive or breaking
```

The API suite (more than 210 tests) includes generated security tests: every route without a session answers 401, every
company route answers 404 for another company's data, every role gets exactly the permissions in the matrix, and the
public and webhook routes are an explicit, reviewed list.

## Releases and upgrades

- Version **1.0.1**. History: [CHANGELOG.md](CHANGELOG.md).
- Tagging `vX.Y.Z` on `main` runs the release workflow: the full verification, then images pushed to GHCR as `X.Y.Z` and
  `X.Y`. There is no floating `latest`: upgrades are deliberate.
- Migrations are **additive** wherever possible, so the previous release still runs on an upgraded database and a rollback
  does not need a restore. 1.0.1's migration is additive.

## Status: what has and has not been verified

**Verified:** the full automated suite, production image builds, the Docker deployment on linux/amd64, backup and restore
drills on a workstation, load tests sized for the N100, and walk-throughs of the new screens in a browser.

**Not yet verified, and required before you rely on it for real books:**
- an installation on the DXP2800 itself, with a restore from its own backups;
- a live Shopify payout reconciled;
- a real bank statement reconciled;
- one real e-mail through Resend, and one Stripe test-mode payment (and, for SaaS, one subscription);
- your accountant's review of the tax codes and the chart of accounts for your business.

Until these pass, treat the application as **not production-ready**. The checklist is in [docs/dxp2800.md](docs/dxp2800.md).

## Documentation

| Topic | Document |
|---|---|
| 1.0.1 plan and results | [docs/v1.0.1.md](docs/v1.0.1.md) |
| E-mail | [docs/email.md](docs/email.md) |
| Card payments, Undeposited Funds, deposits | [docs/payments.md](docs/payments.md) |
| SaaS edition | [docs/saas.md](docs/saas.md) |
| NAS installation (beginner) | [docs/dxp2800-install-guide.md](docs/dxp2800-install-guide.md) |
| NAS details, sizing, readiness gate | [docs/ugreen-nas.md](docs/ugreen-nas.md), [docs/dxp2800.md](docs/dxp2800.md) |
| Backups and recovery | [docs/backup-and-recovery.md](docs/backup-and-recovery.md) |
| Security | [docs/security.md](docs/security.md) |
| Architecture | [docs/architecture.md](docs/architecture.md) |
| Shopify, banking set-up | [docs/shopify-setup.md](docs/shopify-setup.md), [docs/banking-setup.md](docs/banking-setup.md) |
| Development on a Mac | [docs/macos-setup.md](docs/macos-setup.md) |
| Dependencies | [docs/dependencies.md](docs/dependencies.md) |
| Earlier releases | [docs/v0.9.1.md](docs/v0.9.1.md), [docs/v0.9.2.md](docs/v0.9.2.md), milestones 1–6 in `docs/` |
