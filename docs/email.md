# E-mail (Resend)

The app sends invoices, sales receipts, estimates, purchase orders, statements, overdue reminders and (SaaS edition) sign-up
confirmations through [Resend](https://resend.com). Without it, nothing is sent and the app says so: the Send dialog shows
a warning and the API answers `503 MAIL_NOT_CONFIGURED`. Nothing is ever reported as sent when it was not.

## Set it up

1. Create a Resend account and **verify a sending domain** (Resend → Domains). Resend gives you DNS records (SPF/DKIM)
   to add at your DNS provider; wait until the domain shows *Verified*. A sub-domain such as `mail.example.com` keeps
   these records apart from your normal e-mail.
2. Create an **API key** with *Sending access* (Resend → API keys).
3. In `.env` (or `.env.production` on the NAS):

   ```
   RESEND_API_KEY=re_…
   MAIL_FROM=billing@mail.example.com
   ```

   `MAIL_FROM` must be an address on the verified domain. Restart the api and worker containers.

4. In each company, **Settings → Branding & e-mail**: the sender name (default: the company name) and the reply-to address
   (default: the company e-mail), so customer replies go to the business, not to the sending domain.

## What is sent, and how

| Message | From | Attached |
|---|---|---|
| Invoice, sales receipt, estimate, purchase order | Settings → Branding & e-mail, or the defaults | the document PDF |
| Customer statement | same | statement PDF |
| Overdue reminder (automatic or "Send reminder") | same | invoice PDF |
| Recurring invoice in *post and e-mail* mode | same | invoice PDF |
| SaaS e-mail confirmation | `APP_NAME` | none |

- The request is `POST https://api.resend.com/emails` with a Bearer key: `from`, `to`, `cc`, `reply_to`, `subject`, `html`,
  `text`, `attachments` (base64) and a `kind` tag. Reminders carry an `Idempotency-Key`, so a retry never sends twice.
- Every attempt is logged (Sales → the document → e-mail log, or `GET /companies/:id/emails`) with Resend's message id, or
  Resend's error message when it refuses.
- Wording is per company and per kind (Settings → Branding & e-mail), with placeholders `{{customer}} {{company}}
  {{number}} {{total}} {{balance}} {{dueDate}} {{link}}`. `{{link}}` is the customer's invoice page (view, download,
  Pay now); it is created the first time an invoice is sent.

## Not verified live

The integration is built from Resend's API reference and tested against a fake that checks every field. It has not been
run against a live Resend account; send yourself an invoice once after setting it up.
