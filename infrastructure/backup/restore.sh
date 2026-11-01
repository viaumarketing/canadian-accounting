#!/bin/sh
# Restore an encrypted backup into a database, then check it.
#   docker compose -f compose.production.yaml exec backup /scripts/restore.sh /backups/<file> [target_db]
# The default target is a scratch database (ca_restore_test) so you can TEST a backup without touching live data.
# To replace the live database see docs/disaster-recovery.md (stop api and worker first; the target must be typed in full).
set -eu
set -o pipefail
file="${1:?usage: restore.sh <backup-file> [target_db]}"
target="${2:-ca_restore_test}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required}"
live="${PGDATABASE:-}"

if [ "$target" = "$live" ] && [ "${CONFIRM_REPLACE_LIVE:-}" != "$live" ]; then
  echo "Refusing to overwrite the live database '$live'. Set CONFIRM_REPLACE_LIVE=$live (and stop api + worker) if you really mean it." >&2
  exit 2
fi

if [ -f "$file.sha256" ]; then
  (cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256") || { echo "checksum mismatch: the file is damaged" >&2; exit 3; }
else
  echo "warning: no .sha256 file next to the backup; skipping checksum" >&2
fi

# Decrypt + decompress completely BEFORE touching any database, so a wrong passphrase or damaged file fails with nothing changed.
work=$(mktemp)
trap 'rm -f "$work"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$file" | gunzip > "$work" \
  || { echo "cannot decrypt/decompress: wrong BACKUP_PASSPHRASE or damaged file" >&2; exit 4; }
tail -n 5 "$work" | grep -q 'PostgreSQL database dump complete' || { echo "backup is truncated (no completion marker)" >&2; exit 5; }

dropdb --if-exists "$target"
createdb "$target"
psql -v ON_ERROR_STOP=1 -q -d "$target" -f "$work" >/dev/null
echo "restored into database: $target"

psql -d "$target" -tA <<'SQL'
SELECT 'users: ' || count(*) FROM "User";
SELECT 'companies: ' || count(*) FROM "Company";
SELECT 'posted journal entries: ' || count(*) FROM "JournalEntry" WHERE status = 'POSTED';
SELECT 'journal lines: ' || count(*) FROM "JournalLine";
SELECT 'ledger balanced (sum debit - sum credit): ' || COALESCE(sum(debit) - sum(credit), 0) FROM "JournalLine";
SELECT 'migrations applied: ' || count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;
SQL
