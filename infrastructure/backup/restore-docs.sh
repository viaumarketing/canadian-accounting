#!/bin/sh
# Put the documents archive that belongs to a database backup back into the documents folder.
#   /scripts/restore-docs.sh /backups/ca-YYYYmmdd-HHMMSS.sql.gz.enc
# Files are content-addressed and never change, so extracting over the folder only adds what is missing.
set -eu
set -o pipefail
db_file="${1:?usage: restore-docs.sh <database backup file>}"
docs="${db_file%.sql.gz.enc}.docs.tar.gz.enc"
: "${DOCUMENTS_DIR:?DOCUMENTS_DIR is required}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required}"
if [ ! -f "$docs" ]; then echo "no documents archive for this backup ($docs); nothing to restore"; exit 0; fi
if [ -f "$docs.sha256" ]; then
  (cd "$(dirname "$docs")" && sha256sum -c "$(basename "$docs").sha256") || { echo "documents archive checksum mismatch" >&2; exit 3; }
fi
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$docs" | gunzip | tar -C "$DOCUMENTS_DIR" -xf - \
  || { echo "cannot restore documents: wrong passphrase or damaged archive" >&2; exit 4; }
echo "documents restored: $(find "$DOCUMENTS_DIR" -type f | wc -l | tr -d ' ') files in $DOCUMENTS_DIR"
