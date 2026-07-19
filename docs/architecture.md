# Yume — Architecture

Yume is an anime streaming platform that grew out of the Hayase interface
codebase. It keeps Hayase's two strongest ideas — **the platform hosts zero
content** and **sources come from sandboxed extensions** — and rebuilds
everything around them as a service-backed product with its own identity.

```
                        ┌─────────────────────────────┐
   web / desktop /      │        API Gateway          │
   mobile clients ──────▶  Fastify (REST + GraphQL)   │
                        │  authn · RBAC · rate limit  │
                        └──┬────────┬────────┬────────┘
                           │        │        │
              ┌────────────▼─┐  ┌───▼────┐  ┌▼──────────────┐
              │ PostgreSQL 16│  │ Redis  │  │ OpenSearch    │
              │ (source of   │  │ cache/ │  │ (search +     │
              │  truth)      │  │ pubsub │  │  autocomplete)│
              └────────────▲─┘  └───▲────┘  └▲──────────────┘
                           │        │        │
                        ┌──┴────────┴────────┴────────┐
                        │      Queue (RabbitMQ)       │
                        │ workers: notify · stats ·   │
                        │ import · ext-review · image │
                        └──────────────┬──────────────┘
                                       │
                        ┌──────────────▼──────────────┐
                        │   Object Storage (S3/MinIO) │
                        │ images · packages · subs    │
                        └─────────────────────────────┘
```

## Components

### API Gateway (`server/`)
Single Fastify (Node 22, TypeScript, ESM) service exposing REST under
`/v1/*` and GraphQL under `/graphql`. Responsibilities:

- **Auth**: short-lived JWT access tokens (15 min) + rotating refresh tokens
  stored hashed in `sessions`. OAuth linking for AniList/MAL/Discord.
- **RBAC**: `user → roles → permissions` resolved once per request, cached
  in Redis (`perm:{userId}`, invalidated on role change).
- **Rate limiting**: Redis sliding window, per user / per API key / per IP.
- **Validation**: every route validates body/query with JSON Schema
  (compiled by Fastify); OpenAPI spec is generated from the same schemas.

Horizontally scalable: no server-side state outside Redis/Postgres.

### PostgreSQL — source of truth
Schema in `db/migrations/`, one file per domain, fully commented. See
[database.md](database.md). Scaling path: read replicas for catalogue
reads → PgBouncer pooling → time-partitioned event tables (already
partitioned) → citus/sharding only if profile data outgrows one primary.

### Redis
| Key pattern | Purpose | TTL |
|---|---|---|
| `session:{id}` | refresh-session lookup | session lifetime |
| `perm:{userId}` | resolved permission set | 5 min / invalidated |
| `rl:{scope}:{id}` | rate-limit windows | window |
| `trend:anime` (zset) | trending scores, incremented on view/watch | rolling |
| `cw:{profileId}` | continue-watching row cache | 10 min |
| `progress:{profileId}` (hash) | write-behind playback positions | flushed 30s |
| `rec:{profileId}` | personalised recommendation ids | 24 h |
| `online` (zset) | online-user presence heartbeats | 2 min |
| `q:*` | lightweight job de-dup keys for workers | job |

Playback progress is the hottest write path: the player PATCHes every ~10 s;
the API writes to the Redis hash and a worker flushes dirty entries to
`watch_progress` every 30 s. A crash loses at most 30 s of positions.

### OpenSearch
One `anime` index: titles (edge-ngram for autocomplete), synonyms, genres,
tags, popularity/trending signals for ranking. Indexed by a worker on every
catalogue mutation (outbox pattern: `anime` updates enqueue a reindex job).
Search API: full-text with fuzziness, autocomplete suggester, and a
"semantic" mode that expands the query with tag vectors (AI search).
Postgres `tsvector`/trigram indexes remain as a degraded-mode fallback.

### Queue
Durable Postgres-backed job queue (`jobs` table, `FOR UPDATE SKIP LOCKED`,
retries with exponential backoff, dedupe keys) — transactional with the
data it acts on and zero extra infrastructure. RabbitMQ (topic exchange
`yume.events`) is the drop-in upgrade path once fan-out volume demands it.
Workers are separate deployables in `server/src/workers/`
(`npm run worker`, or `worker:once` to drain — used by tests and cron):

| Queue | Job |
|---|---|
| `notify` | fan out notifications (DB inbox + push + email) |
| `stats` | roll up watch_history → profile_stats, watch_stats_daily; XP/achievements |
| `import` | metadata importers (AniList/AniDB/TVDB dumps → catalogue) |
| `search-index` | OpenSearch reindexing |
| `ext-review` | static-analysis pipeline for submitted extension packages |
| `media` | image resize/blurhash/dominant-color on upload |
| `maintenance` | partition creation, retention pruning, health checks |

Everything async leaves the request path: the API only enqueues.

### Object storage (S3 / MinIO in dev)
Buckets: `media` (covers/banners/screenshots/avatars, public via CDN),
`packages` (signed extension tarballs, public, immutable), `subs`
(subtitle files). DB stores keys, never URLs — CDN domain is config.

## Client architecture

The desktop/mobile clients keep Hayase's proven split:

- **UI**: web app (this repo's `web/`, being rebuilt with the Yume design
  system — see `packages/design-tokens/`).
- **Native shell**: torrent engine, disk, discovery — unchanged concept.
- **Extension host**: sandboxed workers per extension (see
  [extensions.md](extensions.md)); now loading signed store packages with
  declared permissions instead of raw URLs.

Offline: the client caches catalogue responses (SWR + IndexedDB), queues
list mutations while offline and replays them; conflict rule is
last-write-wins per field with server timestamps.

## Key decisions (ADR summary)

1. **Postgres as single source of truth, everything else derived.** Redis,
   OpenSearch and rollup tables can all be rebuilt from Postgres. No dual
   writes without an outbox job.
2. **UUID keys everywhere** except append-only event tables (bigint
   identity + time partitioning) — events never need cross-shard identity.
3. **One comment system, one report system** — polymorphic
   `subject_type/subject_id` with a closed CHECK set, giving moderation a
   single surface instead of per-feature tables.
4. **Denormalised counters** (like/install/post counts, scores) maintained
   in-transaction or by workers; correctness is periodically reconciled by
   the stats worker. Reads dominate writes ~100:1 here.
5. **Extensions declare permissions; the runtime enforces them.** The
   accuracy-capping query proxy from Hayase survives as `query:*`
   permissions; network access becomes an explicit host allowlist.
6. **REST and GraphQL share one service layer.** Resolvers and route
   handlers call the same typed services; neither owns business logic.

## Environments

`docker-compose.yml` starts Postgres, Redis, OpenSearch, MinIO and
RabbitMQ for local development. The API reads all connections from env
vars (12-factor); see `server/.env.example`.
