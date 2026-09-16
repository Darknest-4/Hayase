#!/usr/bin/env bash
# A TRUST_PROXY értéke a Cloudflare AKTUÁLIS tartományaiból.
#
# MIÉRT SZKRIPT, ÉS NEM EGY BEÍRT LISTA
# -------------------------------------
# A Cloudflare időnként bővíti a tartományait. Egy kézzel bemásolt lista
# elavul, és az elavulás NÉMA: az új tartományból érkező látogatók a Cloudflare
# él-címeként jelennek meg, egyetlen sebességkorlát-vödörbe kerülnek, és
# semmi nem hibázik tőle. Ezért a lista mindig a forrásból jön.
#
# A DOCKER-HÁLÓZAT IS KELL. A lánc `látogató → Cloudflare → Caddy → app`: a
# közvetlen peer a Caddy a compose-hálózaton, és a bizalom nála kezdődik.
#
#   scripts/cloudflare/trust-proxy.sh            kiírja az értéket
#   scripts/cloudflare/trust-proxy.sh --write    beírja a .env-be
#
# Az `--write` után `docker compose up -d app worker` kell, hogy hasson.
set -euo pipefail
cd "$(dirname "$0")/../.."

DOCKER_NET="${DOCKER_NET:-172.16.0.0/12}"

fetch () {
  curl -fsS --max-time 20 "$1" | tr -d '\r' | grep -v '^$'
}

V4="$(fetch https://www.cloudflare.com/ips-v4)" || { echo "nem sikerült lekérni az IPv4-listát" >&2; exit 1; }
V6="$(fetch https://www.cloudflare.com/ips-v6)" || { echo "nem sikerült lekérni az IPv6-listát" >&2; exit 1; }

# Épeszűségi ellenőrzés: ha a Cloudflare oldala egyszer HTML-t ad vissza egy
# lista helyett, azt vegyük észre most, ne egy hibás bizalmi listából.
COUNT="$(printf '%s\n%s\n' "$V4" "$V6" | wc -l | tr -d ' ')"
if [ "$COUNT" -lt 15 ] || printf '%s' "$V4" | grep -qi '<'; then
  echo "a letöltött lista nem úgy néz ki, mint IP-tartományok ($COUNT sor) — nem írok semmit" >&2
  exit 2
fi

VALUE="$(printf '%s\n%s\n%s\n' "$DOCKER_NET" "$V4" "$V6" | paste -sd, -)"

if [ "${1:-}" = "--write" ]; then
  [ -f .env ] || { echo "nincs .env" >&2; exit 1; }
  if grep -q '^TRUST_PROXY=' .env; then
    # A régi értéket megőrizzük kommentben: ha valami elromlik, legyen mihez
    # visszatérni anélkül, hogy emlékezni kelljen rá.
    OLD="$(grep '^TRUST_PROXY=' .env | head -1)"
    sed -i "s|^TRUST_PROXY=.*|# előző érték, $(date -u +%Y-%m-%d): ${OLD}\nTRUST_PROXY=${VALUE}|" .env
  else
    printf '\nTRUST_PROXY=%s\n' "$VALUE" >> .env
  fi
  echo "a .env frissítve — $COUNT Cloudflare-tartomány + $DOCKER_NET"
  echo "hatályba lépéshez: docker compose up -d app worker"
else
  echo "TRUST_PROXY=$VALUE"
fi
