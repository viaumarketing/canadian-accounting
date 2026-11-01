#!/bin/sh
# One encrypted, verified database backup.
#   output: $BACKUP_DIR/ca-YYYYmmdd-HHMMSS.sql.gz.enc (+ .sha256)
#   format: plain-SQL pg_dump | gzip | AES-256-CBC (PBKDF2, 200k iterations, passphrase from BACKUP_PASSPHRASE)
# A backup only counts once it has been decrypted again and checked; a failed attempt leaves nothing that looks valid.
set -eu
umask 077
set -o pipefail
BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_MIN="${BACKUP_KEEP_MIN:-7}"          # never delete the newest N, however old they are
KEEP_DAYS="${BACKUP_RETENTION_DAYS:-30}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required}"

ts=$(date -u +%Y%m%d-%H%M%S)
out="$BACKUP_DIR/ca-$ts.sql.gz.enc"
tmp="$out.partial"
cleanup() { rm -f "$tmp" "$tmp.sql.gz"; }
trap cleanup EXIT

pg_dump --format=plain --no-owner --no-privileges | gzip -9 \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$tmp"

# Verify: it must decrypt, decompress without error, and end with pg_dump's completion marker.
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$tmp" | gzip -t
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$tmp" | gunzip | tail -n 5 | grep -q 'PostgreSQL database dump complete' \
  || { echo "backup verification failed: dump is incomplete" >&2; exit 1; }

# Documents (bank statement files) are archived AFTER the database dump. Files are only ever added, never changed, so this
# archive always contains every file the dump refers to (and possibly a few newer ones, which are harmless).
docs_out=""
if [ -n "${DOCUMENTS_DIR:-}" ] && [ -d "$DOCUMENTS_DIR" ]; then
  docs_out="$BACKUP_DIR/ca-$ts.docs.tar.gz.enc"
  docs_tmp="$docs_out.partial"
  trap 'cleanup; rm -f "$docs_tmp"' EXIT
  tar -C "$DOCUMENTS_DIR" -cf - --exclude='*.tmp-*' . | gzip -6 \
    | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$docs_tmp"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$docs_tmp" | gzip -t
  mv "$docs_tmp" "$docs_out"
  (cd "$BACKUP_DIR" && sha256sum "$(basename "$docs_out")" > "$(basename "$docs_out").sha256")
fi

mv "$tmp" "$out"
(cd "$BACKUP_DIR" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256")
echo "backup written: $out ($(wc -c < "$out") bytes)${docs_out:+ + documents $(wc -c < "$docs_out") bytes}"

# Retention: delete files older than KEEP_DAYS, but always keep the newest KEEP_MIN so a run of failures can never empty the folder.
ls -1t "$BACKUP_DIR"/ca-*.sql.gz.enc 2>/dev/null | tail -n +"$((KEEP_MIN + 1))" | while read -r f; do
  if [ -n "$(find "$f" -mtime +"$KEEP_DAYS" 2>/dev/null)" ]; then
    d="${f%.sql.gz.enc}.docs.tar.gz.enc"
    rm -f "$f" "$f.sha256" "$d" "$d.sha256"; echo "pruned: $f"
  fi
done
