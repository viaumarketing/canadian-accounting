# Milestone 6 — Security, performance, packaging, backup and recovery

Status: **implemented and verified on Docker Desktop (Mac); awaiting approval.** Plan first, results after.

## Plan

### What exists going in
- Dockerfile (api / worker / web targets), `compose.production.yaml`, Caddyfile, backup scripts, CI and release workflows, `scripts/install.sh` — all written in M1–M5 but **never built or run**.
- Docker Desktop is available on the dev Mac, so M6 can build the images and run the stack for real. It is *not* a UGREEN NAS: UGOS-specific steps stay documented-not-verified.

### Workstreams
1. **Packaging (verify what was only written):** build the three images; run the production compose file locally with real Postgres, Redis, Caddy; confirm migrations apply, health checks go green, the API/web are reachable only through Caddy, and Postgres/Redis publish no ports.
2. **Redis / BullMQ (unproven until now):** with real Redis, prove queues, the 15-minute schedule and the hourly bank sync enqueue and run; fix what breaks.
3. **Security testing:** tenant-isolation sweep over *every* company-scoped route (generated from the Nest route table, so new routes are covered automatically), authorization matrix per role, session/CSRF/lockout/MFA-replay checks, security-header checks on the real stack, dependency audit, secret scanning, container hardening review.
4. **Backup / restore / disaster recovery:** run the real `pg_dump` backup against the compose Postgres, decrypt, restore into a scratch DB, and compare row counts and the ledger trial balance; test wrong-passphrase and truncated-file failure; fresh-host rebuild drill from backup + `.env`.
5. **Performance:** seed a realistic volume (tens of thousands of journal lines), time the report endpoints and list endpoints, read `EXPLAIN` plans, add indexes only where measured.
6. **CI/CD:** CI runs lint, typecheck, tests, image builds (no push) and an audit; release workflow pushes to GHCR on tag. Validate the YAML locally; workflows cannot be *run* from here.
7. **UGREEN NAS docs:** install, upgrade, rollback, backup restore, DR runbook, security notes. Steps specific to UGOS Pro are marked as not tested on hardware.

### Acceptance criteria
- `docker build` succeeds for api, worker, web; images run as non-root.
- `docker compose up` brings the whole stack healthy from an empty data directory; first-run setup works through the Caddy URL.
- Only Caddy publishes host ports (checked with `docker compose ps` / `docker port`).
- Queue jobs actually run against real Redis.
- Every company-scoped route is shown (by an automated test) to return 404/401/403 for an outsider; role matrix test passes.
- A backup taken from a running stack restores into a scratch database and its trial balance equals the source's; a corrupted backup or a wrong passphrase fails loudly.
- Report endpoints stay within a stated time budget at the seeded volume; slow queries have measured fixes.
- Lint, typecheck, unit and integration tests pass.
- Every claim that could not be verified (UGOS hardware, GHCR push, Plaid/Shopify live) is listed under "Not done / not verified".

### Out of scope (stated up front)
- Running on actual UGREEN hardware, pushing to GHCR from GitHub, live Shopify/Plaid calls, a third-party penetration test.

## Results

### Bugs found by actually running the production stack (all fixed)
1. **The stack could never start:** the `migrate` container ran `pnpm`, which tried to download itself at start-up on a network with no internet. It now calls the Prisma binary directly, and the image pre-installs pnpm.
2. **`/api` through Caddy returned 500:** Next.js fixes its rewrite target at build time, so the runtime `API_INTERNAL_URL` was ignored. Caddy now routes `/api/*` straight to the API, which also gives the API the real client IP (rate limits, lockout, audit log).
3. **Backups had never worked:** `openssl` is missing from `postgres:17-alpine`, the runtime `apk add` could not reach the internet, and `|| true` hid it. Without `pipefail`, a failed `pg_dump` could also have produced a "valid-looking" empty backup. There is now a dedicated `backup` image, with pipefail, verify-before-keep, `.sha256`, mode 600, keep-the-newest-7 retention and a health check.
4. A restore with a wrong `ENCRYPTION_KEY` only showed up as a 500 at MFA sign-in. Readiness now fails with `ENCRYPTION_KEY_MISMATCH`, and System health shows an Encryption key card.
5. There was no CSP or Permissions-Policy (added in Caddy). The release workflow did not build the backup image, did not lowercase the GHCR path and pushed without running tests (fixed).

