#!/bin/sh
# Scheduling loop for backup.sh — and the panel's hands.
#
# A container is a poor host for a cron daemon — no mail, no job control, and
# the logs end up somewhere Docker cannot see — so the schedule is just a
# sleep. One backup a day at a fixed UTC hour is what a single VPS needs.
#
# Amiért a ciklus mégsem egyetlen hosszú alvás: a panel innen kér mentést,
# ellenőrzést és visszaállítást. Ez a konténer az egyetlen hely, ahol együtt
# van a `pg_dump`, a `pg_restore` és a kötet — az API-ban egyik sincs, és nem
# is kell legyen: egy webalkalmazásnak nem dolga adatbázist ejteni.
#
# A parancscsatorna az adatbázis: a panel sort ír a `backup_requests` táblába,
# ez a ciklus felveszi. Nincs új port, nincs socket, nincs megosztott titok.
#
#   BACKUP_AT_HOUR     UTC hour to run at (default 3)
#   BACKUP_ON_START    take one immediately on boot (default 1)
#   BACKUP_POLL_SEC    how often to look for a request (default 20)
#
# A failed run is logged and the loop continues: a backup failing today must
# not stop tomorrow's from being attempted.

set -u

HOUR="${BACKUP_AT_HOUR:-3}"
POLL="${BACKUP_POLL_SEC:-20}"
DIR="$(dirname "$0")"

log () { echo "[backup-cron $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# Egy sor az adatbázisból, szóközök nélkül. Hiba esetén üres — a ciklusnak nem
# szabad elhasalnia attól, hogy az adatbázis egy pillanatra nem válaszol.
ask () { psql "$DATABASE_URL" -tAc "$1" 2>/dev/null || echo ""; }
tell () { psql "$DATABASE_URL" -qc "$1" >/dev/null 2>&1 || log "note: could not write back"; }

# Az ütemezés kapcsolója a site_settings-ben ül, a többi beállítás mellett.
# Hiánya bekapcsolt állapotot jelent: egy példány, amin senki nem járt a
# panelen, ugyanúgy ment, mint eddig.
scheduled_on () {
  [ "$(ask "SELECT coalesce((SELECT value #>> '{}' FROM site_settings WHERE key = 'backup_schedule_enabled'), 'true')")" != "false" ]
}

run_scheduled () {
  if ! scheduled_on; then log "scheduled run skipped — switched off in the panel"; return; fi
  if "$DIR/backup.sh"; then log "backup succeeded"
  else log "backup FAILED with status $? — will retry at the next scheduled run"; fi
}

# ------------------------------------------------------------ panel requests
serve_request () {
  ID=$(ask "SELECT id FROM backup_requests WHERE status = 'pending' ORDER BY id LIMIT 1")
  [ -n "$ID" ] || return 0

  KIND=$(ask "SELECT kind FROM backup_requests WHERE id = $ID")
  FILE=$(ask "SELECT coalesce(filename, '') FROM backup_requests WHERE id = $ID")
  tell "UPDATE backup_requests SET status = 'running', started_at = now() WHERE id = $ID"
  log "request #$ID: $KIND ${FILE:-（newest）}"

  OUT=""
  STATUS=done
  case "$KIND" in
    backup)
      OUT=$("$DIR/backup.sh" 2>&1) || STATUS=failed
      ;;
    verify)
      # Visszaállítás egy eldobható adatbázisba. Ez a biztonságos válasz arra,
      # hogy „jó-e ez a mentés": megmondja, anélkül hogy bármit kockáztatna.
      OUT=$(FORCE=1 "$DIR/restore.sh" --into yume_verify_panel "$FILE" 2>&1) || STATUS=failed
      psql "$(echo "$DATABASE_URL" | sed 's#/[^/?]*\(?\|$\)#/postgres\1#')" \
        -qc "DROP DATABASE IF EXISTS yume_verify_panel" >/dev/null 2>&1 || true
      ;;
    restore)
      # Az éles adatbázis felülírása. A panel csak akkor enged idáig, ha a
      # példány csak olvasható módban van — de a szkript maga is blunt, és ez
      # így helyes: ezt a parancsot a legrosszabb napon futtatja valaki.
      OUT=$(FORCE=1 "$DIR/restore.sh" "$FILE" 2>&1) || STATUS=failed
      ;;
    *)
      OUT="unknown request kind: $KIND"; STATUS=failed
      ;;
  esac

  # Az utolsó néhány sor elég: a teljes napló a konténeré, ez a panelé.
  TAIL=$(printf '%s' "$OUT" | tail -c 4000 | sed "s/'/''/g")
  tell "UPDATE backup_requests SET status = '$STATUS', finished_at = now(), log = '$TAIL' WHERE id = $ID"
  log "request #$ID finished: $STATUS"
}

# --------------------------------------------------------- árva kérések
#
# EZ A CIKLUS AZ EGYETLEN GAZDÁJA a `backup_requests` soroknak: ez veszi fel,
# ez jelöli futónak, ez zárja le. Amit tehát INDULÁSKOR futó állapotban
# találunk, annak nincs gazdája — a folyamat, ami elkezdte, már nem él.
#
# Amíg ez nem volt itt, egy ilyen sor ÖRÖKRE ott maradt, és mivel a táblán
# egyszerre csak egy aktív kérés lehet, a panel „Mentés most" gombja tartósan
# 409-et adott: „Egy backup kérés már fut vagy sorban áll." Semmi nem futott.
#
# Két úton keletkezik, és mindkettő valódi:
#
#   * a konténer leáll a mentés közepén (újraindítás, frissítés, OOM);
#   * VISSZAÁLLÍTÁS. A mentés a saját kérés-sorát is lementi, futó állapotban
#     — a dump pillanatában tényleg az volt. A visszaállított példányon ezért
#     ott ül egy futás, ami sosem fejeződik be. Pont akkor blokkolja a
#     mentést, amikor a legnagyobb szükség lenne rá: katasztrófa után.
#
# A `pending` sorokat MEGHAGYJUK: azok még nem kezdődtek el, és a ciklus fel
# fogja venni őket. Csak ami „fut", az hazugság.
reclaim_orphans () {
  ORPHANS=$(ask "SELECT count(*) FROM backup_requests WHERE status = 'running'")
  [ "${ORPHANS:-0}" != "0" ] || return 0
  log "reclaiming $ORPHANS orphaned request(s) — nothing was running when this loop started"
  tell "UPDATE backup_requests
           SET status = 'failed', finished_at = now(),
               log = coalesce(log || E'\n', '') || 'megszakadt: a mentési folyamat leállt, vagy a sor visszaállításból származik'
         WHERE status = 'running'"
}

log "scheduled daily at ${HOUR}:00 UTC; polling for panel requests every ${POLL}s"
reclaim_orphans
[ "${BACKUP_ON_START:-1}" = "1" ] && run_scheduled

LAST_RUN_DAY=""
while true; do
  serve_request

  NOW_H=$(date -u +%H); NOW_H=${NOW_H#0}; NOW_H=${NOW_H:-0}
  TODAY=$(date -u +%Y-%m-%d)
  # Óránál nem pontosabb, és nem is kell: naponta egyszer, a megadott órában.
  # A nap eltárolása az, ami miatt a percenkénti ébredés nem jelent percenkénti
  # mentést.
  if [ "$NOW_H" = "$HOUR" ] && [ "$TODAY" != "$LAST_RUN_DAY" ]; then
    LAST_RUN_DAY="$TODAY"
    run_scheduled
  fi

  sleep "$POLL"
done
