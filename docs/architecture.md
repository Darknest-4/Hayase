# Yume — Architecture

Yume is an anime streaming platform that grew out of the Hayase interface
codebase. It keeps Hayase's strongest idea — **the platform hosts zero content**; a
video source is a *reference* an operator registers against an episode — and
rebuilds everything around it as a service-backed product with its own
identity.

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
                        │   Queue (Postgres jobs)     │
                        │ workers: notify · stats ·   │
                        │ import · ext-review · image │
                        └──────────────┬──────────────┘
                                       │
                        ┌──────────────▼──────────────┐
                        │   Object Storage (S3/MinIO) │
                        │ images · subs               │
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

### Search — Postgres, not OpenSearch

Search runs entirely in Postgres: `pg_trgm` and `tsvector` over canonical
titles, `anime_titles` and `anime_synonyms`, with tiered ranking so an exact
title always outranks a fuzzy near-miss. See [`search.md`](./search.md).

This document originally planned an `anime` index behind an outbox reindex
worker, and `docker-compose.yml` carried the service. That was
**deliberately not built**: at ~25k catalogue rows Postgres answers off its
indexes in single-digit milliseconds, while OpenSearch would cost ~1 GB of RAM
on a single VPS, a JVM to operate and an index to keep in sync. Revisit at
several hundred thousand entries, or for a requirement Postgres cannot serve
(learned ranking from click feedback, multi-language analyzers).

### Queue
Durable Postgres-backed job queue (`jobs` table, `FOR UPDATE SKIP LOCKED`,
retries with exponential backoff, dedupe keys) — transactional with the
data it acts on and zero extra infrastructure. A broker was considered and rejected (see docs/redis.md).events`) is the drop-in upgrade path once fan-out volume demands it.
Workers are separate deployables in `server/src/workers/`
(`npm run worker`, or `worker:once` to drain — used by tests and cron):

| Queue | Job |
|---|---|
| `notify` | fan out notifications (DB inbox + push + email) |
| `stats` | roll up watch_history → profile_stats, watch_stats_daily; XP/achievements |
| `import` | metadata importers (AniList/AniDB/TVDB dumps → catalogue) |
| `metadata` | AniList enrichment runs, one at a time, progress on the run row |
| `media` | image resize/blurhash/dominant-color on upload |
| `maintenance` | partition creation, retention pruning, health checks |

Everything async leaves the request path: the API only enqueues.

### Object storage (S3 / MinIO in dev)
Buckets: `media` (covers/banners/screenshots/avatars, public via CDN) and
`subs` (subtitle files). DB stores keys, never URLs — CDN domain is config.
Nothing is stored outside the database today; see [redis.md](redis.md) for the
trigger that would change that.

## Client architecture

The desktop/mobile clients keep Hayase's proven split:

- **UI**: web app (this repo's `web/`, being rebuilt with the Yume design
  system — see `packages/design-tokens/`).
- **Native shell**: torrent engine, disk, discovery — unchanged concept.
- **Playback**: the catalogue's registered sources first, then any URL the
  viewer pasted. There is no third-party code in the page — the extension
  sandbox and the store it loaded from were removed once every feature they
  carried became part of the platform.

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
5. **References are validated where they are written.** A source URL or a
   theme colour ends up in a viewer's browser as an attribute or a custom
   property, so the scheme and the grammar are checked at the write rather
   than at each of the places the value is later read.
6. **REST and GraphQL share one service layer.** Resolvers and route
   handlers call the same typed services; neither owns business logic.

## Environments

`docker-compose.yml` starts Postgres, Caddy and
an optional Redis for local development. The API reads all connections from env
vars (12-factor); see `server/.env.example`.

## Where anime data comes from

The catalogue is the source of truth. External providers are the fallback.

That ordering used to be the other way round, and it was invisible: the
database held a full catalogue schema — titles, synonyms, genres, tags,
images, relations, mappings, episodes, plus per-field provenance in
`metadata_sources` — while the detail page called `API.media()`, which goes
straight to `graphql.anilist.co` from the browser. Only quick search consulted
the catalogue. So the catalogue behaved as a search index, and if AniList was
down the detail page failed for titles whose every field was in our own
database.

### The resolver

`web/js/catalogue.js` is the only module that knows both vocabularies. It maps
a catalogue record into AniList's `Media` shape, because the whole UI is
written against that shape and rewriting it would be a large change with no
user-visible benefit.

```
Catalogue.media(id)      catalogue → AniList
Catalogue.episodes(media) catalogue → ani.zip / Jikan
```

The enums need no translation: `anime_format`, `anime_status` and
`anime_season` were defined with AniList's own values.

### Identity

`#/anime/:id` and `#/watch/:id:ep` accept **either** an AniList id (numeric) or
a Yume catalogue id (uuid). Existing links keep working, and an anime that
exists only in our catalogue is reachable — previously search dropped those
rows, because the route could only navigate by AniList id.

On the mapped record:

| field | meaning |
|---|---|
| `id` | what the app navigates and stores by — the AniList id when there is one, the catalogue uuid otherwise |
| `yumeId` | always the catalogue uuid |
| `anilistId` / `idMal` | the real provider ids, or `null`. Provider links are omitted rather than built from a uuid |

`id` falls back to the uuid deliberately: the library, favourites, resume
points and the watch route all key off it, and a `null` there breaks every one
of them silently.

