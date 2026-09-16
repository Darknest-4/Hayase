#!/bin/sh
# Egy ellenőrzött mentés másolata a Cloudflare R2-be.
#
# MIÉRT LÉTEZIK
# -------------
# A `backup.sh` naponta készít egy dumpot, visszaállítással ellenőrzi, és a
# `backups` kötetre teszi. Ez túlél egy rossz telepítést és egy eldobott
# táblát — de nem éli túl a GÉPET. Az audit ezt nevezte meg a mentés második
# legfontosabb kockázataként: az adatbázis és a mentése ugyanazon a lemezen ül,
# és egy lemezhiba egyszerre viszi mindkettőt.
#
# A `backup.sh` a `BACKUP_SYNC_CMD` horgon hívja ezt, a dump útvonalával mint
# $1, és CSAK sikeres ellenőrzés után. Egy itteni hiba hangos, de nem végzetes:
# a helyi mentés addigra már ellenőrzött, és a holnapi másolatot elveszíteni
# azért, mert a mai feltöltés elhasalt, rosszabb lenne.
#
# AMIT CSINÁL, ÉS AMIT NEM
# ------------------------
# Csinál: feltölt, majd ELLENŐRZI, hogy a távoli méret egyezik a helyivel, és
# lejárt objektumokat töröl. Nem csinál: titkosítást — az R2 nyugalmi állapotban
# titkosít, és egy saját kulcs, amit sehol nem őrzünk meg, a visszaállítást
# tenné lehetetlenné. Ha ez kell, `rclone crypt` a helye, de a kulcsnak külön
# őrzési helyet kell találni ELŐBB.
#
# Környezet (mind a compose-ból, a .env-en keresztül):
#   R2_BUCKET               a célvödör neve
#   R2_ENDPOINT             https://<fiókazonosító>.r2.cloudflarestorage.com
#   R2_ACCESS_KEY_ID        R2 API-token hozzáférési kulcsa
#   R2_SECRET_ACCESS_KEY    a hozzá tartozó titok
#   R2_PREFIX               opcionális útvonal a vödrön belül (alap: yume)
#   BACKUP_KEEP_DAYS        a távoli megőrzés is ezt követi (alap: 14)
#
# Kilépési kódok: 0 siker · 1 hiányzó beállítás · 2 feltöltés bukott ·
#                 3 az ellenőrzés bukott

set -eu

# `--check`: a beállítás próbája feltöltés nélkül. Ez az a parancs, amivel egy
# frissen felvett kulcsot ellenőrizni lehet, mielőtt hajnali háromig kiderülne,
# hogy elgépelt.
CHECK=0
[ "${1:-}" = "--check" ] && { CHECK=1; shift; }

DUMP="${1:-}"
PREFIX="${R2_PREFIX:-yume}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

