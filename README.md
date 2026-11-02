# Canadian Accounting

Self-hosted, multi-company accounting for Canadian businesses (double-entry ledger, GST/HST/QST/PST, Shopify, banking, reporting).
Built milestone by milestone; **currently: Milestone 6 (Security, packaging, backup and recovery)**, on top of Reporting (5), Banking (4), Shopify (3), Accounting core (2) and Foundation (1). See `docs/milestone-1.md` … `docs/milestone-6.md`, then `docs/v0.9.1.md` (year-end close, Quick Method, operations) and `docs/v0.9.2.md` (QuickBooks Online–style interface, invoices, sales receipts, products & services) for what exists and what does not; setup guides: `docs/shopify-setup.md`, `docs/banking-setup.md`.

| Path | What |
| --- | --- |
| `apps/web` | Next.js UI |
| `apps/api` | NestJS API (auth, tenancy, companies) |
| `apps/worker` | BullMQ worker (skeleton) |
| `packages/canadian-tax` | Effective-dated GST/HST/QST/PST calculation |
| `packages/accounting-engine` | Balance checks, document → journal builders |
| `packages/shopify-integration` | Shopify OAuth, GraphQL client, mappers, posting rules |
| `packages/banking` | CSV/OFX parsing, matching, reconciliation math, bank-provider adapter (Plaid) |
| `packages/reporting` | Report model and CSV / XLSX / PDF renderers |
| `packages/shared` | Zod schemas, roles and permissions |
| `packages/database` | Prisma schema and migrations |
| `infrastructure/` | Dockerfile, Caddy, backup scripts |

- Setup on a Mac: [docs/macos-setup.md](docs/macos-setup.md)
- Architecture and security model: [docs/architecture.md](docs/architecture.md)
- Milestone report and manual tests: [docs/milestone-1.md](docs/milestone-1.md)

## Production on a UGREEN NAS

Target: **UGREEN DXP2800** (Intel N100, 8 GB). Verified with linux/amd64 images on Docker Desktop; **not yet run on the NAS itself.**
- **Beginner installation guide: [docs/dxp2800-install-guide.md](docs/dxp2800-install-guide.md)**. Sizing, test results and the production-readiness gate: [docs/dxp2800.md](docs/dxp2800.md)
- Images (`server`, `web`, `backup`, linux/amd64) are built by GitHub Actions (`release.yml`, on `vX.Y.Z` tags, after lint/tests/audit/migration checks) and pushed to GHCR; nothing is built on the NAS.
- Install, ports, certificates: [docs/ugreen-nas.md](docs/ugreen-nas.md)
- Backups, restore tests, disaster recovery, upgrade and rollback (`scripts/upgrade.sh`, `scripts/rollback.sh`, `scripts/restore-live.sh`): [docs/backup-and-recovery.md](docs/backup-and-recovery.md)
- Security controls, tests and known gaps: [docs/security.md](docs/security.md)
- Keep it private: reach it over a VPN; do not port-forward it to the internet. **Save `.env` somewhere else**: without `ENCRYPTION_KEY` and `BACKUP_PASSPHRASE` the backups are useless.