### Provider precedence

`server/src/lib/metadata.ts` ranks sources; higher wins, and a field written by
a higher-ranked source is not overwritten by a lower one.

| rank | source | |
|---|---|---|
| 100 | `manual` | a human in the catalogue admin |
| 60 | `anilist` | richest automatic source |
| 50 | `mal` | MyAnimeList / Jikan |
| 30 | `aod` | anime-offline-database — the bulk seed |
| 10 | `stub` | placeholder row from `/v1/anime/resolve` |

MyAnimeList is one source among several and ranks below AniList. `ani.zip`
supplies episode images and titles; `anime_mappings` cross-references AniList,
MAL, AniDB, Kitsu, TMDB, TVDB and IMDb ids.

### Falling back

A catalogue miss on a numeric id falls through to AniList. A miss on a uuid
does not, because AniList has never heard of our identifiers — asking would be
a guaranteed miss and a wasted round trip.

Episodes fall back when the catalogue holds *no* episode rows. An empty
`episodes` table for a series that has aired is a gap in our import, not a
statement that the series has no episodes, and returning `[]` there would show
the user an empty tab instead of the truth.

### What this does not do

It does not populate the catalogue. The importer (`scripts/import-anilist.ts`)
and the AniList worker exist for that and have to be run. Until they are, most
requests still miss and fall through — the difference is that they now fall
*through* rather than going straight out.

## Publishing

Nothing imported is published until somebody publishes it.

This platform serves a Hungarian audience, and a Hungarian subtitle does not
exist the moment an episode airs — it arrives days later. An import that landed
straight on the public surface would advertise episodes nobody can watch, which
is worse than not listing them at all. So the safe state is "not published",
and publishing is a decision somebody makes and is accountable for.

### Two independent decisions

`anime.visibility` and `episodes.visibility` share one vocabulary and are set
separately, because they answer different questions:

| state | anime | episode |
|---|---|---|
| `public` | listed in browse, search and schedule; detail page works | listed and playable |
| `unlisted` | reachable by direct link only | playable by direct link, not listed |
| `hidden` | nowhere; the detail endpoint 404s | unavailable |

Both default to `hidden`. The page can go up while the episodes wait for their
subtitles — that is the normal shape of a season on this site, not an edge
case.

Migration 0020 set existing episodes to `public`. A migration that silently
un-published live content would be a worse failure than the one it fixed.

### `total` is load-bearing

`GET /v1/anime/:id/episodes` returns `{ data, total }`, where `total` counts
episodes in every state. Without it an empty `data` is ambiguous, and the two
meanings need opposite handling:

- **`total = 0`** — we hold no episode data. Our silence is ignorance, so the
  client may fall back to ani.zip.
- **`total > 0`** — we hold episodes and publish none. Our silence is a
  decision, and the client must not fall back.

Without the distinction, hiding every episode would make the client fetch them
from ani.zip and show them anyway. The publishing controls would be decoration.
`web/js/catalogue.js` implements this rule and `web/test/catalogue.test.mjs`
pins it.

### Managing it

The admin catalogue editor lists **all** episodes, unfiltered — staff need to
see what is *not* published, which is the whole point — with a state badge per
row, a one-click publish/unpublish, and a summary line saying how much of the
season viewers can actually reach.

`POST /v1/admin/catalogue/:id/episodes/visibility` takes
`{ visibility, from?, to? }` and moves a whole range at once, because the real
workflow is per-batch: a set of subtitles lands and several episodes go live
together. Doing that one PATCH at a time is one chance per episode to miss one,
and a half-published season is the state this exists to prevent. The update is
guarded on a real change, so a repeated call reports `changed: 0` rather than
recording an editorial act that did not happen.

Visibility changes are written to `audit_logs` as `episode.visibility` and
`anime.visibility` — "who put this live" is exactly the question asked
afterwards.


## Which surfaces read the catalogue

All of them, as of the browse rewiring. `web/js/catalogue.js` presents
AniList's own interface — `search(variables) → { media }` — so the pages did
not have to be rewritten, and routes each shape of request to the endpoint that
can serve it:

| request | endpoint |
|---|---|
| `{ ids: [...] }` | `GET /v1/anime/by-anilist?ids=…` — batch, order preserved |
| `{ search: '…' }` | `GET /v1/anime/search` — tsvector + trigram |
| `{ season, genre, … }` | `GET /v1/anime/` — filtered, keyset-paginated |
| schedule window | `GET /v1/anime/schedule` — published episodes only |

The batch route is what made the home page possible: rails resolve library
entries into cards, the library stores AniList ids, and without a way to ask
for a set the client had to ask AniList. It returns card-shaped rows — cover,
title, score, format, year — because fetching every synonym and tag for fifty
titles to render fifty covers would be a large waste on the busiest screen.

### Falling back is normal, not a failure

`search()` returns `null` rather than a partial answer when the catalogue
cannot serve a request, and `searchOrAniList()` is the single place the
fallback is applied. Two cases are expected and correct:

- **a season we do not hold** — the seed dump has no 2026 titles, so the
  "popular this season" rail falls through;
- **a schedule window with no published episodes** — the calendar asks for
  this week, and an imported episode is not published until its subtitle
  exists.

Everything else is served locally. Verified in a browser against a real 25,703-
title catalogue with all HTTPS blocked: home, search and schedule render, and
the only outbound calls are the two above.
