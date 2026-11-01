# Milestone 1 — Foundation

## Plan (as required before implementation)

**Deliverables.** Monorepo, dev Docker environment, Prisma schema + migration, authentication (password, sessions, TOTP MFA),
company provisioning and management, role/permission system, audit log, modern dashboard shell, CI, production Docker packaging (drafted).

**Database changes.** `User, Session, RecoveryCode, Company, CompanyMembership, FiscalYear, TaxRegistration, AuditEvent` + append-only trigger + CHECK constraints.

**APIs.** `POST /setup`, `GET /setup/status`; `POST /auth/login|logout|change-password|mfa/enroll|mfa/activate|mfa/disable`, `GET /auth/me`;
`POST|GET /admin/companies`, `GET /admin/system`; `GET|PATCH /companies/:id`, `GET /companies/:id/dashboard|members|tax-registrations|audit`,
`POST /companies/:id/members|tax-registrations`, `PATCH|DELETE /companies/:id/members/:membershipId`; `GET /health`, `/health/ready`.

**Security.** See `docs/architecture.md`.

**Acceptance criteria** (all verified by automated tests unless marked ⚠):
1. First admin can be created exactly once, even under concurrent requests.
2. A member of company A gets 404 on every company B route; super admin gets 404 on companies they aren't a member of.
3. Role permissions enforced (employee/auditor/bookkeeper/admin cases); last owner protected; admins cannot grant/alter owners.
4. MFA enrolment, login challenge, recovery codes single-use; TOTP secret encrypted at rest.
5. Lockout, rate limiting, CSRF rejection, uniform login errors, forced password change.
6. Audit events written; UPDATE/DELETE on them rejected by the database.
7. Migration applies cleanly to an empty PostgreSQL. ⚠ Rollback / down-migration not implemented (Prisma has none; restore from backup is the rollback path, documented in the README).
8. UI: login, setup, company selector, dark/light, collapsible sidebar, dashboard, settings, admin work in a real browser (manually verified, not Playwright-automated). ⚠

## Verified

`pnpm lint`, `pnpm typecheck`, `pnpm test` (shared: 10, API: 29 incl. real-PostgreSQL integration), `next build`, and a manual browser pass
(first-run setup → login → provision company → dashboard → settings) against a real database.

## Not done / not verified (be aware)

- **Docker images and `compose.production.yaml` have never been built or run.** Docker is not installed on the machine where this was developed. Treat them as a reviewed draft until you run `docker compose build`/`up`; expect small fixes.
- Playwright E2E tests, backup-restore test, migration-rollback test: not written yet (Milestone 6 per plan; backup scripts exist but are untested).
- `packages/accounting-engine`, `canadian-tax`, `shopify-integration`, `banking`, `ui` and Redis-backed jobs: intentionally absent. The worker only proves Redis/Postgres connectivity.
- Dashboard KPIs and charts show an explicit "no data" state: there is no ledger yet, and nothing is mocked.
- No PostgreSQL row-level security yet; TOTP replay protection within the 30 s window not implemented; no email (invites use temporary passwords handed over out of band); no password reset flow; no "sign out other sessions" UI; accessibility not audited with tooling.
- Dependency choices: I pinned Nest 11, Prisma 6, Next 15, Tailwind 3, TypeScript 5.9, Zod 3, vitest 3 for stability. Newer majors exist (e.g. Prisma 7, Next 16, Nest 12) and are an upgrade task, not a blocker.

## Manual test script

1. Follow `docs/macos-setup.md`. Open http://localhost:3000 → create administrator.
2. Account menu → System administration → provision a company (owner = your own email, or a new owner with a temporary password).
3. Company dashboard shows the fiscal year and "—" KPIs. Toggle dark mode; collapse the sidebar; resize to phone width (menu button appears).
4. Settings → Members: add a *Bookkeeper* with a temporary password. Sign out; sign in as them: forced password change, then they see no Members/Audit tabs.
5. Settings → Security: enable MFA with an authenticator app; sign out and in; try a recovery code.
6. Settings → Tax registration: add `123456789RT0001` (GST/HST); a malformed number is rejected.
7. Settings → Audit log shows every action above.
