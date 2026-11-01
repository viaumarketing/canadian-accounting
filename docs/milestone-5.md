# Milestone 5 — Reporting and administration (plan)

## Principles
- **Every report is computed from POSTED journal lines** (plus document/Shopify tables only where a *supporting schedule* needs detail), and each report carries **checks** that tie it back to the ledger (e.g. balance sheet balances; aging total = A/R control account; cash-flow total = change in cash; tax schedule = tax accounts). A failing check is displayed, never hidden.
- Dashboards use the same functions as these reports (no separate totals).
- **Exports** (CSV, XLSX, PDF) are rendered from the same report object as the on-screen view; export needs `reports:export`.
- Tax output is **preparation support, not a filing**: no CRA/Revenu Québec submission is made or claimed.

## Verified CRA facts used (canada.ca, GST/HST return instructions)
Line 101 total sales and other revenue (excl. PST; excl. GST/HST under the regular method) · 103 GST/HST collected or collectible · 104 adjustments added · 105 = 103 + 104 · 106 ITCs · 107 adjustments deducted · 108 = 106 + 107 (regular filers) · 109 net tax = 105 − 108 · 110 instalments · 111 rebates · 205 / 405 self-assessments · 114 refund / 115 amount owing.
We compute **101, 103, 105, 106, 108, 109** from the ledger and leave **104, 107, 110, 111, 205, 405** as inputs you enter (they come from facts the ledger can't know). **Not verified:** the equivalent Revenu Québec (QST) form lines and provincial PST return layouts: those reports show components, not form line numbers.

## Reports
Profit & loss (period, prior-period / prior-year comparison) · Balance sheet (as-of, prior-year comparison) · Statement of cash flows (indirect) · Trial balance · General ledger · Journal report ·
A/R aging · A/P aging · GST/HST, QST and PST reports with supporting schedules and a tax-account roll-forward (reconciliation) · Expense report (by account, by supplier) · Revenue by sales channel ·
Shopify sales summary · Shopify processing fees · Shopify payout reconciliation · Bank reconciliation report (M4) · Cash-flow forecast (known obligations) · Year-over-year comparisons.

**Cash-flow classification** needs to know what is operating/investing/financing: `Account.cashFlow` (new, optional; template accounts are set; unset assets/liabilities default to operating, equity to financing).
**Forecast** only uses what the books know: bank balances, open invoices/bills by due date; overdue items are placed in week 1 (stated assumption). It makes no sales projection.

**Deferred / not in M5:** cash-basis reports (needs payment-to-revenue attribution, planned with year-end close), gross profit (accounts have no COGS flag yet), year-end closing, scheduled/e-mailed reports, report builder/custom columns, QST/PST form line numbers, multi-currency reporting.

## Administration
Company level (M1): members, roles, tax registration, settings, audit log (now filterable). System level (super admin only, metadata only — never financial data): users (activate/deactivate, unlock, revoke sessions, reset MFA, set temporary password, promote/demote with last-admin protection), company activation, system health (DB size/latency/migrations/connections), background-job status (sync jobs by state, queue counters when Redis is configured), integration errors (Shopify stores, bank connections), backup status (newest encrypted dump age/size from the read-only backup mount), container/version info, security events.

## Security
Report and export endpoints are tenant-guarded; exports are audited; CSV cells beginning with `= + - @` are neutralised (CSV injection); admin actions are audited, require super-admin, never expose password hashes or secrets, and protect the last active super admin; resetting another user's MFA or password revokes their sessions.

## Acceptance criteria
1. P&L, balance sheet and trial balance agree with each other; balance sheet balances (assets = liabilities + equity) after posting invoices, bills, payments, Shopify and bank entries; checks surface a deliberately broken tie-out.
2. Cash-flow statement's net change equals the change in bank-account balances.
3. Aging totals equal the A/R / A/P control accounts; payments after the as-of date don't reduce historical aging.
4. Tax reports: line 101/103/106/109 match hand-computed examples (ON HST, QC GST+QST, BC PST not recoverable); movements outside document sources are listed, not silently classified; roll-forward closes to the ledger balance.
5. Revenue-by-channel and Shopify summaries tie to revenue accounts.
6. CSV/XLSX/PDF exports of every report open correctly; CSV injection neutralised; export requires permission and is audited.
7. Admin: user actions audited and safe (last super admin, self-lockout); admin endpoints expose no financial data; non-super-admins get 403.
8. Tenant isolation and role permissions on every new route.

---

# Milestone 5 — Result

## Verified
`pnpm lint`, `typecheck`, `build` (incl. Next.js) and `test` pass: reporting 7, banking 25, tax 11, engine 9, shopify 27, shared 10, API 140 (real PostgreSQL), 229 in total. Browser pass: report hub and the GST/HST report on the dev database with passing ledger checks, system-administration panel.
PDF exports were rendered to images and inspected; two real defects found that way (non-Latin-1 symbols printing as stray glyphs, misaligned columns) and fixed.

## What was built
`@ca/reporting` (one report model; CSV with BOM and injection protection, XLSX with real numeric cells, A4 PDF) · 18 reports (see plan) behind `GET /companies/:id/report[/:key]?format=json|csv|xlsx|pdf` ·
tie-out **checks** on every report (balance sheet identity, net income recomputed, cash flow = bank movement, aging = control accounts, tax roll-forward = tax accounts, tax schedules = ledger, channel total = revenue, Shopify fees/payouts) ·
filing-period helper · cash-flow account classification (`Account.cashFlow`) · system admin: users (activate/deactivate, unlock, revoke sessions, reset MFA, temporary password, promote/demote, last-admin and self-lockout protection), company activation, system status (versions, DB size/latency/migrations/connections, job counters, queue counters, integration errors, dead jobs, backup status, security events) · screens for Reports, Users, System health · compose mounts the backup folder read-only for the status panel.

## Not done / not verified
- **Tax:** CRA lines 101/103/105/106/108/109 are computed; 104/107/110/111/205/405 are yours to enter. Quick-method and simplified-ITC filers calculate differently and are **not supported**. QST and PST are reported by component only; Revenu Québec and provincial return line numbers were **not verified**. Filing periods are computed from your fiscal year (confirm with your CRA account). Entries touching a tax account that did not come from invoices, bills, expenses, Shopify or bank categorisation (e.g. remittances, manual adjustments) are **listed for review**, not classified. Nothing is filed.
- **Deferred:** cash-basis statements, gross profit/COGS grouping, year-end closing (profit stays in "net income not yet closed"), scheduled or e-mailed reports, custom report builder, multi-currency reporting, report-level permissions beyond `reports:view/export`.
- The forecast contains **only known invoices and bills**; no sales, payroll, tax-remittance or Shopify-payout projections.
- Aging excludes documents voided *after* the as-of date for historical dates (void date isn't stored), which the control-account check will flag. Customer prepayments/unapplied receipts don't exist yet.
- Cash flow treats credit cards as operating liabilities unless an account is classified otherwise, and relies on `Account.cashFlow` (only the template's 1500/1510/2500 are pre-classified; there is no UI to change it yet, only the API/DB).
- PDF uses the built-in Latin-1 font: accents work, but non-Latin text prints as `?`. Very wide tables shrink rather than paginate sideways.
- Backup status only reads the file listing; it does **not** verify that a backup can be decrypted or restored (restore testing is Milestone 6). Queue counters, the hourly bank sync and the 15-minute Shopify schedule are still unproven without Redis.
- Docker images/compose remain unbuilt.

## Manual test script
1. Post a few invoices, bills and an expense (or use existing data). **Reports → Profit and Loss** (try *Same period last year*) and **Balance Sheet**: every check line is green; export each as CSV, XLSX and PDF and open them.
2. **Statement of Cash Flows**: *Net change in cash equals the change in your bank-account balances* is green.
3. **A/R Aging** as of an earlier date: payments after that date aren't applied. Post a manual entry straight to Accounts Receivable and re-run: the control-account check turns red with the amount.
4. **GST/HST Report**: lines 101–109; enter instalments (line 110) in "Amounts only you know"; post a remittance journal (Dr GST/HST Payable, Cr bank) and see it under *Other movements*.
5. With Shopify connected: **Shopify Sales Summary**, **Processing Fees**, **Payout Reconciliation**, **Revenue by Sales Channel**.
6. Sign in as platform admin → **System administration → Users**: reset a test user's MFA, set a temporary password, try to deactivate yourself (refused). **System health** shows DB, jobs, integration errors and backup status (set `BACKUP_DIR` to see it).
