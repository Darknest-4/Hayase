#!/bin/sh
# A weboldal KÓDJÁNAK mentése a gépen kívülre — az adatbázis mellé.
#
# MIÉRT LÉTEZIK
# -------------
# A napi mentés eddig csak az adatbázist vitte ki a gépről. A kód nagy része a
# GitHubon is megvan, de nem minden, ami a weboldalt adja:
#
#   * a gépre szabott `docker-compose.override.yml` (a hálózat, a kikapcsolt
#     szolgáltatások) szándékosan nincs a gitben;
#   * az `apps/web/assets/videos/` videói szándékosan nincsenek a gitben — a
#     gazdagépen élnek, és csatolva jutnak a konténerbe;
#   * a még nem commitolt változások sehol máshol nincsenek meg;
#   * és a GitHub egyetlen fiók: ha az elvész, vele megy a teljes előzmény.
#
# Egy lemezhiba után az adatbázis visszaállítható volt — a weboldal nem.
#
# MIT MENT
# --------
#   yume-code-<időbélyeg>.bundle   a teljes git-előzmény: minden ág, címke és
#                                  távoli ág (`git bundle create --all`).
#                                  Visszaállítás: `git clone <fájl> yume`
#   yume-code-<időbélyeg>.tar.gz   a weboldal úgy, ahogy a lemezen áll — a nem
#                                  commitolt változásokkal, az override-dal és
#                                  a videókkal együtt
#
# MIT NEM
# -------
#   .git            — azt a bundle viszi, teljesen
#   node_modules    — a package-lock.json-ból pontosan újraépül
#   .env, .env.*    — TITKOK (a .env.example és a .env.test marad). A titkok
#                     helye egy jelszókezelő, nem egy mentés, amihez egyetlen
#                     R2-kulcs elég. Az archívumot a szkript utólag is
#                     átnézi, és ha mégis titokfájl került bele, nem tölti fel.
#   *.dump          — adatbázis-mentés, annak saját útja van (backup.sh)
#
# CSAK VÁLTOZÁSKOR. A git-előzmény több száz MB, és a kód hetekig is állhat.
# Mindkét fájlnak ujjlenyomata van (a bundle-nek a refek, az archívumnak a
# fájlok tartalma), és új példány csak akkor készül, ha az ujjlenyomat eltér a
# legutóbb SIKERESEN feltöltöttétől. Egy elbukott feltöltés ezért a következő
# futáskor újra próbálkozik.
#
# MEGŐRZÉS DARABSZÁM SZERINT, NEM KOR SZERINT. Az adatbázis-mentések 14 nap
# után törlődnek; a kódé nem törlődhet így, mert egy hónapig változatlan kódnak
# egyetlen példánya van, és azt egy kor szerinti szabály törölné. Fájltípusonként
# a legutóbbi BACKUP_CODE_KEEP változat marad.
#
# Környezet:
#   BACKUP_CODE_DIR    a repó gyökere (a konténerben /src, csak olvasható)
#   BACKUP_DIR         munkakönyvtár és az állapotfájl helye (alap: /backups)
#   BACKUP_CODE_KEEP   hány változat maradjon fájltípusonként (alap: 5)
#   BACKUP_CODE_FORCE  1 = akkor is új példány, ha semmi nem változott
#   R2_CODE_PREFIX     az útvonal a vödörben (alap: <R2_PREFIX>-code → yume-code)
#   BACKUP_SYNC_CMD    ugyanaz a horog, ami a dumpot viszi; a fájl az $1
#
# Kilépési kódok: 0 siker vagy nincs változás · 1 beállítás · 2 a csomagolás
#                 vagy az ellenőrzés bukott · 3 a feltöltés bukott

set -eu

SRC="${BACKUP_CODE_DIR:-}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP="${BACKUP_CODE_KEEP:-5}"
FORCE="${BACKUP_CODE_FORCE:-0}"
CODE_PREFIX="${R2_CODE_PREFIX:-${R2_PREFIX:-yume}-code}"
STATE="$BACKUP_DIR/.code-state"
WORK="$BACKUP_DIR/.code-work"

