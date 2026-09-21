#!/bin/sh
# A YUME reverse-proxy blokkjának behelyezése egy MEGOSZTOTT Caddyfile-ba.
#
# MIÉRT VAN ERRE SZÜKSÉG. Ezen a gépen egyetlen Caddy szolgál ki három oldalt,
# és az ő konfigurációja a YUME repón kívül él. A YUME-ra vonatkozó rész
# viszont a repóé — `infrastructure/reverse-proxy/yume.caddy` —, különben egy
# tiszta gépre telepítés nem adja vissza a működést, és senki nem tudja
# megmondani, mi miért van úgy.
#
# HELYBEN ÍR, SOSEM `mv`-VEL. Egy `mv` új inode-ot hoz létre; a Caddy
# konténerbe a fájl FÁJLSZINTŰ bind mounttal van becsatolva, tehát a régi
# inode-ot tartja meg. Ez megtörtént: a gazdagépen 108 soros fájl állt, a
# konténerben 90 soros, és a `caddy reload` azt mondta, hogy „config is
# unchanged". Azóta minden írás helyben megy.
#
#   scripts/reverse-proxy/install.sh /opt/YonagiFansub/Caddyfile
#   scripts/reverse-proxy/install.sh /opt/YonagiFansub/Caddyfile --dry-run
#
# Utána a Caddyt ÚJRA KELL INDÍTANI (nem elég a reload, ha a fájl inode-ja
# változott volna) — a `docker compose restart caddy` a biztos út.

set -eu

CEL="${1:-}"
SZARAZ="${2:-}"
FORRAS="$(CDPATH='' cd -- "$(dirname -- "$0")/../../infrastructure/reverse-proxy" && pwd)/yume.caddy"

KEZDET="# >>> yume:kezdet — a blokkot a scripts/reverse-proxy/install.sh kezeli"
VEG="# <<< yume:veg"

if [ -z "$CEL" ]; then
  echo "használat: $0 <közös Caddyfile útvonala> [--dry-run]" >&2
  exit 1
fi
[ -f "$CEL" ] || { echo "nincs ilyen fájl: $CEL" >&2; exit 1; }
[ -f "$FORRAS" ] || { echo "nincs forrás: $FORRAS" >&2; exit 1; }

UJ="$(mktemp)"
trap 'rm -f "$UJ"' EXIT

if grep -qF "$KEZDET" "$CEL"; then
  # A jelölők közti rész cseréje. A fájl többi sora — a másik két projekt
  # blokkjai — érintetlen marad.
  awk -v kezdet="$KEZDET" -v veg="$VEG" -v forras="$FORRAS" '
    index($0, kezdet) == 1 { print; while ((getline sor < forras) > 0) print sor; close(forras); benne = 1; next }
    index($0, veg) == 1 { benne = 0 }
    !benne { print }
  ' "$CEL" > "$UJ"
else
  # NINCSENEK JELÖLŐK. Itt nem hozzáfűzünk, mert az DUPLIKÁLNA: a megosztott
  # fájlban a YUME blokkjai már ott állhatnak jelöletlenül, és két azonos
  # nevű site-blokk mellett a Caddy el sem indul.
  #
  # Kipróbálva: az első változat vakon hozzáfűzött, és a száraz futás pont
  # ezt mutatta meg.
  if grep -qE '^(animehub\.hu|yumee\.duckdns\.org)' "$CEL"; then
    cat >&2 <<VEGE
A megosztott fájlban MÁR VANNAK YUME-blokkok, de nincsenek jelölők.

Hozzáfűzni nem lehet: két azonos nevű site-blokktól a Caddy el sem indul.
Tedd körbe EGYSZER, kézzel a meglévő YUME-blokkokat ezzel a két sorral:

  $KEZDET
  ...a YUME blokkjai...
  $VEG

Innentől ez a szkript cseréli a köztes részt. A tartalmat a repó adja:
$FORRAS
VEGE
    exit 1
  fi
  # Tiszta fájl: a blokk a végére kerül, jelölők közé.
  cp "$CEL" "$UJ"
  { echo; echo "$KEZDET"; cat "$FORRAS"; echo "$VEG"; } >> "$UJ"
fi

if [ "$SZARAZ" = "--dry-run" ]; then
  echo "[száraz] a különbség:"
  diff -u "$CEL" "$UJ" || true
  exit 0
fi

# HELYBEN, az inode megtartásával.
cat "$UJ" > "$CEL"
echo "behelyezve: $CEL"
echo "most: docker compose restart caddy   (a projektben, ahol a Caddy fut)"
