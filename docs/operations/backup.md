# Backup & recovery

Yume kept no backups at all until this existed: no dump, no schedule, no
restore procedure. One Docker volume held every account, library and watch
history, and a mistaken `docker compose down -v` would have ended the project.

Two scripts and one container service, all in `db/`.

---

## What is backed up, and what is not

| Data | Where it lives | Covered by |
|---|---|---|
| Accounts, library, catalogue, comments, jobs, metrics | Postgres | `backup.sh` |
| Uploaded images | external CDN URLs today | nothing to back up yet |
| Secrets (`JWT_SECRET`, DB password) | your `.env` | your password manager |

Everything that matters is in the database. That was not always true — the
extension packages were deliberately kept out of it, so a restore brought back
a store listing with no bytes behind it and every install downloaded as `410
Gone`. The extension platform is gone and with it that trap: a database dump is
now a complete restore.

---

## Taking a backup

The `backup` service runs daily at 03:00 UTC by default and starts one on
boot. Nothing to set up — it comes up with the stack.

```bash
docker compose run --rm backup /db/backup.sh      # take one now
docker compose logs backup                        # what happened
```

Each run:

1. `pg_dump --format=custom --compress=6 --no-owner --no-privileges`
2. writes to `NAME.partial`, then renames — **a half-written dump never gets a
   name that looks usable**
3. rejects anything under 4 KB, which is too small to be a real schema
4. **verifies it** (below)
5. prunes dumps older than `BACKUP_KEEP_DAYS`, and only after a good one exists

Custom format is not cosmetic: `pg_restore` can pull a single table out of it,
which is what you want when somebody deletes one thing rather than everything.

## Verification — the part that makes it a backup

> A backup nobody has restored is a guess.

Every run restores the fresh dump into a scratch database, checks the tables
that must never be empty (`schema_migrations`, `permissions`), and drops it
again. A dump that cannot be restored **fails the run with exit code 2** rather
than being filed away and trusted.

Restoring without error is necessary but not sufficient — an empty database
restores perfectly — which is why the row counts are checked too.

```
[backup] dumping to yume-20260822T043208Z.dump
[backup] wrote 373373 bytes
[backup] verifying by restoring into yume_verify
[backup] verified: 17 migrations, 389 permissions, 5 users
[backup] done — 2 backup(s) on hand
```

Skip it with `--no-verify` only when you know why you are doing that.

---

## Restoring

```bash
docker compose run --rm backup /db/restore.sh --list          # what is available
docker compose run --rm backup /db/restore.sh                 # newest
docker compose run --rm backup /db/restore.sh yume-20260822T043208Z.dump
docker compose run --rm backup /db/restore.sh --into yume_copy   # beside the live DB
```

`restore.sh` is written for the worst day, so it is blunt: it prints exactly
what it will destroy and **requires you to type the database name** before it
touches anything. `FORCE=1` skips that — for scripted recovery drills only.

`--into` is the one to reach for first. Restoring beside the live database lets
you confirm the data is what you expect before you overwrite anything.

Exit codes: `0` success · `1` restore failed · `3` misconfigured · `4` cancelled.

---

## Restoring onto a new host

```bash
git clone <repo> && cd Hayase
cp /secure/backup/.env .                       # JWT_SECRET, POSTGRES_PASSWORD
JWT_SECRET=… docker compose up -d postgres
cp /secure/backup/yume-*.dump ./restore/
docker compose run --rm -v "$PWD/restore:/backups" backup /db/restore.sh
docker compose up -d
```

`--no-owner --no-privileges` on both dump and restore is what makes this work
under a different database role than the one the dump came from.

