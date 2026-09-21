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
# A CADDY IS KELL, ÉS EZ NEM MAGÁTÓL ÉRTETŐDŐ
# -------------------------------------------
# A Caddy 2.7 óta ALAPÉRTELMEZÉSBEN NEM hiszi el a beérkező `X-Forwarded-For`
# fejlécet: felülírja a közvetlen peer címével. Ez helyes védelem a hamisítás
# ellen — de a Cloudflare mögött pont a látogató címét dobja el.
#
# Mérve, a lista beírása UTÁN, de a Caddy beállítása ELŐTT:
#
#   request.ip = 141.101.76.109 / 162.158.74.20 / 172.71.95.140
#                └─ mind Cloudflare él-szerver, nem a látogató
#
# Az appnak adott `TRUST_PROXY` önmagában tehát KEVÉS: ha a Caddy már eldobta
# a látogató címét, az app nem tudja visszaszerezni. A két beállítás együtt
# működik, és ugyanabból a listából kell jönnie.
#
#   scripts/cloudflare/trust-proxy.sh                  kiírja az értéket
#   scripts/cloudflare/trust-proxy.sh --write          beírja a .env-be
#   scripts/cloudflare/trust-proxy.sh --caddy <fájl>   beírja a Caddyfile-ba
#   scripts/cloudflare/trust-proxy.sh --matcher        kiírja a Caddy-szűrőt,
#                                                      ami a nem-Cloudflare
#                                                      kapcsolatokat kizárja
#
# Az `--write` után `docker compose up -d app worker`, a `--caddy` után
# `caddy reload` kell, hogy hasson.
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

# ---------------------------------------------------------------------------
# A Caddyfile globális blokkja
# ---------------------------------------------------------------------------
#
# A `trusted_proxies static` mondja meg a Caddynak, kinek az
# `X-Forwarded-For`-ját hiheti el. A Docker-hálózat NEM kell ide: az a Caddy
# és az app közötti szakasz, és arról a Caddy nem is dönt.
if [ "${1:-}" = "--caddy" ]; then
  TARGET="${2:-}"
  [ -n "$TARGET" ] && [ -f "$TARGET" ] || { echo "használat: --caddy <Caddyfile>" >&2; exit 1; }

  LIST="$(printf '%s\n%s\n' "$V4" "$V6" | paste -sd' ' -)"
  BLOCK="$(cat <<EOF
{
	# A CLOUDFLARE CÍMEI — generálva, nem kézzel másolva.
	#
	# A Caddy 2.7 óta alapból NEM hiszi el a beérkező X-Forwarded-For fejlécet,
	# hanem felülírja a közvetlen peer címével. Ez helyes védelem a hamisítás
	# ellen, de a Cloudflare mögött a látogató címét dobja el — és onnantól az
	# app minden látogatót ugyanannak a Cloudflare él-szervernek lát.
	#
	# Frissítés: scripts/cloudflare/trust-proxy.sh --caddy <ez a fájl>
	# Utoljára: $(date -u +%Y-%m-%d)
	servers {
		trusted_proxies static $LIST
	}
}
EOF
)"

  # A régi blokk cseréje, ha van; különben a fájl elejére.
  if grep -q 'trusted_proxies static' "$TARGET"; then
    python3 - "$TARGET" "$BLOCK" <<'PYEOF'
import re, sys
path, block = sys.argv[1], sys.argv[2]
text = open(path, encoding='utf-8').read()
# Az első globális blokk a fájl elején: `{` ... `}` az első oszlopban.
pattern = re.compile(r'\A\{\n.*?\n\}\n', re.S)
if pattern.search(text):
    text = pattern.sub(block + '\n', text, count=1)
else:
    text = block + '\n\n' + text
open(path, 'w', encoding='utf-8').write(text)
PYEOF
  else
    # HELYBEN ÍRUNK, NEM CSERÉLÜNK FÁJLT.
    #
    # A Caddyfile egy FÁJL-szintű Docker-becsatolás. Egy `mv` új inode-ot hoz
    # létre, a becsatolás pedig a RÉGIT tartja — a konténer onnantól egy
    # láthatatlan, elavult példányt olvas, és a `caddy reload` azt mondja:
    # „config is unchanged". Ez pontosan megtörtént: a gazdagépen 108 sor
    # volt, a konténerben 90.
    NEW="$(printf '%s\n\n%s' "$BLOCK" "$(cat "$TARGET")")"
    printf '%s' "$NEW" > "$TARGET"
  fi
  echo "a Caddyfile frissítve — $COUNT Cloudflare-tartomány"
  echo "hatályba lépéshez: docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile"
  exit 0
fi

# ---------------------------------------------------------------------------
# A szűrő, ami kizárja a Cloudflare megkerülését
# ---------------------------------------------------------------------------
#
# A Caddy `remote_ip` matcherébe való. A DOCKER-HÁLÓZAT IS BENNE VAN: a
# `docker-proxy` a saját címére fordítja a beérkező kapcsolatot, és a
# konténerek közti hívások (egészségjelző, bot) is onnan jönnek.
if [ "${1:-}" = "--matcher" ]; then
  printf 'remote_ip %s %s\n' "$DOCKER_NET" "$(printf '%s\n%s\n' "$V4" "$V6" | paste -sd' ' -)"
  exit 0
fi

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
