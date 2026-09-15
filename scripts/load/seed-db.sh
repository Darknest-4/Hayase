#!/usr/bin/env bash
# A mérőverem adatbázisának feltöltése az éles legfrissebb ELLENŐRZÖTT mentéséből.
#
# Miért a mentésből, és nem egy friss vetésből: egy üres vagy kicsi adatbázison
# mért késleltetés semmit nem mond. A tervező sorrendje, az indexválasztás és a
# gyorsítótár-találati arány mind a tábla méretétől függ, és itt 32 ezer cím,
# 364 ezer epizód és egy harmadmillió haladássor a valóság.
#
# Mellékhatásként ez a mentés-visszaállítás egy próbája is: ha ez nem megy, az
# éles mentés sem ér semmit, és jobb most megtudni.
#
# Használat:  scripts/load/seed-db.sh [fájlnév]
set -euo pipefail
cd "$(dirname "$0")/../.."

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.load.yml)
PASS="$(grep -oP '(?<=^POSTGRES_PASSWORD=).*' .env)"
NET="$(docker network ls --format '{{.Name}}' | grep -E '^yume_default$' | head -1)"
VOL="$(docker volume ls --format '{{.Name}}' | grep -E 'backups$' | head -1)"

if [ -z "$NET" ] || [ -z "$VOL" ]; then
  echo "Nem találom a hálózatot ($NET) vagy a mentések kötetét ($VOL)." >&2
  exit 3
fi

echo "== a mérőverem adatbázisa elindul"
"${COMPOSE[@]}" --profile load up -d load-postgres
"${COMPOSE[@]}" --profile load exec -T load-postgres sh -c 'until pg_isready -U yume -q; do sleep 1; done'

# Melyik mentés? Alapból a legfrissebb, amit a napi futás ellenőrzött is —
# egy nem ellenőrzött mentésből vetni azt jelentené, hogy a mérés adatállománya
# maga is tipp.
FILE="${1:-}"
if [ -z "$FILE" ]; then
  FILE="$(docker compose exec -T postgres psql -U yume -d yume -tAc \
    "SELECT filename FROM backups WHERE verified ORDER BY taken_at DESC LIMIT 1")"
fi
if [ -z "$FILE" ]; then
  echo "Nincs ellenőrzött mentés. Készíts egyet a panelen (Mentések → Mentés most)." >&2
  exit 3
fi
echo "== visszaállítás: $FILE"

docker run --rm \
  --network "$NET" \
  -v "$VOL":/backups:ro \
  -v "$PWD/scripts/database":/db:ro \
  -e DATABASE_URL="postgres://yume:${PASS}@load-postgres:5432/yume" \
  -e BACKUP_DIR=/backups \
  -e FORCE=1 \
  postgres:16-alpine /db/restore.sh "$FILE"

echo "== a mérőverem tartalma"
PGPASSWORD="$PASS" psql -h 127.0.0.1 -p 15433 -U yume -d yume -tAc \
  "SELECT 'anime: '||count(*) FROM anime;
   SELECT 'epizód: '||count(*) FROM episodes;
   SELECT 'fiók: '||count(*) FROM users;" 2>/dev/null || \
  "${COMPOSE[@]}" --profile load exec -T load-postgres psql -U yume -d yume -tAc \
  "SELECT 'anime: '||count(*) FROM anime; SELECT 'epizód: '||count(*) FROM episodes;"