**Keep `JWT_SECRET` with the backups.** Restoring the database with a different
signing key invalidates every session at once — recoverable, but every user is
logged out and confused at the worst moment.

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_DIR` | `/backups` | where dumps land (the `backups` volume) |
| `BACKUP_KEEP_DAYS` | `14` | prune age |
| `BACKUP_AT_HOUR` | `3` | UTC hour of the daily run |
| `BACKUP_ON_START` | `1` | take one when the container starts |
| `BACKUP_VERIFY_DB` | `yume_verify` | scratch database used for verification |
| `FORCE` | unset | `restore.sh` only — skip the typed confirmation |

---

## What this is not

**This is not point-in-time recovery.** A daily dump means up to 24 hours of
loss. That is the right trade for a single VPS — WAL archiving needs somewhere
to stream to and a base backup to replay onto — but know which one you have.
When the data becomes worth more than a day, move to continuous archiving
(`archive_command` to off-host storage) or a managed Postgres with PITR.

**The dumps are on the same machine by default.** A volume on the VPS survives
a bad deploy and a dropped table; it does not survive the VPS. Copy them off:

```bash
rsync -az --delete vps:/var/lib/docker/volumes/hayase_backups/_data/ ~/yume-backups/
```

Until that runs somewhere, one machine failure still ends the project.

---

## Restore drills

The verification step proves a dump is readable. It does not prove **you** can
carry out a restore under pressure. Run the real thing every few months:

```bash
docker compose run --rm backup /db/restore.sh --into yume_drill
docker compose exec postgres psql -U yume yume_drill -c \
  "SELECT count(*) FROM users; SELECT max(applied_at) FROM schema_migrations"
docker compose exec postgres psql -U yume -c "DROP DATABASE yume_drill"
```

Time it. If the answer is "I am not sure", that is the finding.

---

## Off-site copies

`BACKUP_SYNC_CMD` runs after a **verified** backup, receiving the dump path as
`$1`:

```yaml
# docker-compose.yml, backup service
BACKUP_SYNC_CMD: 'rclone copy "$$1" remote:yume-backups'
```

```bash
BACKUP_SYNC_CMD='rsync -az "$1" backup-host:/srv/yume/'
BACKUP_SYNC_CMD='aws s3 cp "$1" s3://my-bucket/yume/'
```

A sync failure is logged loudly but does not fail the run: the local backup is
already verified, and losing tomorrow's copy because today's upload broke would
be the worse outcome. When it is unset, every run says so — a backup on the
same disk as the database survives a bad deploy and a dropped table, but not
the machine.

---

## Cloudflare R2 — a beépített megoldás

A `BACKUP_SYNC_CMD` alapértelmezése ma a mellékelt `scripts/database/sync-r2.sh`,
mert a „másold ki a gépről" az a lépés, amit a legkönnyebb elhalasztani, és
aminek a hiánya a legdrágább. A szkript többet csinál, mint egy `rclone copy`:

* **feltölt**, majd **ellenőrzi**, hogy a távoli méret egyezik a helyivel — egy
  félbeszakadt feltöltés rövidebb objektumot hagy, és a „sikerült" a feltöltő
  parancstól nem bizonyíték;
* a **távoli megőrzés** ugyanazt az ablakot követi, mint a helyi
  (`BACKUP_KEEP_DAYS`), tehát a másolatok nem gyűlnek örökké;
* hiányzó beállításnál **néven nevezi**, melyik változó hiányzik, ahelyett hogy
  csak annyit mondana, „nem sikerült".

A mentőkonténer ehhez saját képet használ (`infrastructure/backup/Dockerfile`):
a hivatalos `postgres:16-alpine` fölé `rclone` kerül. A `pg_dump` így továbbra
is pontosan a kiszolgáló verziója, de a konténernek már van mivel elhagynia a
gépet.

### Beállítás

1. A Cloudflare irányítópultján hozz létre egy **privát** R2-vödröt. Ez
   adatbázis-mentés: minden felhasználó minden adata benne van, nyilvános
   hozzáférést semmiképp ne kapjon.
2. **R2 → Manage API Tokens → Create API Token**, jogosultság **Object Read &
   Write**, és a hatókört szűkítsd erre az egy vödörre. Egy fiókszintű token
   ennél a feladatnál semmivel nem ad többet, cserébe többet visz, ha kiszivárog.
3. A `.env`-be:

   ```
   R2_ENDPOINT=https://<fiókazonosító>.r2.cloudflarestorage.com
   R2_BUCKET=<a vödör neve>
   R2_PREFIX=yume
   R2_ACCESS_KEY_ID=<a token hozzáférési kulcsa>
   R2_SECRET_ACCESS_KEY=<a token titka>
   ```

4. A beállítás próbája **feltöltés nélkül** — ez írni is megpróbál, nem csak
   olvasni, mert a mentéshez írni kell:

   ```
   docker compose run --rm --entrypoint sh backup -c '/db/sync-r2.sh --check'
   ```

5. Ha rendben van, indítsd újra a konténert, és nézd meg egy valódi futáson:

   ```
   docker compose up -d backup
   docker compose logs -f backup
   ```

### Visszaállítás az R2-ből

A `restore.sh` a `/backups` köteten lévő fájllal dolgozik, tehát a távoli
másolatot előbb le kell hozni. Egy elveszett gép után, új gépen:

```
docker compose run --rm --entrypoint sh backup -c \
  'rclone copy "R2:$R2_BUCKET/$R2_PREFIX/yume-<dátum>.dump" /backups --s3-no-check-bucket'
