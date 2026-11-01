#!/bin/sh
# Undo the last scripts/upgrade.sh.
#   scripts/rollback.sh                 old version on the current database when that is safe, otherwise restore the pre-upgrade backup
#   scripts/rollback.sh --restore-data  always restore the pre-upgrade backup (everything entered since the upgrade is lost)
# "Safe" means every migration the upgrade applied was additive: the database's schema level is still one the old version supports.
. "$(dirname "$0")/lib.sh"
[ -f .last-upgrade ] || { echo "No .last-upgrade file: nothing recorded to roll back." >&2; exit 1; }
read -r old pre old_level < .last-upgrade
force_restore=no; [ "${1:-}" = "--restore-data" ] && force_restore=yes
db_level=$(db_schema_level)
echo "Rolling back to version $old (it supports schema level ${old_level:-unknown}; the database is at ${db_level:-unknown})."

case "$old_level" in ''|unknown|*[!0-9]*) compatible=no ;; *) case "$db_level" in ''|*[!0-9]*) compatible=no ;; *) [ "$db_level" -le "$old_level" ] && compatible=yes || compatible=no ;; esac ;; esac

env_set APP_VERSION "$old"
pull_images
if [ "$compatible" = yes ] && [ "$force_restore" = no ]; then
  echo "The upgrade only made additive database changes: running $old on the current data (nothing is lost)."
  dc up -d
  if wait_healthy api 60; then echo "Rolled back to $old; your data since the upgrade is kept."; exit 0; fi
  echo "$old did not become healthy on the current database; falling back to restoring the pre-upgrade backup." >&2
fi
echo "Restoring the database as it was before the upgrade ($pre). Anything entered since the upgrade will be lost."
dc up -d backup
sh "$(dirname "$0")/restore-live.sh" "$pre"