log () { echo "[code $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
fail () { log "HIBA: $1"; rm -rf "$WORK"; exit "${2:-1}"; }

[ -n "$SRC" ] || fail "a BACKUP_CODE_DIR nincs beállítva" 1
[ -e "$SRC/.git" ] || fail "nem git-repó: $SRC" 1
command -v git >/dev/null 2>&1 || fail "a git nincs telepítve (lásd infrastructure/backup/Dockerfile)" 1
# A busybox tar nem dolgozik fájllistából megbízhatóan; a GNU tar igen.
tar --version 2>/dev/null | grep -q 'GNU tar' || fail "GNU tar kell (a busybox tar nem elég)" 1
case "$KEEP" in ''|*[!0-9]*|0) fail "a BACKUP_CODE_KEEP pozitív egész legyen, nem: $KEEP" 1 ;; esac

# A repó csak olvasható csatolással érkezik, és a gazdagép felhasználójáé. A
# git 2.35.2 óta nem dolgozik más tulajdonában lévő repóban („dubious
# ownership"); itt csak olvasunk belőle, tehát ez a védelem nem nekünk szól.
g () { git -c safe.directory='*' -C "$SRC" "$@"; }

rm -rf "$WORK"
mkdir -p "$WORK"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

# ------------------------------------------------------------- fájllista
# Minden, ami a lemezen van, a fenti kivételekkel. Kizáró lista, nem befogadó:
# egy új, a gitből szándékosan kihagyott fájl (mint a videók) így magától
# bekerül, ahelyett hogy csendben kimaradna.
( cd "$SRC" && find . \( -name .git -o -name node_modules \) -prune -o \
    \( -type f -o -type l \) \
    ! \( -name .env -o \( -name '.env.*' ! -name .env.example ! -name .env.test \) \) \
    ! -name '*.dump' ! -name '*.partial' \
    -print ) | LC_ALL=C sort > "$WORK/files"
FILES=$(wc -l < "$WORK/files" | tr -d ' ')
[ "$FILES" -gt 0 ] || fail "a fájllista üres — rossz a BACKUP_CODE_DIR?" 1

# ----------------------------------------------------------- ujjlenyomatok
REFS_FP=$(g for-each-ref --format='%(objectname) %(refname)' | LC_ALL=C sort | sha256sum | cut -c1-64)
TREE_FP=$(cd "$SRC" && tr '\n' '\0' < "$WORK/files" | xargs -0 sha256sum | sha256sum | cut -c1-64)

last () { [ -f "$STATE" ] && sed -n "s/^$1 //p" "$STATE" | head -1 || true; }
NEED_BUNDLE=1
NEED_TREE=1
if [ "$FORCE" != "1" ]; then
  [ "$REFS_FP" = "$(last refs)" ] && NEED_BUNDLE=0
  [ "$TREE_FP" = "$(last tree)" ] && NEED_TREE=0
fi
if [ "$NEED_BUNDLE" = 0 ] && [ "$NEED_TREE" = 0 ]; then
  log "a kód nem változott a legutóbbi feltöltés óta — nincs új példány"
  rm -rf "$WORK"
  exit 0
fi

# ------------------------------------------------------------------ bundle
BUNDLE="$WORK/yume-code-$STAMP.bundle"
if [ "$NEED_BUNDLE" = 1 ]; then
  log "git-előzmény csomagolása ($(g for-each-ref --format=x | wc -l | tr -d ' ') ref)"
  g bundle create "$BUNDLE" --all 2>"$WORK/err" || fail "git bundle: $(tail -2 "$WORK/err")" 2
  # A `bundle verify` csak a fejlécet és az előfeltételeket nézi. Egy klón a
  # teljes csomagot végigolvassa és indexeli — ez az, ami egy visszaállításkor
  # is történne. Ugyanaz az elv, mint az adatbázisnál: amit nem állítottunk
  # vissza, az csak remény.
  git clone --quiet --bare "$BUNDLE" "$WORK/verify.git" 2>"$WORK/err" \
    || fail "a bundle nem klónozható vissza: $(tail -2 "$WORK/err")" 2
  WANT=$(g bundle list-heads "$BUNDLE" | wc -l | tr -d ' ')
  GOT=$(git -C "$WORK/verify.git" for-each-ref --format=x | wc -l | tr -d ' ')
  rm -rf "$WORK/verify.git"
  [ "$GOT" -gt 0 ] || fail "a visszaklónozott előzményben nincs egyetlen ref sem" 2
  log "bundle: $(wc -c < "$BUNDLE" | tr -d ' ') bájt, visszaklónozva ($WANT fej a csomagban, $GOT ref a klónban)"