docker compose run --rm backup /db/restore.sh yume-<dátum>.dump
```

A `restore.sh` a visszaállítás után lefuttatja a hiányzó migrációkat és lezárja
a dumpból örökölt, félbemaradt mentéskéréseket — lásd fentebb.

---

## A katalógus képeinek tükre

Ugyanaz a tárhely, **másik vödör** (`yume-media`), és ez a szétválasztás
szándékos: a képeket egy nyilvános útvonal szolgálja ki, ami a tárhelykulcsot a
kérés URL-jéből veszi. Ha a mentések ugyanabban a vödörben lennének, egyetlen
hiba abban az útvonalban az egész adatbázist letölthetővé tenné.

### Miért létezik

A YUME mind az 57 012 borítóját, bannerét és háttérképét idegen CDN-ről
hotlinkeli. Ez ma ingyen van — a látogató böngészője tölti a képeket —, de a
katalógus kinézete három olyan cégen múlik, amelyikkel nincs szerződés. Azon a
napon, amikor bármelyik letiltja a hotlinkelést, a képek eltűnnek, és akkor már
letükrözni sem lehet őket.

A tükrözés ezért **nem változtat azon, honnan szolgáljuk ki a képeket**. Csak
elkészíti a másolatot, amit utólag nem lehetne.

### Üzemeltetés

```bash
# indítás vagy folytatás (minden fajta, borítóval kezdve)
docker compose exec -T postgres psql -U yume -d yume -c \
  "INSERT INTO jobs (queue, payload) VALUES ('media', '{\"dedupe\":\"media-inditas\"}'::jsonb)"

# csak egy fajta
#   '{"kinds":["cover"],"dedupe":"media-inditas"}'

# hol tart
docker compose exec -T postgres psql -U yume -d yume -c \
  "SELECT kind, count(*) FILTER (WHERE mirror_key IS NOT NULL) AS tukrozve, count(*) AS osszes
     FROM anime_images WHERE object_key LIKE 'http%' GROUP BY 1 ORDER BY 1"
```

A feladat kötegenként fut, és magát ütemezi újra, amíg van hátra. Egyszerre
egy tükrözés áll a sorban — ezt a `scheduleNext` számolja, nem a `dedupe`
kulcs, mert a kezelő futása közben a saját sora még nincs késznek jelölve.

Hangolás: `MEDIA_MIRROR_BATCH` (alap 200), `MEDIA_MIRROR_CONCURRENCY` (alap 4),
`MEDIA_MIRROR_TIMEOUT_MS` (alap 20 000). A párhuzamosság szándékosan alacsony:
harmincezer kérés egy idegen CDN-re rövid idő alatt pontosan az a viselkedés,
amiért a hotlinkelést letiltják.

### Az átkapcsolás

A kiszolgálás **egyelőre az eredeti forrásról megy**. A tükör a `/media/<kulcs>`
útvonalon már elérhető, egy évre gyorsítótárazható válasszal (a kulcs a forrás
URL-jének hasítása, tehát mögötte sosem lesz más kép). Az átkapcsoláshoz a
katalógus lekérdezéseinek a `mirror_key`-t kell visszaadniuk az `object_key`
helyett, ha van — ez egy külön, visszavonható lépés, és addig érdemes megvárni,
amíg vagy a forrás megbízhatatlanná válik, vagy a YUME saját domaint kap (akkor
az R2 saját domainnel, nulla kimenő díjjal szolgálhat ki).
