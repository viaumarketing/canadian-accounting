# Backup and disaster recovery

## What is backed up
`backup` container: a verified, encrypted `pg_dump` of the whole database **and an archive of the documents folder** (original bank statement files) at start-up and every `BACKUP_INTERVAL_HOURS` (24). Files: `$DATA_DIR/backups/ca-YYYYmmdd-HHMMSS.sql.gz.enc` and `ca-YYYYmmdd-HHMMSS.docs.tar.gz.enc` (each with a `.sha256`), mode 600. The documents archive is taken after the dump; files are only ever added, so it always holds every file the dump refers to. Each backup is decrypted and checked before it counts; a failed run leaves no file. The newest 7 are always kept; older ones are removed after `BACKUP_RETENTION_DAYS` (30). The container turns **unhealthy** if the newest backup is older than two intervals, and **System administration → System health** shows backup age.

## What is NOT in the backup — keep these separately and offsite
1. **`.env`** — above all `ENCRYPTION_KEY` and `BACKUP_PASSPHRASE`. Without the passphrase the backups cannot be opened; without the key, MFA secrets and Shopify/bank tokens in a restored database are unreadable (the app reports `ENCRYPTION_KEY_MISMATCH` and stays unready).
2. A **copy of the backup files** on a different device or location. A backup on the same NAS does not survive the NAS.
3. Caddy's certificate state (`$DATA_DIR/caddy`) is re-creatable; devices must re-trust a new internal CA if it is lost.

## Test a backup (do this monthly)
```bash
docker compose -f compose.production.yaml exec backup /scripts/restore.sh /backups/<file>
```
Restores into a scratch database `ca_restore_test` (never the live one) and prints row counts and a ledger-balance check (`sum debit - sum credit` must be 0). Wrong passphrase, damaged or truncated files fail before any database is touched.

## Restore the live database
```bash
scripts/restore-live.sh <file name from the backups folder>
```
Stops caddy/web/api/worker, replaces the database, puts back the documents from the matching archive, starts everything and waits for health. Everything entered after that backup is lost.

## Disaster recovery runbook (NAS lost or rebuilt)
1. New host with Docker; get the repository files (or just `compose.production.yaml`, `infrastructure/`, `scripts/`).
2. Put the saved **`.env`** in place (same `ENCRYPTION_KEY`, `BACKUP_PASSPHRASE`, `POSTGRES_*`). Create `$DATA_DIR/{postgres,redis,backups,caddy/data,caddy/config}`.
3. Copy your chosen backup (and `.sha256`) into `$DATA_DIR/backups/`.
4. `docker compose -f compose.production.yaml up -d postgres redis backup`
5. `sh scripts/restore-live.sh <file>` (it asks you to type REPLACE). Note the backup container will first take a backup of the empty database; that is harmless.
6. Open the site, sign in (MFA works only with the original `ENCRYPTION_KEY`), then System health: database, backups and **Encryption key: ok**.
7. Run a Trial Balance and confirm the checks are green. Re-run Shopify/bank syncs; webhook and OAuth URLs must match the new host name (`SITE_ADDRESS`).

## Upgrade and rollback
`scripts/upgrade.sh 1.1.0`: backup → pull → migrate → wait for health. It records the old version, the pre-upgrade backup and the **schema level** the old version supports.

`scripts/rollback.sh` then picks the safe way back:
- **App-only rollback (keeps your data).** This applies when every migration in the upgrade was *additive*, so the database's schema level is still one the old version supports. It switches back to the old images on the current database. Nothing entered since the upgrade is lost.
- **Data rollback.** This applies when the upgrade included a *breaking* migration (which raised the level), or when the old version doesn't come up healthy. It restores the pre-upgrade backup and documents. Anything entered since the upgrade is lost, and the script says so.
- `scripts/rollback.sh --restore-data` forces the second mode.

An old build never runs against a schema it does not understand: it reports `SCHEMA_TOO_NEW` and stays unready, and the worker refuses to start jobs. CI (`scripts/check-migrations.mjs`) rejects any migration that is declared additive but drops, renames or retypes something, makes a column required, or adds an enum value. Such a migration must be declared breaking and raise the level (in the migration and in `SCHEMA_COMPAT_LEVEL`). The usual way to avoid breaking changes is expand, then contract: add the new column in release N, and drop the old one in release N+1 or later.

For a host without registry access, `docker load` the images and set `SKIP_PULL=1`.

## Verified vs not
Verified on Docker Desktop (Mac): backup, verification, restore, failure modes, whole-stack drill (row counts of all tables, per-account totals, user rows, triggers identical; API booted on the restored database signed in with MFA), upgrade, rollback. **Not verified**: on UGREEN hardware, restores of very large databases, Postgres major-version upgrades (`postgres:17` is pinned; a major upgrade needs dump/restore).
