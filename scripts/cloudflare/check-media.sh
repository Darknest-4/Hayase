#!/usr/bin/env bash
# Tényleg kiszolgálja-e a beállított képforrás a képeinket?
#
# MIÉRT KELL EZ
# -------------
# A `MEDIA_BASE_URL` átállítása egyetlen sor, és ha a cím még nem él, a
# következmény az oldal MINDEN képe. Semmi nem hibázik: az API helyes választ
# ad, a lap felépül, csak minden kép törött — és a naplóban egy sor sincs
# róla, mert a hiba a LÁTOGATÓ böngészőjében történik, nem nálunk.
#
# Ez a szkript ezt kérdezi meg ELŐRE, valódi kulcsokkal az adatbázisból.
#
#   scripts/cloudflare/check-media.sh                      a mostani beállítást
#   scripts/cloudflare/check-media.sh https://media.animehub.hu   egy tervezettet
set -euo pipefail
cd "$(dirname "$0")/../.."

# A sorrend: parancssori argumentum → héj környezete → .env. A `.env` azért
# kell, mert a beállítás OTT él, és a szkriptet a héjból hívjuk — enélkül a
# szkript a saját útvonalat ellenőrizné, miközben élesben már a saját domain
# megy, és pont a különbséget nem venné észre.
BASE="${1:-${MEDIA_BASE_URL:-}}"
if [ -z "$BASE" ] && [ -f .env ]; then
  BASE="$(grep -oP '^MEDIA_BASE_URL=\K.*' .env 2>/dev/null || true)"
fi
if [ -z "$BASE" ]; then
  # Beállítás nélkül a saját útvonalunk megy, és azt a saját címünkön nézzük.
  BASE="$(grep -oP '^PUBLIC_URL=\K.*' .env 2>/dev/null || echo 'http://127.0.0.1:4000')/media"
  echo "nincs MEDIA_BASE_URL — a saját útvonalat ellenőrzöm: $BASE"
fi
BASE="${BASE%/}"

# Valódi kulcsok, nem kitalált: egy kitalált kulcs 404-et adna akkor is, ha
# minden rendben van, és a szkript hamis riasztást tenne.
KEYS="$(docker compose exec -T postgres psql -U yume -d yume -tAc \
  "SELECT mirror_key FROM anime_images WHERE mirror_key IS NOT NULL ORDER BY random() LIMIT 5" 2>/dev/null | tr -d '\r' | grep -v '^$' || true)"

if [ -z "$KEYS" ]; then
  echo "nincs letükrözött kép az adatbázisban — nincs mit ellenőrizni" >&2
  exit 2
fi

OK=0
BAD=0
while read -r KEY; do
  [ -z "$KEY" ] && continue
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/$KEY" || echo 000)"
  if [ "$CODE" = "200" ]; then
    OK=$((OK + 1))
  else
    BAD=$((BAD + 1))
    echo "  HIBA $CODE — $BASE/$KEY"
  fi
done <<< "$KEYS"

echo "$OK rendben, $BAD hibás — $BASE"
if [ "$BAD" -gt 0 ]; then
  echo
  echo "NE állítsd át a MEDIA_BASE_URL-t erre a címre: az oldal minden képe törött lenne." >&2
  exit 1
fi
