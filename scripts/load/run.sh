#!/usr/bin/env bash
# Egy terhelésmérés végigfuttatása, fokozatonként.
#
#   scripts/load/run.sh                       10 25 50 100 250 500 750 1000
#   scripts/load/run.sh --stages 50,100,250   csak ezek
#   scripts/load/run.sh --scenario websocket  másik forgatókönyv
#   scripts/load/run.sh --duration 5m
#
# Minden fokozat KÜLÖN futás. Egy hosszú, folyamatosan növekvő felfutásból nem
# derül ki, melyik szinten fordult meg valami: a percentilisek a teljes futásra
# mosódnak össze, és a 250 VU-s baj a 100 VU-s számokat is elrontja.
#
# A futás megáll az első elbukott fokozatnál, hacsak a --keep-going nem szól
# másképp: az első fokozat, ami nem felel meg a küszöböknek, a válasz. Ami
# utána jön, az már csak azt méri, milyen egy túlterhelt kiszolgáló.
set -euo pipefail
cd "$(dirname "$0")/../.."

STAGES="10,25,50,100,250,500,750,1000"
SCENARIO="main"
DURATION="3m"
RAMP="30s"
KEEP_GOING=0
BASE_URL="${LOAD_BASE_URL:-http://127.0.0.1:4100}"

while [ $# -gt 0 ]; do
  case "$1" in
    --stages) STAGES="$2"; shift 2 ;;
    --scenario) SCENARIO="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --ramp) RAMP="$2"; shift 2 ;;
    --base) BASE_URL="$2"; shift 2 ;;
    --keep-going) KEEP_GOING=1; shift ;;
    *) echo "ismeretlen kapcsoló: $1" >&2; exit 2 ;;
  esac
done

KEY="$(grep -oP '(?<=^LOAD_TEST_KEY=).*' .env || true)"
if [ -z "$KEY" ]; then
  echo "Nincs LOAD_TEST_KEY a .env-ben. Enélkül a mérés a sebességkorlátot mérné." >&2
  echo "  echo \"LOAD_TEST_KEY=\$(openssl rand -base64 32)\" >> .env" >&2
  exit 3
fi

# ---- előfeltételek ----------------------------------------------------------
# Mindegyik olyasmi, aminek a hiánya csendben rossz mérést adna, nem hibát.

if [ ! -s tests/load/data/dataset.json ]; then
  echo "Nincs adatállomány. Futtasd: node scripts/load/seed-users.mjs" >&2
  exit 3
fi

echo "== a mérőverem ellenőrzése: $BASE_URL"
if ! curl -fsS -m 5 "$BASE_URL/v1/health" >/dev/null; then
  echo "A mérőverem nem válaszol. Indítsd el:" >&2
  echo "  docker compose -f docker-compose.yml -f docker-compose.load.yml --profile load up -d --build" >&2
  exit 3
fi

# A kivétel tényleg él-e? Ha nem, a mérés 300 kérés/perc után a korlátot méri,
# és a jelentés tele lesz 429-cel — de csak a végén derülne ki.
#
# A jelzés pontos, nem közvetett: a korlátozó az `allowList`-en megálló kérésre
# nem ír `x-ratelimit-*` fejlécet. Ha a fejléc ott van a kulccsal is, akkor a
# kivétel NEM él — a kulcs rossz, vagy a forráscím nincs a listán.
with_key="$(curl -sD- -o /dev/null -m 5 -H "x-yume-load-test: $KEY" "$BASE_URL/v1/config" | grep -ci '^x-ratelimit-limit' || true)"
without_key="$(curl -sD- -o /dev/null -m 5 "$BASE_URL/v1/config" | grep -ci '^x-ratelimit-limit' || true)"
if [ "$without_key" != "1" ]; then
  echo "A sebességkorlát nem is aktív ezen a példányon — enélkül a mérésnek nincs mihez képest kivételt adni." >&2
  exit 3
fi
if [ "$with_key" != "0" ]; then
  echo "A mérőkulcs nem ad mentességet: a válasz még mindig hoz x-ratelimit fejlécet." >&2
  echo "Nézd meg a load-app naplójában a LOAD_TEST_IPS listát, és hogy melyik címről érkezik a kérés." >&2
  exit 3
fi
echo "   a sebességkorlát alóli kivétel él"

ID="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="docs/analytics/load-reports/$ID"
mkdir -p "$OUT"

BUILD="$(git rev-parse --short HEAD)$(git diff --quiet || echo '-dirty')"
echo "== mérés $ID · build $BUILD · forgatókönyv $SCENARIO · fokozatok $STAGES"

cat > "$OUT/run.json" <<JSON
{
  "id": "$ID",
  "scenario": "$SCENARIO",
  "build": "$BUILD",
  "base": "$BASE_URL",
  "duration": "$DURATION",
  "ramp": "$RAMP",
  "stages": "$STAGES",
  "startedAt": "$(date -u +%FT%TZ)",
  "host": "$(uname -sr)",
  "cores": $(nproc),
  "memTotalMb": $(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
}
JSON

FAILED_AT=""
IFS=',' read -ra LEVELS <<< "$STAGES"
for VUS in "${LEVELS[@]}"; do
  echo
  echo "──────── $VUS VU ────────"
  SAMPLES="$OUT/stage-$VUS.samples.ndjson"
  SUMMARY="$OUT/stage-$VUS.summary.json"

  POSTGRES_PASSWORD="$(grep -oP '(?<=^POSTGRES_PASSWORD=).*' .env)" \
  node --experimental-strip-types scripts/load/sample.mjs --out "$SAMPLES" --every 5 &
  SAMPLER=$!
  # Egy minta a terhelés előtt: enélkül nincs mihez hasonlítani a csúcsot.
  sleep 6

  set +e
  SUMMARY_OUT="$SUMMARY" k6 run "tests/load/$SCENARIO.js" \
    -e "VUS=$VUS" -e "DURATION=$DURATION" -e "RAMP=$RAMP" \
    -e "BASE_URL=$BASE_URL" -e "LOAD_TEST_KEY=$KEY" \
    --no-usage-report
  K6_CODE=$?
  set -e

  kill "$SAMPLER" 2>/dev/null || true
  wait "$SAMPLER" 2>/dev/null || true

  if [ $K6_CODE -ne 0 ]; then
    echo "!! $VUS VU: küszöb elbukott (k6 kilépési kód $K6_CODE)"
    [ -z "$FAILED_AT" ] && FAILED_AT="$VUS"
    [ $KEEP_GOING -eq 0 ] && break
  else
    echo "ok $VUS VU"
  fi

  # Két fokozat között pihen a gép: a Postgres gyorsítótára és a kapcsolatok
  # visszaállnak, különben a következő fokozat az előző maradékát is méri.
  sleep 20
done

echo
echo "== jelentés"
node scripts/load/report.mjs --dir "$OUT" ${FAILED_AT:+--failed-at "$FAILED_AT"}
echo "== $OUT/REPORT.md"
