# Card payments (Stripe), Undeposited Funds and bank deposits

## Pay now on invoices

Each company connects **its own Stripe account** (Settings → Online payments). Card payments go to that account; Stripe's
fees apply; the app never sees card numbers.

1. Stripe dashboard → Developers → API keys: copy the **secret key** (`sk_test_…` to try, `sk_live_…` for real).
2. Paste it in Settings → Online payments. The app checks it with Stripe (`GET /v1/account`) and stores it encrypted
   with `ENCRYPTION_KEY`. It also creates the **Stripe Clearing** asset account (1045) and **Undeposited Funds** (1050).
3. Stripe → Developers → Webhooks → *Add endpoint*: the URL shown in Settings
   (`https://<your site>/api/webhooks/stripe/<id>`) and the events `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `checkout.session.expired`. Paste the endpoint's **signing secret**
   (`whsec_…`) in Settings. Pay now appears only once the secret is saved.

**The webhook URL must be reachable from the internet over HTTPS.** A NAS that is only on your LAN cannot receive Stripe
webhooks; expose only `/api/webhooks/*` and `/api/public/*` through a tunnel or reverse proxy, or leave card payments off.

What happens:

- The customer opens the invoice link from the e-mail (`/i/<token>`), clicks **Pay by card**, and pays on Stripe's
  Checkout page (`POST /v1/checkout/sessions`, mode `payment`, the invoice balance in cents).
- Stripe calls the webhook. The app checks the `Stripe-Signature` header (HMAC-SHA256 of `timestamp.body` with the
  signing secret, timestamps within 5 minutes), ignores events it has already processed, and records a customer payment
  **Dr Stripe Clearing / Cr Accounts Receivable** dated the day Stripe completed it. The invoice shows as paid.
- If the payment no longer fits (the invoice was paid another way meanwhile, or voided, or another currency), nothing is
  recorded automatically: the session is marked *needs review* and an audit event is written. Refund or apply it by hand.
- Card payments cannot be voided in the app (they happened at Stripe): refund in Stripe and record a credit note.

When Stripe pays out to your bank, record a **bank deposit** (Banking → Bank deposits): select the card payments, add
Stripe's fee as a negative line to *Payment Processing Fees*. The deposit then matches the single payout line on the bank
statement. (Payouts are not imported from Stripe automatically in 1.0.1.)

## Undeposited Funds and bank deposits

Record cheques and cash to **Undeposited Funds** (Receive payment → Deposit to, or a sales receipt's *Deposit to*). When
you take them to the bank, Banking → Bank deposits: tick what went in together, add any other lines (fees as negative
amounts), and save. One journal entry: Dr bank (total), Cr Undeposited Funds / Stripe Clearing for each item, Dr/Cr the
other lines. A deposited payment or receipt cannot be voided until the deposit is voided.

## Not verified live

Built from Stripe's API reference (Checkout Sessions, Events, webhook signatures) and tested against a fake that checks
the exact form fields and signs webhooks the way Stripe does. Run one payment in Stripe **test mode** before going live.
