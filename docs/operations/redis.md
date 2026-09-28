# Redis — why it is not adopted yet

`docker-compose.yml` carries a Redis service under the `infra` profile, and
`config.ts` reads `REDIS_URL`. **No code uses it.** That is a decision, not an
oversight, and this page records it so nobody has to re-derive it.

The same standard was applied to OpenSearch (`docs/database/search.md`): infrastructure
earns its place by solving a problem that exists now.

## The two jobs it was waiting for — both are covered now

**1. Caching the permission lookup.** Done in-process:
`apps/api/src/middleware/auth.ts` keeps the permission set, the role list and
the token version per user for 30 seconds (`PERMISSION_CACHE_TTL_MS`), and
drops a user's entries the moment their roles, status or sessions change in
this process. A revocation made by *another* process takes effect within the
TTL. That bounded staleness is the one thing Redis would remove.

**2. Fanning out WebSocket messages across instances.** Done on Postgres:
`apps/api/src/infrastructure/pubsub/index.ts` publishes every hub message on
`LISTEN/NOTIFY`, and every instance delivers what it receives to its own
sockets. Two app instances therefore do not split a watch-together room or a
chat — this used to be the argument for Redis, and it no longer applies.

## When to adopt it

When several app instances run and one of these starts to matter:

1. **Rate limiting.** The rate-limit counters (`@fastify/rate-limit`) and the
   edge layer's counters (`modules/edge/counters.ts`) are per process. With
   two instances every limit is effectively doubled. A shared store is the
   fix; `@fastify/rate-limit` accepts a Redis client directly.
2. **Revocation latency.** If "a ban takes effect everywhere within 30 s" is
   no longer good enough, the permission and version caches in
   `middleware/auth.ts` move to a shared cache with explicit invalidation.

Until then, `REDIS_URL` being set does exactly one thing: it turns on the
health probe in `apps/api/src/infrastructure/observability/probes.ts`. Unset,
that probe reports `not_configured` rather than raising a false alarm.

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

Carried in compose for extension package storage. The extension platform is
gone, and the bytes the app does store now — the mirrored catalogue images and
the off-site backups — go to S3-compatible object storage (Cloudflare R2,
`apps/api/src/infrastructure/storage/s3.ts`), which needs no service of our own.

---

# Cover images — mirrored, optionally

`anime_images.object_key` holds the source URL (AniList's CDN). With
`R2_ENDPOINT` and `R2_MEDIA_BUCKET` set, the worker mirrors each image into our
own bucket (`apps/api/src/modules/media/mirror.ts`, `anime_images.mirror_key`)
and the client is pointed there (`MEDIA_BASE_URL`, or the app's own `/media/`
route). Without them, images are served from the source — which we control
neither for availability nor under its terms of use. See
`docs/operations/media.md`.
