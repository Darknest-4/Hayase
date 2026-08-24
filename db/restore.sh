#!/bin/sh
# Yume database restore.
#
# This is the script you run on the worst day, so it is deliberately blunt:
# it names exactly what it is about to destroy, refuses to guess, and requires
# an explicit confirmation before it touches anything.
#
# Usage:
#   ./restore.sh                        restore the newest backup (asks first)
#   ./restore.sh yume-20260822T0300Z.dump   restore a specific one
#   ./restore.sh --list                 show what is available
#   ./restore.sh --into yume_copy FILE  restore beside the live database
#
# Environment:
#   DATABASE_URL   required — the target database
#   BACKUP_DIR     where dumps live (default /backups)
#   FORCE=1        skip the confirmation prompt (for automated drills only)
#
# Exit codes: 0 success · 1 restore failed · 3 misconfigured · 4 cancelled

set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
TARGET_DB=""


# ---------------------------------------------------------------- url helpers
# A connection string may carry a query (postgres://dev@/yume?host=/var/run/pg),
# and that query can itself contain slashes — so the database name is swapped
# with parameter expansion on the path only, never with a "last slash" regex.
with_db () {
  _url="$1"; _db="$2"
  case "$_url" in
    *\?*) _base="${_url%%\?*}"; _query="?${_url#*\?}" ;;
    *)    _base="$_url"; _query="" ;;
  esac
  echo "${_base%/*}/${_db}${_query}"
}

db_name () {
  _url="$1"
  case "$_url" in *\?*) _url="${_url%%\?*}" ;; esac
  echo "${_url##*/}"
}

log () { echo "[restore] $*"; }
fail () { log "ERROR: $1"; exit "${2:-1}"; }

[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is not set" 3
command -v pg_restore >/dev/null 2>&1 || fail "pg_restore is not on PATH" 3

# ---------------------------------------------------------------- arguments
DUMP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list)
      log "backups in $BACKUP_DIR:"
      ls -lh "$BACKUP_DIR"/yume-*.dump 2>/dev/null || log "  (none)"
      exit 0 ;;
    --into) TARGET_DB="$2"; shift 2 ;;
    -*) fail "unknown option $1" 3 ;;
    *) DUMP="$1"; shift ;;
  esac
done

# Newest by name — the timestamp format sorts chronologically.
if [ -z "$DUMP" ]; then
  DUMP=$(ls -1 "$BACKUP_DIR"/yume-*.dump 2>/dev/null | sort | tail -1 || true)
  [ -n "$DUMP" ] || fail "no backups found in $BACKUP_DIR — run backup.sh first" 3
fi
case "$DUMP" in */*) ;; *) DUMP="$BACKUP_DIR/$DUMP" ;; esac
[ -f "$DUMP" ] || fail "no such backup: $DUMP" 3

# ---------------------------------------------------------------- target
ADMIN_URL=$(with_db "$DATABASE_URL" postgres)
if [ -n "$TARGET_DB" ]; then
  RESTORE_URL=$(with_db "$DATABASE_URL" "$TARGET_DB")
else
  TARGET_DB=$(db_name "$DATABASE_URL")
  RESTORE_URL="$DATABASE_URL"
fi

# ---------------------------------------------------------------- confirm
log "backup : $(basename "$DUMP") ($(wc -c < "$DUMP" | tr -d ' ') bytes, $(date -r "$DUMP" -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo 'unknown date'))"
log "target : database \"$TARGET_DB\""
log ""
log "This DROPS \"$TARGET_DB\" and everything in it, then rebuilds it from the backup."

if [ "${FORCE:-0}" != "1" ]; then
  printf '[restore] Type the database name to confirm: '
  read -r CONFIRM
  [ "$CONFIRM" = "$TARGET_DB" ] || fail "cancelled — you typed \"$CONFIRM\"" 4
fi

# ---------------------------------------------------------------- restore
log "disconnecting other sessions"
psql "$ADMIN_URL" -qc \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TARGET_DB' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true

log "recreating $TARGET_DB"
psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $TARGET_DB" >/dev/null
# ENCODING is stated, not inherited: a bare CREATE DATABASE copies template1,
# so restoring onto a cluster whose template is SQL_ASCII would silently
# produce a database that cannot fold accented letters. template0 is used
# because template1 may carry a conflicting encoding.
psql "$ADMIN_URL" -qc "CREATE DATABASE $TARGET_DB ENCODING 'UTF8' LOCALE 'C.UTF-8' TEMPLATE template0" >/dev/null

log "restoring"
if ! pg_restore --dbname="$RESTORE_URL" --no-owner --no-privileges --exit-on-error "$DUMP"; then
  fail "restore failed — \"$TARGET_DB\" now exists but is incomplete"
fi

MIGRATIONS=$(psql "$RESTORE_URL" -tAc "SELECT count(*) FROM schema_migrations" 2>/dev/null || echo 0)
USERS=$(psql "$RESTORE_URL" -tAc "SELECT count(*) FROM users" 2>/dev/null || echo 0)
log "restored: $MIGRATIONS migrations, $USERS users"
log ""
log "Extension packages live outside the database (PACKAGE_DIR / the"
log "yume-packages volume). Restore that volume too, or installed extensions"
log "will download as 410 Gone."
