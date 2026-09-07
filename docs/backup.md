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
