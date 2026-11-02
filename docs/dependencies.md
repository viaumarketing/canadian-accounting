# Dependencies

## Policy
- Patch and minor updates go into the next release after the full test suite, image build and audit pass.
- Each **major** upgrade gets its own release, so a regression can be traced to one change and rolled back with `scripts/rollback.sh`.
- `@types/node` follows the Node runtime in the images (22), not the newest types.
- `pnpm audit --prod --audit-level=moderate` must pass in CI; any exception is listed in `package.json` → `pnpm.auditConfig.ignoreGhsas`, with its reason in `docs/security.md`.

## v0.9.1
- All patch/minor updates within the existing ranges.
- **zod 3 → 4** (security: GHSA-mrhx-c7xc-m3w5, memory exhaustion on oversized constrained collections). No schema changes were needed. The whole suite passes, validation errors keep the same `{ code, message, issues[] }` shape, and the advisory exception has been removed.

## Deferred majors (recommended order)
| Package | From → to | Why it waits / what it involves |
|---|---|---|
| vitest + unplugin-swc | 3 → 5, 1 → 2 | Test tooling only; do it first so later upgrades run on current tooling. |
| ESLint + @eslint/js | 9 → 10 | Lint tooling; flat config is already in place. |
| TypeScript | 5.9 → 7 | Compiler rewrite; expect new strictness errors. Do it before framework majors. |
| NestJS (common/core/platform-express/testing/cli) | 11 → 12 | Framework major. Check guards, the exception filter, raw-body and Express 5 integration. |
| BullMQ + ioredis | 5 → 6, 5 → 6 | Queue/Redis client majors. Re-test job schedulers, retries and the worker memory guard against real Redis. |
| Prisma (client + CLI) | 6 → 7 | New client generation and config. Re-run migrations from empty, the migration-compatibility check and the restore drill. Prisma 8 is still a release candidate: not for production. |
| Next.js | 15 → 16 | Rendering/runtime changes. Re-check standalone output, `KEEP_ALIVE_TIMEOUT`, rewrites and the CSP. |
| Tailwind CSS | 3 → 4 | New configuration model; every screen needs a visual check. |
| recharts, lucide-react | 2 → 3, 0.x → 1 | UI libraries; visual check of charts and icons. |
| pdfkit (+ types) | 0.15 → 0.20 | Re-render every report PDF and compare (fonts, Latin-1 handling, column widths). |
| otplib | 12 → 13 | API changes; MFA enrolment, verification and replay protection must be re-tested. |
| embedded-postgres | 17 → 18 (beta) | Tests should keep matching the production PostgreSQL major (17); move only together with the production image. |
| graphql (dev, Shopify query validation) | 16 → 17 | Dev tool; re-run `validate-queries`. |
| dotenv-cli, @types/supertest, @types/pdfkit | majors | Low risk; bundle with the related tool upgrades. |
