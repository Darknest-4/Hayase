# Redis — why it is not adopted yet

`docker-compose.yml` carries a Redis service under the `infra` profile, and
`config.ts` reads `REDIS_URL`. **No code uses it.** That is a decision, not an
oversight, and this page records it so nobody has to re-derive it.

The same standard was applied to OpenSearch (`docs/search.md`): infrastructure
earns its place by solving a problem that exists now.

## The two jobs waiting for it

**1. Caching the permission lookup.** `requirePermission` runs a three-table
join on every privileged request, with no cache — the plugin's comment claims a
per-request memo that was never implemented. On one instance this is a local
problem with a local fix: an in-process TTL cache removes the query without any
new infrastructure. Redis only becomes the right answer when several instances
must share and invalidate the same cache.

**2. Backing the WebSocket hub.** `lib/ws.ts` keeps subscriptions in an
in-process `Map`. Two app instances would not error — they would quietly
half-work: notifications reaching only one instance's clients, watch-together
rooms splitting in two, half of a chat's messages vanishing. `publish()` is a
single deliberate seam, so a Redis pub/sub adapter drops in there without
touching any call site.

## Why not now

Yume runs on one VPS with one app instance. In that shape Redis adds a resident
service, a cache-invalidation bug class, and a second thing that can be down —
in exchange for nothing measurable. The in-process `Map` is *correct* for one
instance; it is only wrong for two.

## When to adopt it

Adopt Redis at the point a second app instance is actually being started —
because at that moment the WebSocket hub silently breaks, and silent breakage
is the worst kind. That is the trigger. Not sooner.

Order of work when it comes:

1. Redis pub/sub behind `publish()` in `lib/ws.ts` — the correctness fix.
2. Shared permission cache in `plugins/auth.ts` — the performance fix, once
   an in-process cache is no longer enough.

Until then, `REDIS_URL` being set does exactly one thing: it turns on the
health probe in `lib/probes.ts`. Unset, that probe reports `not_configured`
rather than raising a false alarm.

---

# RabbitMQ — removed

`docker-compose.yml` also carried a RabbitMQ service. It has been **removed**,
by the same standard applied to OpenSearch and Redis: infrastructure earns its
place by solving a problem that exists now.

The job queue runs on Postgres (`jobs`, `FOR UPDATE SKIP LOCKED`) with retries,
exponential backoff, dedupe keys, lease heartbeats, per-handler timeouts,
concurrent lanes and dead-letter handling. At Yume's volume that is not a
compromise — it is fewer moving parts, one backup that covers the queue too,
and transactional enqueue alongside the write that caused it, which a separate
broker cannot give you without an outbox.

A broker becomes the right answer at a throughput where polling Postgres is the
bottleneck, or when jobs must fan out to consumers written in other languages.
Neither is true, and if either becomes true the queue's public surface
(`enqueue`, `runWorker`) is small enough to swap behind.

---

# MinIO — removed

Carried in compose for extension package storage, which is now
[content-addressed on the filesystem](./extensions.md). Packages are small,
immutable and few; a volume backs up with everything else, and the store goes
through one module (`server/src/lib/package-store.ts`) whose four functions an
object-storage backend can replace without touching a call site.

Reach for object storage when packages outgrow a single host's disk, or when
more than one app instance must serve them — the same trigger as Redis.

---

# Cover images — still hotlinked, deliberately

`anime_images.object_key` holds a full AniList CDN URL rather than a key into
our own storage — the column name promises more than it delivers. Artwork is
therefore served by someone else's infrastructure, which we control neither for
availability nor under their terms of use.

This is **not fixed**, and the reasoning is the same one applied to Redis and
MinIO: caching ~25,000 covers means a fetch pipeline, several GB of disk, cache
invalidation when artwork changes, and a migration of existing rows — real work
for a problem that has not bitten yet. The metadata comes from AniList too, so
a source that stops serving us breaks more than the images.

**Adopt when** either happens: AniList starts rate-limiting or blocking
hotlinked images, or the catalogue stops depending on AniList for metadata. The
machinery already exists — `server/src/lib/package-store.ts` is a
content-addressed store whose four functions would serve images unchanged, and
the `packages` volume is already backed up.
