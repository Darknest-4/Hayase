#!/bin/sh
# Yume database backup.
#
# Runs pg_dump in custom format (compressed, and restorable selectively),
# writes it under a timestamped name, prunes by age, and — this is the part
# that matters — restores the fresh dump into a scratch database to prove it
# can be read back. A backup nobody has restored is a guess, not a backup.
#
# Usage:
#   ./backup.sh              take a backup, verify it, prune old ones
#   ./backup.sh --no-verify  skip the restore check (faster, weaker)
#
# Environment:
#   DATABASE_URL     required — the database to dump
#   BACKUP_DIR       where dumps land          (default /backups)
#   BACKUP_KEEP_DAYS how long to keep them     (default 14)
#   BACKUP_VERIFY_DB scratch database name     (default yume_verify)
#
# Exit codes: 0 success · 1 dump failed · 2 verification failed · 3 misconfigured

set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
VERIFY_DB="${BACKUP_VERIFY_DB:-yume_verify}"
VERIFY=1
[ "${1:-}" = "--no-verify" ] && VERIFY=0


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

log () { echo "[backup $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
fail () { log "ERROR: $1"; exit "${2:-1}"; }

[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is not set" 3
command -v pg_dump >/dev/null 2>&1 || fail "pg_dump is not on PATH" 3

mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DUMP="$BACKUP_DIR/yume-$STAMP.dump"

# ---------------------------------------------------------------- dump
# Custom format (-Fc): compressed, and pg_restore can pull single tables out
# of it. --no-owner/--no-privileges keep it restorable under a different role,
# which is what a recovery onto a fresh host actually needs.
log "dumping to $(basename "$DUMP")"
if ! pg_dump "$DATABASE_URL" --format=custom --compress=6 --no-owner --no-privileges --file="$DUMP.partial"; then
  rm -f "$DUMP.partial"
  fail "pg_dump failed — no backup was written"
fi

# Only rename once the dump completed, so a half-written file can never be
# mistaken for a usable backup by the restore script or by a human in a hurry.
mv "$DUMP.partial" "$DUMP"
SIZE=$(wc -c < "$DUMP" | tr -d ' ')
log "wrote $SIZE bytes"

# A dump far too small to hold a schema means something went wrong quietly.
[ "$SIZE" -gt 4096 ] || fail "dump is only $SIZE bytes — refusing to trust it" 1

# ---------------------------------------------------------------- verify
if [ "$VERIFY" -eq 1 ]; then
  log "verifying by restoring into $VERIFY_DB"
  ADMIN_URL=$(with_db "$DATABASE_URL" postgres)

  psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $VERIFY_DB" >/dev/null
  psql "$ADMIN_URL" -qc "CREATE DATABASE $VERIFY_DB" >/dev/null
  VERIFY_URL=$(with_db "$DATABASE_URL" "$VERIFY_DB")

  if ! pg_restore --dbname="$VERIFY_URL" --no-owner --no-privileges "$DUMP" >/dev/null 2>&1; then
    psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $VERIFY_DB" >/dev/null
    fail "the dump could not be restored — treat this backup as broken" 2
  fi

  # Restoring without error is necessary but not sufficient: an empty database
  # restores perfectly. Check the tables that must never be empty.
  USERS=$(psql "$VERIFY_URL" -tAc "SELECT count(*) FROM users" 2>/dev/null || echo err)
  MIGRATIONS=$(psql "$VERIFY_URL" -tAc "SELECT count(*) FROM schema_migrations" 2>/dev/null || echo err)
  PERMISSIONS=$(psql "$VERIFY_URL" -tAc "SELECT count(*) FROM permissions" 2>/dev/null || echo err)
  psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $VERIFY_DB" >/dev/null

  case "$MIGRATIONS$PERMISSIONS" in
    *err*) fail "the restored database is missing core tables" 2 ;;
  esac
  [ "$MIGRATIONS" -gt 0 ] || fail "the restored database has no migration history" 2
  [ "$PERMISSIONS" -gt 0 ] || fail "the restored database has no permissions" 2

  log "verified: $MIGRATIONS migrations, $PERMISSIONS permissions, $USERS users"
fi

# ---------------------------------------------------------------- prune
# Pruning runs last and only after a verified backup exists, so a run that
# failed can never be the reason older backups disappeared.
PRUNED=$(find "$BACKUP_DIR" -maxdepth 1 -name 'yume-*.dump' -type f -mtime "+$KEEP_DAYS" -print -delete | wc -l | tr -d ' ')
[ "$PRUNED" -gt 0 ] && log "pruned $PRUNED backup(s) older than $KEEP_DAYS days"

REMAINING=$(find "$BACKUP_DIR" -maxdepth 1 -name 'yume-*.dump' -type f | wc -l | tr -d ' ')
log "done — $REMAINING backup(s) on hand"
