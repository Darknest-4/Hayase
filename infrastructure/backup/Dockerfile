# A mentőkonténer: pg_dump + egy eszköz, ami ki tudja vinni a gépről.
#
# MIÉRT SAJÁT KÉPFÁJL: a `postgres:16-alpine`-ban nincs sem `curl`, sem
# `openssl` — csak busybox. Egy mentés, ami nem hagyja el a gépet, egy
# lemezhibát nem él túl, és az auditban ez volt a második legfontosabb nyitott
# kockázat. A `pg_dump`-nak viszont pontosan egyeznie kell a kiszolgáló
# verziójával, ezért a kiindulás marad a hivatalos Postgres-kép.
#
# MIÉRT RCLONE, és nem kézzel írt S3-aláírás: a Cloudflare az R2-höz hivatalosan
# az rclone-t dokumentálja; a feltöltést, a méret-ellenőrzést és a távoli
# megőrzést egy-egy parancs elintézi. A `curl --aws-sigv4` alternatíva volt, de
# a törléshez S3-as XML-listát kellett volna elemezni héjszkriptben — az a fajta
# kód, ami csendben hibázik.
#
# A konfiguráció KÖRNYEZETI VÁLTOZÓKBÓL jön (`RCLONE_CONFIG_R2_*`), nem fájlból:
# így a hozzáférési kulcs nem kerül lemezre a konténerben.
FROM postgres:16-alpine

# A `git` és a GNU `tar` a KÓDMENTÉSHEZ kell (scripts/database/backup-code.sh):
# a git-előzményt `git bundle` viszi, a lemezen álló kódot egy fájllistából
# készülő archívum — a busybox tar ezt nem tudja megbízhatóan.
RUN apk add --no-cache rclone git tar

# A szkriptek csatolva érkeznek (lásd docker-compose.yml), nem beépítve —
# így egy javításukhoz nem kell képet építeni.
