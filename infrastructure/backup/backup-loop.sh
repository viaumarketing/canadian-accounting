#!/bin/sh
# Runs a backup at start-up and then every BACKUP_INTERVAL_HOURS (default 24). Failures are logged and retried next cycle;
# the container's health check turns unhealthy when the newest backup is older than two intervals.
set -u
interval=$(( ${BACKUP_INTERVAL_HOURS:-24} * 3600 ))
while true; do
  /bin/sh /scripts/backup-once.sh || echo "BACKUP FAILED at $(date -u +%FT%TZ)" >&2
  sleep "$interval"
done
