# Milestone 4 — Banking (plan)

## Verified vs. not
- **Plaid** (the one provider implemented): endpoints, request/response fields, country code `CA`, the `transactions` product, `/transactions/sync` paging (count 1–500, `has_more`, `next_cursor`, added/modified/removed) and the **sign convention** (positive = money OUT) were checked against Plaid's published OpenAPI spec (`plaid-openapi`, 2020-09-14). Authentication is by `PLAID-CLIENT-ID` / `PLAID-SECRET` headers. `scripts/validate-plaid.mjs` re-checks every path/field we use against the spec. **No Plaid account was available, so nothing has run against Plaid.** Which Canadian institutions are supported, and pricing, depend on your Plaid agreement; I make no claims about them.
- **Flinks**: the adapter interface is provider-neutral and a Flinks adapter can implement it, but **none is built** (needs a Flinks contract and credentials; I did not consult or guess its API).
- We never scrape or store online-banking passwords: the user authenticates inside the provider's own Link UI; we only keep an encrypted access token.
- **PDF statements**: *not parsed.* Reliable text extraction from arbitrary bank PDFs isn't possible without per-bank templates. You can import CSV/OFX/QFX; the original file of every import is preserved byte-for-byte.

## Scope
Bank/credit-card accounts (each tied to a ledger account) · CSV import with column mapping, preview and duplicate detection · OFX/QFX import · original-file preservation · Plaid connection and transaction sync ·
categorisation rules (suggestions only) · match suggestions with confidence scores and manual approval · create entries from transactions (single/split, with tax) ·
receipts/payments against invoices and bills incl. partial payments · transfers between accounts · Shopify payout matching · statement-balance reconciliation with locking, reports and history.

**Deferred:** PDF parsing; Flinks; Plaid webhooks (polling only; their JWT verification is not implemented); pending transactions (only posted ones are imported); multi-currency accounts (CAD only); bank-fee/interest auto-suggestions beyond rules; CSV export of reports (M5).

## Design rules
1. A bank transaction is **never turned into a journal without a human decision.** Rules and matchers only *suggest*; each suggestion carries a confidence score; approval is an explicit action. A bulk "approve all ≥ 90 %" is a user-triggered action, not automatic.
2. **Matching** pairs a bank transaction with an existing, unreconciled **journal line on the account's ledger account** with the same signed amount (e.g. the receipt recorded for an invoice, a Shopify payout, a manual entry). Same amount is mandatory; date proximity, text similarity and source (Shopify payout, payment reference) raise confidence.
3. **Creating** from a transaction posts through the single ledger path (periods, balance, immutability all apply): categorise to one or many accounts (tax-inclusive amounts split via the tax engine), or settle invoices/bills (reusing the payment code, so partial payments, over-allocation and locking behave identically), or record a transfer between two bank accounts (one entry, both sides matched).
4. **Duplicates:** (a) the same file (SHA-256) can't be imported twice per account; (b) transactions carry a fingerprint (FITID when present, else date+amount+normalised description+occurrence number); overlapping statements skip rows already imported.
5. **Reconciliation**: pick a statement end date and balance; cleared = matched transactions up to that date; `opening + Σ cleared = ending` must hold to the cent to complete. Completing locks those transactions (no unmatch/ignore) and the account's ledger lines through that date can't be re-matched elsewhere. Only the latest reconciliation can be reopened, by someone with `banking:reverse`.

## Database
BankAccount, ImportBatch, BankStatement (original bytes), BankTransaction, BankRule, BankProviderConnection, Reconciliation, ReconciliationMatch. All carry `companyId`; DB constraints: unique `(bankAccountId, fingerprint)`, unique `(bankAccountId, fileSha256)`, one approved match per bank transaction and per journal line.

## Security
Uploads: size cap 10 MB, extension + content sniffing, row cap 50 000, parsers never evaluate or expand entities (OFX handled with a plain tag scanner); Plaid secrets from env, access tokens AES-GCM encrypted, never returned; every foreign id in a request is verified to belong to the company; tenant guard + permissions on every route; audit events for imports, approvals, categorisations, reconciliations, locks.