fi

# ---------------------------------------------------------------- archívum
TREE="$WORK/yume-code-$STAMP.tar.gz"
if [ "$NEED_TREE" = 1 ]; then
  log "a lemezen álló kód csomagolása ($FILES fájl)"
  tar --create --gzip --file "$TREE" --directory "$SRC" --no-recursion --files-from "$WORK/files" 2>"$WORK/err" \
    || fail "tar: $(tail -2 "$WORK/err")" 2
  # Visszaolvasás: a gzip-ellenőrzőösszeg a listázáskor fut le. A lista minden
  # sorának benne kell lennie — egy közben törölt vagy olvashatatlan fájl itt
  # derül ki, nem visszaállításkor.
  tar --list --gzip --file "$TREE" > "$WORK/listing" 2>"$WORK/err" || fail "az archívum nem olvasható vissza" 2
  [ "$(wc -l < "$WORK/listing" | tr -d ' ')" = "$FILES" ] \
    || fail "az archívum fájlszáma ($(wc -l < "$WORK/listing" | tr -d ' ')) eltér a listáétól ($FILES)" 2
  # Második védvonal a titkok ellen: nem a lista szabályában bízunk, hanem
  # megnézzük, mi van TÉNYLEG az archívumban.
  if grep -E '(^|/)\.env(\.[^/]*)?$' "$WORK/listing" | grep -vqE '(^|/)\.env\.(example|test)$'; then
    fail "titokfájl került az archívumba — nem töltöm fel" 2
  fi
  log "archívum: $(wc -c < "$TREE" | tr -d ' ') bájt, visszaolvasva"
fi

# -------------------------------------------------------------- feltöltés
# Az állapot részenként íródik, mindig a SIKERES feltöltés után: ha a bundle
# kiment, de az archívum elbukott, a következő futás csak az archívumot
# próbálja újra, nem tölti fel még egyszer a több száz MB-os előzményt.
save () {
  { grep -v "^$1 " "$STATE" 2>/dev/null || true; echo "$1 $2"; } > "$STATE.new"
  mv "$STATE.new" "$STATE"
}

if [ -z "${BACKUP_SYNC_CMD:-}" ]; then
  # Nincs hová kivinni. A kód helyi másolata szinte értéktelen — a forrás
  # ugyanazon a lemezen van —, de jobb, mint a semmi, ha a lemez ép, csak a
  # repó sérült. Itt is darabszám szerinti megőrzés.
  log "FIGYELEM: a BACKUP_SYNC_CMD nincs beállítva — a kód csak ezen a gépen marad"
  for f in "$BUNDLE" "$TREE"; do [ -f "$f" ] && mv "$f" "$BACKUP_DIR/"; done
  for pattern in 'yume-code-*.bundle' 'yume-code-*.tar.gz'; do
    find "$BACKUP_DIR" -maxdepth 1 -name "$pattern" -type f | LC_ALL=C sort \
      | awk -v keep="$KEEP" '{ a[NR] = $0 } END { for (i = 1; i <= NR - keep; i++) print a[i] }' \
      | while read -r old; do rm -f "$old"; done
  done
  [ "$NEED_BUNDLE" = 1 ] && save refs "$REFS_FP"
  [ "$NEED_TREE" = 1 ] && save tree "$TREE_FP"
  rm -rf "$WORK"
  exit 0
fi

# Ugyanaz a horog, ami a dumpot viszi; a kód saját útvonalra és darabszám
# szerinti megőrzéssel megy (a sync-r2.sh ezt a két változóból tudja).
upload () {
  R2_PREFIX="$CODE_PREFIX" R2_KEEP_LAST="$KEEP" R2_KEEP_INCLUDE="$2" sh -c "$BACKUP_SYNC_CMD" -- "$1"
}
if [ "$NEED_BUNDLE" = 1 ]; then
  upload "$BUNDLE" 'yume-code-*.bundle' || fail "a bundle feltöltése nem sikerült — a következő futás újra próbálja" 3
  save refs "$REFS_FP"
fi
if [ "$NEED_TREE" = 1 ]; then
  upload "$TREE" 'yume-code-*.tar.gz' || fail "az archívum feltöltése nem sikerült — a következő futás újra próbálja" 3
  save tree "$TREE_FP"
fi

rm -rf "$WORK"
log "kész — a kód a gépen kívül is megvan (${CODE_PREFIX}/)"
