# Architecture

## Shape

```
Browser ──HTTPS──> Caddy ──> web (Next.js)  ──/api/* rewrite──> api (NestJS) ──> PostgreSQL
                                                                   │
                                                  worker (BullMQ) ─┴──> Redis
```

- **Same-origin API.** The browser only talks to the web origin. Next.js proxies `/api/*` to the
  API over the internal network, so the session cookie is first-party and the API needs no CORS.
- **PostgreSQL and Redis are never published** in production; they sit on an `internal: true` Docker network.
- **Monorepo (pnpm workspaces).** `packages/shared` (Zod schemas, roles/permission matrix) and
  `packages/database` (Prisma schema, migrations, client) are used by the apps. Packages for the
  accounting engine, Canadian tax, Shopify and banking are added in the milestones that need them,
  rather than created empty.

## Tenancy and authorization

1. Every company-owned table has `companyId NOT NULL` with an FK and index.
2. Any route under `/companies/:companyId/...` passes `CompanyGuard`, which requires an **ACTIVE
   membership** of the caller in that company and (via `@RequirePermission`) a role holding the permission.
   Non-members get **404**, not 403, so company ids can't be probed.
3. **Super administrators are not a company role.** `User.isSuperAdmin` unlocks only `/admin/*`
   (provisioning, system health). It confers no company permissions; seeing a company's books requires
   an explicit membership. Provisioning requires naming the owner, so the platform admin is not
   silently added to every company.
4. Roles map to permissions (`resource:action`, e.g. `journal:post`) in a static matrix in
   `packages/shared/src/permissions.ts`. DB-stored custom roles are a later enhancement.
5. Defence in depth still to add: PostgreSQL row-level security (planned for Milestone 2 when ledger tables arrive).

## Authentication

- Argon2id password hashes. Min 12-character passwords.
- Opaque 256-bit session tokens in an `HttpOnly; SameSite=Lax` cookie (`Secure` when `WEB_ORIGIN` is https). Only the SHA-256 is stored.
  Sessions have an absolute (7 d) and idle (12 h) expiry and can be revoked; changing a password revokes other sessions.
- TOTP MFA (RFC 6238) with 8 single-use recovery codes. Secrets are AES-256-GCM encrypted with `ENCRYPTION_KEY`.
- Lockout after 5 failures (15 min), per-route rate limits, uniform errors for unknown user vs. bad password (including equalised timing).
- CSRF: SameSite plus an Origin/`X-Requested-With` check on every state-changing request.
- First administrator: `POST /setup`, serialized by an advisory lock, permanently refused once any user exists; optional `SETUP_TOKEN`.
- Invited users get a temporary password and are blocked from everything except changing it.

## Audit

`AuditEvent` is append-only, enforced by database triggers that reject UPDATE, DELETE and TRUNCATE.
Auth events, provisioning, membership and tax-registration changes are recorded; no secrets or passwords are stored.

## Database (Milestone 1)

User, Session, RecoveryCode, Company, CompanyMembership, FiscalYear, TaxRegistration, AuditEvent.
Check constraints guard fiscal-year-end values and date ranges. Later milestones add the ledger, tax codes/rates, invoicing, Shopify and banking tables.

## Money

Not yet applicable (no amounts exist in Milestone 1). From Milestone 2: PostgreSQL `NUMERIC` / integer minor units and a decimal library; no floating point.
