# Security

What is enforced, how it is tested, and what is **not** covered.

## Controls and where they are tested
| Control | Enforced by | Tested by |
|---|---|---|
| Every route needs a session unless on a reviewed public list | `AuthGuard` | `security.test.ts` (route table → 401; public list pinned) |
| Tenant isolation: non-members (including platform super admins) get 404 on every `/companies/:companyId/*` route | `CompanyGuard` | `security.test.ts` (every company route, plus cross-company A→B) |
| Role permissions | static role→permission matrix, `@RequirePermission` | `security.test.ts` (7 roles × every company route) and a pinned route→permission snapshot (`test/route-permissions.snap.txt`, review any diff) |
| Permission checks inside handlers (payments, posting journals) | handler code | `security.test.ts` (valid bodies) |
| CSRF: state-changing calls need the web origin or `X-Requested-With` | `CsrfGuard` + SameSite=Lax | `security.test.ts` (every mutating route, no/foreign Origin) |
| Passwords (argon2id), lockout, TOTP MFA + recovery codes, secrets encrypted with AES-256-GCM | auth module | `api.test.ts` |
| TOTP replay: an authenticator code is accepted once (last accepted time step stored; atomic, so simultaneous use of one code succeeds at most once) | `AuthService.consumeStep` | `api.test.ts` |
| Immutable ledger, audit log append-only | database triggers | `accounting.test.ts`, `api.test.ts` |
| Secrets after a restore: wrong `ENCRYPTION_KEY` detected | readiness check + System health card | `admin.test.ts` |
| Headers: CSP, HSTS, frame-ancestors none, nosniff, Permissions-Policy | Caddy (+ helmet on the API) | checked on the running stack; UI hydrates under the CSP |
| Postgres/Redis unreachable from outside; only Caddy publishes ports | compose: `internal` network (no route anywhere) for Postgres/Redis; `egress` (outbound only, no ports) for api/worker to reach Shopify and the bank provider | CI compose check; verified on the running stack |
| First administrator cannot be claimed by someone else on the LAN | `SETUP_TOKEN` is mandatory in production | `api.test.ts` |
| Documents folder: files owned by the app user (uid 1000), mode 600, checksum verified on every read | `DocumentStore`, one-shot `prepare` service | `banking.test.ts` (on-disk storage, tampering detected) |
| Containers: non-root, read-only root filesystem, no capabilities, `no-new-privileges` | compose | stack run with all of it on (exports included) |

## Dependency advisories (`pnpm audit --prod --audit-level=moderate` must pass in CI)
Fixed with `pnpm.overrides`: postcss (build tool), multer (not used), uuid (exceljs). zod was upgraded to 4 in v0.9.1, which cleared GHSA-mrhx-c7xc-m3w5. Triaged and ignored in `package.json` → `pnpm.auditConfig.ignoreGhsas`:
- **GHSA-ggr8-5vv4-36mx — deepmerge-ts** inside the Prisma CLI config loader: runs at build/migrate time on our own files, never on request data.
- **GHSA-g3hv-75wg-m249 — minimatch** inside exceljs/archiver globbing: we never pass user-supplied patterns.

## Known gaps (not done)
- No third-party penetration test; the tests above are ours.
- No PostgreSQL row-level security: isolation is enforced in the application (guard + `companyId` in queries).
- CSP allows `'unsafe-inline'` scripts (Next.js bootstrap). Nonces would need a custom server.
- Images are not scanned for OS-package CVEs in CI; rebuild/pull regularly for base-image fixes.
- Rate limits are per client IP as seen by Caddy. Behind another proxy or a Mac Docker VM that address may be a gateway.
