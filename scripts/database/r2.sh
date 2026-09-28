#!/bin/sh
# rclone a mentések R2-vödrére, a mentőkonténer környezetéből beállítva.
#
# MIÉRT LÉTEZIK: a konténerben egy puszta `rclone` nem ismeri az `R2:` távolit —
# a beállítás csak környezeti változókból jön (r2-env.sh), és eddig csak a
# feltöltés idejére élt. Visszaállításkor, a legrosszabb napon, pont listázni
# és letölteni kell; ez a parancs erre való.
#
#   /db/r2.sh lsl  "R2:$R2_BUCKET/yume"                            adatbázis-mentések
#   /db/r2.sh lsl  "R2:$R2_BUCKET/yume-code"                       kódmentések
#   /db/r2.sh copy "R2:$R2_BUCKET/yume/yume-<dátum>.dump" /backups  egy dump le
#
# A konténeren kívülről:
#   docker compose run --rm --entrypoint sh backup -c '/db/r2.sh lsl "R2:$R2_BUCKET/yume-code"'
set -eu
for v in R2_BUCKET R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  eval "value=\${$v:-}"
  [ -n "$value" ] || { echo "r2.sh: a $v nincs beállítva — lásd .env.example" >&2; exit 1; }
done
. "$(dirname "$0")/r2-env.sh"
exec rclone "$@"
