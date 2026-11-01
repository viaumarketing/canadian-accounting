#!/bin/sh
# Upgrade to another released version:  scripts/upgrade.sh 0.2.0
# Takes a verified backup first, switches APP_VERSION, pulls the images, applies database migrations, restarts, and waits for health.
# If anything fails it tells you how to go back (scripts/rollback.sh). It records the schema level the old version supports, so
# rollback can tell whether the old version still runs on the upgraded database (keeps your data) or the backup must be restored.
. "$(dirname "$0")/lib.sh"
new="${1:?usage: scripts/upgrade.sh <version>   e.g. 0.2.0}"
old=$(env_get APP_VERSION)
old_level=$(app_schema_level)
[ "$new" != "$old" ] || { echo "Already on $old." >&2; exit 1; }

echo "1/4  Backing up the database before changing anything..."
out=$(dc exec -T backup /bin/sh /scripts/backup-once.sh) || { echo "Backup failed; nothing was changed. $out" >&2; exit 1; }
pre=$(echo "$out" | sed -n 's|^backup written: /backups/\([^ ]*\) .*|\1|p' | tail -n 1)
[ -n "$pre" ] || { echo "Could not tell which backup was written; nothing was changed." >&2; exit 1; }
echo "     pre-upgrade backup: $pre"

echo "2/4  Switching $old -> $new and pulling images..."
env_set APP_VERSION "$new"
if ! pull_images; then
  env_set APP_VERSION "$old"
  echo "Could not pull version $new (is it released, and are you logged in to the registry?). Nothing was changed." >&2
  exit 1
fi

printf '%s %s %s\n' "$old" "$pre" "${old_level:-unknown}" > .last-upgrade

echo "3/4  Applying migrations and restarting..."
dc up -d
echo "4/4  Waiting for the API to become healthy..."
if wait_healthy api 60 && wait_healthy web 24; then
  echo "Upgraded to $new."
  exit 0
fi
echo "The new version did not become healthy. Look at: docker compose -f compose.production.yaml logs api migrate" >&2
echo "To go back to $old with the pre-upgrade data, run: scripts/rollback.sh" >&2
exit 1
