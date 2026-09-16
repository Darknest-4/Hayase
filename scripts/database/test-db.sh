#!/usr/bin/env bash
# A tesztadatbázis létrehozása/frissítése.
#
# MIÉRT KELL
# ----------
# A tesztek eddig az ÉLES adatbázison futottak. Nem szándékosan: nincs külön
# adatbázis, a `DATABASE_URL`-t kézzel állítja az ember, és a kézenfekvő érték
# az éles. Az ára három helyen látszott:
#
#   * a 34 fiókból 30 tesztmaradék volt (`adv_…`), és ezek viszik a
#     felhasználószámot, a napi aktív grafikont és a statisztikákat;
#   * a hibanapló 500-asai a tesztfutásokból származtak, percre a futásokra;
#   * két `example.invalid` webhook maradt bent, ami hibacsoportot termelt.
#
# Egy tesztfutás írjon, amennyit akar — csak ne oda, amit a látogatók néznek.
#
# MI LESZ BENNE
# -------------
# Az éles legfrissebb ELLENŐRZÖTT mentése. Nem üres séma: a suite-ok fele
# valódi katalógusadatot kér (nyilvános cím, epizód, jogosultságkatalógus), és
# egy üres adatbázison nem az derülne ki, hogy jók-e, hanem hogy nincs mit
# mérniük.
#
# Mellékhatásként ez is a mentés-visszaállítás próbája: ha ez nem megy, az
# éles mentés sem ér semmit.
#
#   scripts/database/test-db.sh            a legfrissebb ellenőrzött mentésből
#   scripts/database/test-db.sh <fájlnév>  egy megadottból
set -euo pipefail
cd "$(dirname "$0")/../.."

TEST_DB="${TEST_DB:-yume_test}"
PASS="$(grep -oP '(?<=^POSTGRES_PASSWORD=).*' .env)"
NET="$(docker network ls --format '{{.Name}}' | grep -E '^yume_default$' | head -1)"
VOL="$(docker volume ls --format '{{.Name}}' | grep -E 'backups$' | head -1)"

if [ -z "$NET" ] || [ -z "$VOL" ]; then
  echo "Nem találom a hálózatot ($NET) vagy a mentések kötetét ($VOL)." >&2
  exit 3
fi

case "$TEST_DB" in
  *_test) ;;
  *)
    # Nem óvatoskodás: ez a szkript ELDOBJA a céladatbázist.
    echo "A tesztadatbázis nevének _test-re kell végződnie (kapott: $TEST_DB)." >&2
    exit 3 ;;
esac

FILE="${1:-}"
if [ -z "$FILE" ]; then
  FILE="$(docker compose exec -T postgres psql -U yume -d yume -tAc \
    "SELECT filename FROM backups WHERE verified ORDER BY taken_at DESC LIMIT 1")"
fi
if [ -z "$FILE" ]; then
  echo "Nincs ellenőrzött mentés. Készíts egyet a panelen (Mentések → Mentés most)." >&2
  exit 3
fi

echo "== $TEST_DB feltöltése ebből: $FILE"
docker run --rm \
  --network "$NET" \
  -v "$VOL":/backups:ro \
  -v "$PWD/scripts/database":/db:ro \
  -e DATABASE_URL="postgres://yume:${PASS}@postgres:5432/${TEST_DB}" \
  -e BACKUP_DIR=/backups \
  -e FORCE=1 \
  postgres:16-alpine /db/restore.sh "$FILE"

echo
echo "== kész. A tesztek így futnak ellene:"
echo "   export DATABASE_URL='postgres://yume:***@127.0.0.1:15432/${TEST_DB}'"
echo "   npm test --workspace @yume/api"
