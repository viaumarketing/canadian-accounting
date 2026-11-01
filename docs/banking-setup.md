# Banking setup

## 1. Add accounts and import statements (no setup needed)
Banking → Accounts → *Add a bank or credit-card account*. Each one is backed by an account in your chart (a bank account is an **asset**; a credit card is a **liability**).
Then *Import statement*: choose a CSV, OFX or QFX file, confirm the column mapping (CSV), review the preview, import.
- **Download CSV/OFX from your bank**, not PDF. PDFs are refused on purpose: text extraction from arbitrary bank PDFs isn't reliable, and a wrong number in the books is worse than no import.
- The original file is stored unchanged (Banking → statements; SHA-256 recorded). The same file can't be imported twice; overlapping statements only add the new rows.
- Credit-card CSVs that show purchases as *positive* numbers: tick "Purchases are positive".
- French-Canadian exports (`12,50`): tick "decimal comma". Windows-1252 accents are handled automatically.

## 2. Daily workflow
1. **Transactions → To review.** Each row offers what it could be:
   - a suggested **match** to an entry already in your books (confidence shown; ≥ 90 % can be approved in bulk, but only by you clicking it),
   - a **category** (single or split, with GST/HST/QST/PST) — creates the entry,
   - **Receive payment / Pay bill** — applies the transaction to open invoices/bills (partial payments supported),
   - **Transfer** — between your own accounts; no income or expense is created,
   - **Ignore**.
2. **Rules** only pre-select an account; nothing posts without your click.
3. **Reconcile** monthly: enter the statement's end date and ending balance (for credit cards, the *amount owed* as printed). It completes only when opening + cleared items equals the statement to the cent, then locks those transactions. Only the most recent reconciliation can be reopened.

## 3. Bank connections (optional)
Supported provider: **Plaid** (adapter checked against Plaid's published API spec; **never run against live Plaid here**). Flinks: interface only, not implemented.
1. Create a Plaid account and keys. Which Canadian institutions are available and what it costs depends on your Plaid agreement. Check it before relying on it.
2. Put `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` (`sandbox`/`production`) in `.env`; restart API and worker.
3. Many Canadian banks sign in through an **OAuth redirect**; for those, register a redirect URI in the Plaid dashboard and set `PLAID_REDIRECT_URI`.
4. Banking → Connections → *Connect a bank*, choose which accounts to import and the ledger account codes to create. Sync runs hourly in the worker and on demand.
- You sign in inside Plaid's window. This system never sees your online-banking password; it keeps only an **encrypted access token**.
- Only *posted* transactions are imported (pending ones are ignored until they settle). Changes/removals from the bank are applied to unmatched transactions; for ones you've already matched, you get a warning and nothing is changed behind your back.
- The Plaid browser script is loaded from `cdn.plaid.com`; that is the one external script the app loads, and only on the Connections tab.
- Webhooks from Plaid are not used (polling only).
