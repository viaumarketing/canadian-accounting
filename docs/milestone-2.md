# Milestone 2 — Accounting core (plan)

## Scope (this milestone)
Chart of accounts (Canadian template + custom/sub-accounts), accounting periods, manual journals (draft → post → reverse),
contacts, tax codes with **effective-dated** per-component rates, invoices / credit notes, bills / vendor credits,
payments with allocations (partial payments), expenses with an approval workflow, trial balance, general ledger, journal report.

**Explicitly deferred** (not implemented in M2, listed so nothing is implied): multi-currency & FX differences, year-end close,
cash-basis reporting, receipt/file attachments, applying credit notes against invoices, prepayments / unallocated payments,
opening-balance wizard (opening balances are entered as an ordinary journal), PDF/CSV/XLSX export (Milestone 5), web UI beyond
a minimal set of screens.

## Architecture
- `packages/canadian-tax` — pure functions: rate lookup by date, per-component tax calc (exclusive / inclusive), jurisdiction helper.
- `packages/accounting-engine` — pure functions: balance validation, document → journal-line builders (invoice, bill, expense, payment).
- `apps/api` — Nest modules `accounting` (accounts, periods, journals, reports), `contacts`, `tax`, `sales`, `purchases`, `expenses`, `payments`.
  All persistence and number assignment inside one DB transaction per business operation.
- Money: `NUMERIC(19,4)` in PostgreSQL, `decimal.js` in code, **no floats**. Amounts cross the API as strings. Tax is rounded half-up to cents per component per line.

## Database changes
Account, AccountingPeriod, JournalEntry, JournalLine, Contact, TaxCode, TaxRate, Invoice, InvoiceLine, Bill, BillLine,
Payment, PaymentAllocation, Expense, ExpenseLine, Sequence. All carry `companyId`.
DB-level guarantees (triggers/CHECKs): a POSTED journal cannot be updated or deleted; its lines cannot change; posting requires
≥2 lines with Σdebit = Σcredit > 0; a line has exactly one of debit/credit > 0.

## Security
Permissions: view / create / post / approve / reverse per area, from the M1 matrix (bookkeeper drafts, accountant posts).
Every route is under `/companies/:companyId` and guarded by M1's tenant guard; every query filters by `companyId`; foreign ids in
request bodies (account, contact, tax code…) are verified to belong to the same company. Everything posted/reversed/locked is audited.

## Acceptance criteria
1. Posted journals always balance; unbalanced input is rejected at API **and** by the database.
2. Posted journals/lines cannot be modified or deleted (verified with raw SQL); corrections only by reversal entry.
3. Postings in a locked/missing period are rejected.
4. Tax: ON 13% HST, QC GST+QST, BC GST+PST (PST not recoverable on purchases), zero-rated, exempt; inclusive and exclusive;
   rate chosen by transaction date (NS 15% → 14% on 2025-04-01); journals post tax to the right liability / ITC accounts.
5. Invoice → AR; bill → AP; payment allocations update outstanding and status; over-allocation rejected.
6. Trial balance totals equal and equal the sum of posted journals; ledger running balances reconcile.
7. Cross-company isolation and role permissions hold for every new route.

---

# Milestone 2 — Result

## Verified
`pnpm lint`, `pnpm typecheck`, `pnpm test` all pass: tax 11, engine 9, shared 10, API 57 (real PostgreSQL), plus a browser pass
(upgrade of a Milestone 1 database → accounting setup → QC invoice posted → dashboard, trial balance and sales screens).
Criteria 1–7 above are each covered by an automated test (immutability and DB-level balance checks use raw SQL that bypasses the API).

## What was built
Chart of accounts (42-account Canadian template, sub-accounts, system roles), monthly periods + lock/unlock + new fiscal years,
manual journals (draft/post/reverse), gap-free numbering, contacts, tax codes with effective-dated per-component rates and
rate-overlap protection, invoices/credit notes, bills/vendor credits, void-by-reversal, payments with allocations (partial,
concurrent-safe), expenses with submit → approve → post and separation of duties, trial balance, general ledger with running balance,
ledger-derived dashboard KPIs, and screens for Accounting, Taxes, Contacts, Sales, Purchases, Expenses.

## Not done (explicit)
- **Multi-currency / FX differences, year-end closing, cash-basis reporting, receipt attachments, applying credit notes to invoices,
  prepayments / unallocated payments, opening-balance wizard** — deferred. Documents carry a `currency` column but only CAD is supported.
- Draft invoices/bills cannot be edited (delete and recreate). The web invoice/bill form supports one line; the API supports many.
- Journal report is the journals list; exports (PDF/CSV/XLSX) come in Milestone 5. No UI for editing tax rates or locking periods yet (API exists).
- **Tax data caveat:** only GST 5%, ON 13%, NS 15%→14% (2025-04-01) and MB PST 7% were checked against a CRA page. NB/NL/PE 15%, QST 9.975%,
  BC 7% and SK 6% and their start dates are seeded from general knowledge, are labelled UNVERIFIED in the database and UI, and
  must be confirmed by you. Place-of-supply rules are *not* automated: the user picks the tax code (a province→code suggestion helper exists but is not applied).
  Quebec QST is calculated on the pre-tax base alongside GST; confirm against Revenu Québec for your situation.
- Tax registration status is not yet used to block or flag charging tax; filing-period reports arrive in Milestone 5.
- Row-level security still not added. Docker images still unbuilt (Dockerfile updated for the new packages, untested).
- Rounding is half-up per component per line; some filers must round per invoice — a policy setting is not implemented.

## Manual test script
1. Run the app (docs/macos-setup.md). On an existing M1 database run `pnpm db:deploy`, then open a company and `POST /companies/:id/accounting/setup` (new companies get it automatically).
2. Contacts → add a customer and a supplier. Taxes → review the rates (note the "unverified" badges).
3. Sales → create a draft invoice with HST_ON, post it, then *Receive payment* in two parts; watch status go posted → partial → paid.
4. Accounting → Trial balance shows A/R, revenue and GST/HST payable and says "balanced". Journal tab: post a manual entry, then reverse it.
5. Purchases → bill with `GST_PST_BC` (province BC): the trial balance shows an ITC of 5% and PST folded into the expense.
6. Sign in as a Bookkeeper: can create drafts but gets 403 on Post. Expenses → submit as Employee, approve as Accountant, post.
