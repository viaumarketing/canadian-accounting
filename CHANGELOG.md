# Changelog

Versions follow `MAJOR.MINOR.PATCH`. Each release's plan, test results and limits are in `docs/`.

## 1.0.1 — 2026-11-02

QuickBooks-class features and the SaaS edition. Details and results: [docs/v1.0.1.md](docs/v1.0.1.md).

### Added
- **E-mail (Resend)**: send invoices, sales receipts, estimates, purchase orders and statements with the PDF attached;
  per-company sender name, reply-to and wording; a delivery log. Nothing is reported sent unless Resend accepted it.
- **Branding**: logo upload (PNG/JPEG, checked by content), accent colour, three document layouts, footer, payment
  instructions, live preview.
- **Customer invoice link** (`/i/<token>`): view, download, and **Pay now** by card.
- **Card payments** through each company's own Stripe account: Checkout, signed webhooks (HMAC-SHA256, 5-minute
  tolerance, duplicate events ignored), automatic recording to a Stripe Clearing account, review hold for payments that
  no longer fit the invoice.
- **Undeposited Funds and bank deposits**, with fee lines.
- **Estimates**: accept, decline, convert to invoice.
- **Recurring transactions** for invoices, bills and expenses (draft, post, or post and e-mail), run hourly by the worker.
- **Customer statements** (balance-forward and open-item, with aging), **overdue reminders** and **late fees**.
- **Inventory** at weighted-average cost: quantity on hand, COGS posted automatically, adjustments, low stock, valuation
  checked against the ledger.
- **Purchase orders**, a full-page **bill editor** with draft editing, **pay bills**, and **credits applied** to invoices
  and bills.
- **Projects and time**: timesheets, billable time and costs added to invoices once, project profitability.
- **Classes and locations** on documents and journal lines; **P&L by class / by location**; **budgets** and
  **budget vs. actual**; **dashboard charts**.
- **SaaS edition** (`APP_MODE=saas`): sign-up with e-mail confirmation, 30-day trial, plans with user, company and
  feature limits, Stripe subscriptions and customer portal, webhooks, read-only on lapse, home and pricing pages, a
  subscribers console for platform administrators.
- New documentation: `docs/email.md`, `docs/payments.md`, `docs/saas.md`; a new README.

### Changed
- All packages are versioned 1.0.1.
- The Expenses section gains Bills, Purchase orders and Pay bills tabs; Sales gains Estimates and Recurring; Banking gains
  Bank deposits; a new Projects & time section; Reports gains By class / location and Budgets.
- The **+ New** menu lists every new transaction type.
- Journal lines carry class, location and project.

### Database
- One migration, `20261108000000_v101_features`, **additive** (new tables, nullable or defaulted columns, no new values on
  existing enum types): a rollback to 0.9.2 stays app-only.

### Security
- 98 new routes, each with an explicit permission, covered by the generated tenant-isolation and role-matrix tests. The
  pinned route snapshot was reviewed.
- New public routes (the reviewed list): `GET /config`, sign-up and e-mail confirmation, the customer invoice link (by
  unguessable token, rate-limited), and two Stripe webhooks (signature-checked).

### Not included
Payroll, multi-currency, FIFO inventory, Stripe Connect, automatic import of Stripe payouts.

## 0.9.2

QuickBooks Online–style interface; sales receipts; products and services; printable invoices. See [docs/v0.9.2.md](docs/v0.9.2.md).

## 0.9.1

zod 4; year-end close and reopen; GST/HST Quick Method; operations hardening. See [docs/v0.9.1.md](docs/v0.9.1.md).

## 0.9.0

Milestones 1–6: foundation, accounting core, Shopify, banking, reporting, security, packaging, backups and the UGREEN
DXP2800 deployment profile. See `docs/milestone-1.md` … `docs/milestone-6.md` and [docs/dxp2800.md](docs/dxp2800.md).
