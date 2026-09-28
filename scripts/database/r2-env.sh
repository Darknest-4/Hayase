# Az `R2:` távoli beállítása az rclone-nak — KIZÁRÓLAG környezeti változókból.
#
# Forrásként töltődik be (`. r2-env.sh`), nem futtatva: a sync-r2.sh és az r2.sh
# is ezt használja, hogy a feltöltés és a letöltés ugyanazt a távolit lássa.
# Konfigurációs fájl nincs, így a hozzáférési kulcs nem kerül lemezre a
# konténerben. A hívó felel azért, hogy az R2_* változók be legyenek állítva.
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ENV_AUTH=false
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT"
export RCLONE_CONFIG_R2_REGION=auto
export RCLONE_CONFIG_R2_ACL=private
# Az R2 nem támogatja a vödör-létrehozást ugyanúgy, mint az S3, és az rclone
# ellenőrzése fölösleges hívás minden műveletnél.
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
# A „nincs konfigurációs fájl" figyelmeztetés minden hívásnál zaj: itt szándékos.
export RCLONE_CONFIG=/dev/null