## Acceptance criteria
1. Importing the same CSV/OFX twice, or overlapping statements, creates no duplicate transactions; two genuine identical purchases on one day both import.
2. CSV mapping handles signed-amount, debit/credit columns, parentheses negatives, `1,234.56`, quoted fields, several date formats; the preview shows what will be imported and what is skipped, and nothing is saved until commit.
3. OFX 1.x (SGML) and 2.x (XML) bank and credit-card statements parse, including QFX.
4. Suggested matches never post anything; approval links bank txn ↔ journal line exactly once; a journal line can't be matched twice.
5. Categorise/split/transfer/invoice-payment actions create balanced journals through the ledger path and mark the bank transaction matched; partial payments work; locked periods are refused.
6. Rules only suggest; precedence by priority.
7. Reconciliation completes only when the difference is exactly 0.00, then locks; reopen is restricted; reports show cleared and outstanding items.
8. Shopify payout journals are suggested as matches for the corresponding deposit.
9. Plaid sync (against a fake HTTP server) imports added/modified/removed incrementally with a stored cursor and handles errors; tokens encrypted.
10. Tenant isolation and role permissions on every new route.

---

# Milestone 4 — Result

## Verified
`pnpm build`, `typecheck`, `lint`, `test` pass: banking package 25, tax 11, engine 9, shopify 27, shared 10, API 113 (real PostgreSQL). `validate:plaid` checks 50 endpoint/field facts against Plaid's published spec.
A browser pass on the dev database: worklist with a rule suggestion and a Shopify-payout match suggestion; categorising through the UI posted a balanced entry and matched the transaction.

## What was built
`@ca/banking` (CSV with mapping, OFX/QFX, fingerprints, match scoring, document and transfer suggestions, rules, reconciliation math, provider interface + Plaid adapter) · schema + migration (8 tables; DB triggers/constraints: reconciled rows are immutable, match-state CHECK, one approved match per line/transaction) ·
accounts, import preview/commit with original-file preservation · transaction worklist · suggestion/approval workflow (single, bulk ≥ 90 %, manual, unmatch) · categorise/split with tax · settle invoices/bills (partial payments) in the same DB transaction · transfers · undo-by-reversal · rules (suggest only) ·
reconciliation (preview, complete+lock, reopen latest, history, report, credit-card sign handling) · Plaid connection (link token, exchange, account mapping, cursor sync, worker schedule) · screens.

## Not done / not verified
- **Plaid has never been called for real.** Behaviour is tested only against an in-process fake of the documented HTTP shapes; the Link UI (`cdn.plaid.com`) and OAuth-institution redirects are untested. Which Canadian banks work is unknown here. **Flinks is not implemented.**
- **PDF statements are not parsed** (by design, see above). CSV mapping covers common layouts, but bank formats vary: expect to adjust the mapping the first time per bank. Mappings are not yet saved per account.
- BullMQ/Redis scheduling for the hourly bank sync is untested (as in M3). Docker images/compose remain unbuilt.
- Pending transactions, multi-currency accounts, foreign-currency transfers, and Plaid webhooks are not supported. Statement balances for `Reconciliation` are single-currency (CAD).
- Reconciliation completes on the statement tie-out; the books-vs-bank check (`bookVsBank.unexplained`) is shown as a **warning**, not a blocker. An opening-balance entry missing from the books shows up there.
- A bank transaction can match **one** ledger line. Many-to-one cases (one deposit settling several separately-recorded receipts) must be handled by recording a single payment/entry, not by matching.
- Match scoring weights are heuristics, unproven on real data; confidence is capped at 99 % on purpose. The text similarity is token overlap, not fuzzy matching.
- The web UI has no keyboard-shortcut or bulk-select worklist features, and no per-statement view of what an import changed beyond the summary.
- Fee/interest auto-suggestions, recurring-transaction detection, and exports of the reconciliation report (PDF/CSV) arrive with Milestone 5.

## Manual test script
1. Banking → Accounts: add a chequing account linked to *1010* (or a new one); import a real CSV/OFX from your bank; adjust the mapping until the preview looks right. Import it again: refused. Import a longer statement that overlaps: only new rows.
2. Create a Shopify payout or an invoice payment in the books, then Transactions → the matching deposit shows a suggestion; approve it. Nothing new appears in the journal.
3. Categorise a withdrawal with a tax code (see the ITC in Accounting → Trial balance); split another across two accounts; record a transfer between two accounts.
4. Sign in as a *Bookkeeper*: can import and add rules, cannot approve/post/reconcile.
5. Reconcile: enter the statement's ending balance; an off-by-a-cent figure refuses to complete; the correct one completes and locks; try to unmatch a locked row; reopen the latest reconciliation.
6. (Optional) Plaid sandbox keys → Connections → connect; sync; reconnect flow when credentials change.
