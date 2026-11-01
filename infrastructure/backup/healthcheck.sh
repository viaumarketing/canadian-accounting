#!/bin/sh
# Healthy = a verified backup exists and is younger than two backup intervals.
max=$(( ${BACKUP_INTERVAL_HOURS:-24} * 120 ))   # minutes
newest=$(ls -1t "${BACKUP_DIR:-/backups}"/ca-*.sql.gz.enc 2>/dev/null | head -n 1)
[ -n "$newest" ] && [ -z "$(find "$newest" -mmin +"$max")" ]