### Verified
- **Images:** api, worker, web and backup build; app images run as uid 1000. The stack runs with read-only root filesystems, `cap_drop: ALL` and `no-new-privileges`, and PDF/XLSX/CSV exports still work.
- **Compose:** comes up healthy from an empty data directory with an `.env` made by `scripts/install.sh`. Only Caddy publishes ports; ports 4000/3000/5432/6379 are unreachable from the host.
- **Real Redis/BullMQ:** repeatable schedules registered, jobs completed, queue counters shown in System health.
- **Security tests** (`apps/api/test/security.test.ts`, generated from Nest's route table, 126 routes):
  - 401 without a session on every non-public route;
  - CSRF rejection on every mutating route;
  - 404 for outsiders, including super admins, on every company route;
  - 7 roles × every company route against the permission matrix;
  - a pinned route→permission snapshot.
  A deliberate mutation (weakening `journal:post`) slipped past the matrix test, which led to the snapshot. Inline checks in the payment and journal handlers are tested with valid bodies.
- **Performance** (`pnpm --filter @ca/api perf`), measured on this Mac at 100,000 posted entries (300,000 lines):
  - every report finished in under 0.8 s, except the general ledger for the busiest account (1.6 s, 3.3 MB of JSON);
  - posting a journal took 24 ms.
  No index changes were needed.
- **Backup and disaster recovery** with 30,005 entries:
  - restore into a scratch database gave identical row counts in all 43 tables, identical per-account totals and user rows, and the triggers present;
  - an API booted on the restored database signed in with MFA and returned a trial balance whose checks pass, while the wrong key was refused;
  - a wrong passphrase, a truncated file and a flipped byte all fail before touching any database;
  - restoring over the live database is refused unless explicitly confirmed.
- **Upgrade and rollback scripts:** a failed pull leaves everything unchanged. Upgrade → data change → rollback brought back the previous version and the pre-upgrade data, healthy.
- **Dependencies:** `pnpm audit --prod --audit-level=moderate` passes. Three advisories were fixed by overrides and three triaged with reasons (`docs/security.md`).
- **CI:** workflows are valid YAML. The compose check (only Caddy publishes) and shell syntax checks were simulated locally.

### Not done / not verified
- **Not run on UGREEN hardware.** UGOS steps in `docs/ugreen-nas.md` come from UGREEN support pages and third-party guides.
- **GitHub Actions not run** (no remote); nothing pushed to GHCR. Only amd64 images are built by default.
- **Not tested over HTTPS in a browser:** the browser refused Caddy's internal CA, so the UI and CSP were checked over HTTP `localhost` with the same Caddyfile. HTTPS itself was checked with curl.
- **No external pentest, no row-level security, no TOTP replay protection**; the CSP still allows inline scripts. See `docs/security.md`.
- **zod 3 advisory** is accepted until a zod 4 migration.
- **api/worker images are large (about 1.85 GB)** because they carry the full workspace. A production-only `pnpm deploy` image is future work.
- **General-ledger and journal reports are not paginated:** a large account produces a multi-megabyte page.
- **Backups are not copied off the NAS automatically.** Copy them yourself (`docs/backup-and-recovery.md`).
- **Not tested:** Postgres major-version upgrade, very large restores, Playwright end-to-end tests.

## Manual test steps
1. Fill in `.env` (`sh scripts/install.sh`), then run `docker compose -f compose.production.yaml up -d`. All services show healthy in `docker compose ps`, and only caddy lists ports.
2. Open the site, create the administrator with `SETUP_TOKEN`, enable MFA, then check **System health**: backups ok, encryption key ok, queue ok.
3. `docker compose -f compose.production.yaml exec backup /scripts/restore.sh /backups/<newest>` prints counts and `ledger balanced … 0`.
4. `scripts/upgrade.sh <next version>`, then `scripts/rollback.sh` (type REPLACE).
5. `pnpm --filter @ca/api perf` to time reports on your own machine.
