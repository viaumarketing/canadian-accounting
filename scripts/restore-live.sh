#!/bin/sh
# Replace the LIVE database with a backup:  scripts/restore-live.sh ca-20261101-020000.sql.gz.enc
# Everything entered after that backup is lost. api, worker, web and caddy are stopped first and started again afterwards.
. "$(dirname "$0")/lib.sh"
file="${1:?usage: scripts/restore-live.sh <backup file name from the backups folder>}"
db=$(env_get POSTGRES_DB); db="${db:-canadian_accounting}"
echo "This will REPLACE the live database '$db' with $file. Data entered after that backup will be lost."
if [ "${ASSUME_YES:-}" != "REPLACE" ]; then
  printf "Type REPLACE to continue: "; read -r answer
  [ "$answer" = "REPLACE" ] || { echo "Cancelled."; exit 1; }
fi
dc stop caddy web api worker
dc exec -T -e CONFIRM_REPLACE_LIVE="$db" backup /scripts/restore.sh "/backups/$file" "$db"
dc exec -T backup /scripts/restore-docs.sh "/backups/$file"
dc up -d
wait_healthy api 60 && echo "Restored and healthy." || { echo "Restored, but the API is not healthy yet: check the logs." >&2; exit 1; }