log () { echo "[r2 $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
fail () { log "HIBA: $1"; exit "${2:-1}"; }

if [ "$CHECK" -eq 0 ]; then
  [ -n "$DUMP" ] || fail "nem kaptam fájlt (a hívó a dump útvonalát adja \$1-ként)"
  [ -f "$DUMP" ] || fail "a fájl nem létezik: $DUMP"
fi

# A hiányzó beállítást NÉVEN nevezzük. Egy „nem sikerült feltölteni" üzenet
# hajnali háromkor semmit nem mond arról, mit kell pótolni.
for v in R2_BUCKET R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  eval "value=\${$v:-}"
  [ -n "$value" ] || fail "a $v nincs beállítva — lásd .env.example"
done

# A távoli oldal konfigurációja kizárólag környezeti változókból. Az rclone
# ezeket `R2` nevű távoliként látja, konfigurációs fájl nélkül — így a
# hozzáférési kulcs nem kerül lemezre a konténerben.
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ENV_AUTH=false
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT"
export RCLONE_CONFIG_R2_REGION=auto
export RCLONE_CONFIG_R2_ACL=private
# Az R2 nem támogatja a vödör-létrehozást ugyanúgy, mint az S3, és az rclone
# ellenőrzése fölösleges hívás minden feltöltésnél.
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

REMOTE="R2:${R2_BUCKET}/${PREFIX}"

if [ "$CHECK" -eq 1 ]; then
  log "beállítás próbája: ${R2_BUCKET}/${PREFIX} a(z) ${R2_ENDPOINT} végponton"
  if ! rclone lsjson "$REMOTE" --s3-no-check-bucket >/dev/null 2>/tmp/r2check.err; then
    log "a vödör nem olvasható:"
    sed 's/^/    /' /tmp/r2check.err | tail -4
    fail "az olvasás nem sikerült — ellenőrizd a vödör nevét, a végpontot és a kulcsot" 2
  fi
  # Az olvasás kevés: a mentéshez ÍRNI kell. Egy apró próbaobjektum megírása és
  # törlése az egyetlen módja megtudni, hogy a token tényleg írhat is.
  PROBE="/tmp/.yume-r2-proba"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$PROBE"
  if ! rclone copyto "$PROBE" "${REMOTE}/.write-probe" --s3-no-check-bucket >/dev/null 2>/tmp/r2check.err; then
    log "a vödör nem írható:"
    sed 's/^/    /' /tmp/r2check.err | tail -4
    fail "az írás nem sikerült — a tokennek Object Read & Write jog kell" 3
  fi
  rclone delete "${REMOTE}/.write-probe" --s3-no-check-bucket >/dev/null 2>&1 || true
  COUNT="$(rclone size "$REMOTE" --json --s3-no-check-bucket 2>/dev/null \
    | sed -n 's/.*"count":[[:space:]]*\([0-9]*\).*/\1/p')"
  log "rendben — olvasható és írható, jelenleg ${COUNT:-0} objektum"
  exit 0
fi

NAME="$(basename "$DUMP")"
LOCAL_SIZE="$(stat -c %s "$DUMP")"

log "feltöltés: $NAME ($LOCAL_SIZE bájt) → ${R2_BUCKET}/${PREFIX}/"
if ! rclone copyto "$DUMP" "${REMOTE}/${NAME}" --s3-no-check-bucket --stats-one-line --stats 30s; then
  fail "a feltöltés nem sikerült" 2
fi

# ELLENŐRZÉS. Egy „siker" a feltöltő parancstól nem bizonyíték arról, hogy a
# fájl ott van és ép. A méret egyezése olcsó és elég: egy félbeszakadt
# feltöltés rövidebb objektumot hagy.
REMOTE_SIZE="$(rclone size "${REMOTE}/${NAME}" --json --s3-no-check-bucket 2>/dev/null \
  | sed -n 's/.*"bytes":[[:space:]]*\([0-9]*\).*/\1/p')"
if [ "${REMOTE_SIZE:-0}" != "$LOCAL_SIZE" ]; then
  fail "a távoli méret nem egyezik (helyi $LOCAL_SIZE, távoli ${REMOTE_SIZE:-0})" 3
fi
log "megérkezett és a mérete egyezik"

# TÁVOLI MEGŐRZÉS. Ugyanaz az ablak, mint helyben: enélkül az R2 örökké nőne,
# és egy tárhelyszámla az a fajta meglepetés, amit senki nem keres.
DELETED="$(rclone delete "$REMOTE" --min-age "${KEEP_DAYS}d" --include 'yume-*.dump' \
  --s3-no-check-bucket --dry-run 2>&1 | grep -c 'Skipped delete' || true)"
if [ "${DELETED:-0}" -gt 0 ]; then
  rclone delete "$REMOTE" --min-age "${KEEP_DAYS}d" --include 'yume-*.dump' --s3-no-check-bucket
  log "$DELETED lejárt másolat törölve (${KEEP_DAYS} napnál régebbi)"
fi

TOTAL="$(rclone size "$REMOTE" --json --s3-no-check-bucket 2>/dev/null \
  | sed -n 's/.*"count":[[:space:]]*\([0-9]*\).*/\1/p')"
log "kész — ${TOTAL:-?} másolat az R2-ben"
