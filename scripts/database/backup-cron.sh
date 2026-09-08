#!/bin/sh
# Scheduling loop for backup.sh.
#
# A container is a poor host for a cron daemon — no mail, no job control, and
# the logs end up somewhere Docker cannot see — so the schedule is just a
# sleep. One backup a day at a fixed UTC hour is what a single VPS needs.
#
#   BACKUP_AT_HOUR   UTC hour to run at (default 3)
#   BACKUP_ON_START  take one immediately on boot (default 1)
#
# A failed run is logged and the loop continues: a backup failing today must
# not stop tomorrow's from being attempted.

set -u

HOUR="${BACKUP_AT_HOUR:-3}"
DIR="$(dirname "$0")"

log () { echo "[backup-cron $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

run () {
  if "$DIR/backup.sh"; then log "backup succeeded"
  else log "backup FAILED with status $? — will retry at the next scheduled run"; fi
}

log "scheduled daily at ${HOUR}:00 UTC"
[ "${BACKUP_ON_START:-1}" = "1" ] && run

while true; do
  # Strip leading zeros without bash's 10# notation, which busybox sh in the
  # alpine image does not support — "08" would otherwise be an invalid octal.
  NOW_H=$(date -u +%H); NOW_H=${NOW_H#0}; NOW_H=${NOW_H:-0}
  NOW_M=$(date -u +%M); NOW_M=${NOW_M#0}; NOW_M=${NOW_M:-0}
  NOW_S=$(date -u +%S); NOW_S=${NOW_S#0}; NOW_S=${NOW_S:-0}
  SECONDS_UNTIL=$(( (HOUR - NOW_H) * 3600 - NOW_M * 60 - NOW_S ))
  [ "$SECONDS_UNTIL" -le 0 ] && SECONDS_UNTIL=$((SECONDS_UNTIL + 86400))
  log "next run in $((SECONDS_UNTIL / 3600))h $(((SECONDS_UNTIL % 3600) / 60))m"
  sleep "$SECONDS_UNTIL"
  run
done
