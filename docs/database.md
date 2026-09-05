# Yume — Database design

PostgreSQL 16. The schema lives in `db/migrations/` — **every table and every
non-obvious column is commented in the SQL itself** (`COMMENT ON TABLE`,
inline `--` notes: purpose, relationships, index rationale). This document
covers the cross-cutting decisions and the per-domain shape. All migrations
are verified to apply cleanly on a fresh Postgres 16 (101 relations).

## Domains

| Migration | Domain | Core tables |
|---|---|---|
| `0001_users_auth` | identity & access | `users`, `oauth_identities`, `user_profiles`, `user_settings`, `sessions`, `devices`, `roles`/`permissions`/`role_permissions`/`user_roles`, `api_keys`, `notifications`, `security_logs` |
| `0002_anime` | catalogue | `anime`, `anime_titles`/`anime_synonyms`, `anime_mappings`, `genres`/`tags`, `companies`, `people`/`characters` + credit tables, `episodes`, `anime_relations`, `anime_recommendations`, `anime_images`/`anime_videos` |
| `0003_streaming` | playback | `video_sources`, `source_mirrors`, `subtitle_tracks`/`audio_tracks`, `skip_segments`, `watch_progress`, `watch_history` (partitioned), `bookmarks`, `watch_together_rooms` |
| `0004_community` | social | `comments`(+likes), `forums`/`topics`/`posts`, `chats`/`chat_members`/`messages` (partitioned), `clubs`(+members), `follows`, `friendships`, `reports`, `moderation_actions` |
| `0005_profile` | library & gamification | `library_entries`, `favorites`, `custom_lists`(+items)/`collections`, `reviews`(+votes), `achievements`/`badges`, `xp_events`, `profile_stats` |
| `0006_extensions` | extension store | `extension_developers`, `extensions`, `extension_versions`, `extension_permissions`, `extension_installs`, `extension_reviews`, `extension_events` (partitioned) |
| `0007_analytics` | telemetry | `page_views`, `watch_stats_daily`, `search_stats`, `performance_metrics`, `audit_logs`, `error_groups`/`error_logs` (all partitioned) |

## Entity relationship overview

```
users ─1:N─ user_profiles ─1:N─ library_entries ─N:1─ anime
  │              │                                       │
  │              ├─ watch_progress ─N:1─ episodes ─N:1───┤
  │              ├─ watch_history  (partitioned)         ├─ anime_titles / synonyms
  │              ├─ custom_lists ─ items ─N:1─ anime     ├─ anime_mappings (external ids)
  │              ├─ favorites / reviews / xp_events      ├─ anime_genres / anime_tags
  │              └─ profile_stats (materialised)         ├─ anime_companies / staff / characters
  ├─ sessions / devices / api_keys / notifications       ├─ anime_relations (graph)
  ├─ user_roles ─ roles ─ role_permissions ─ permissions └─ anime_images / videos
  ├─ comments / posts / messages / reports
  └─ extension_developers ─ extensions ─ versions ─ permissions
                                  └─ installs / reviews / events
episodes ─1:N─ video_sources ─N:1─ extensions
```

## Conventions

- **Keys**: `uuid` (`gen_random_uuid()`) for entities; `bigint identity`
  for append-only event streams. Composite natural PKs on pure join tables.
- **Time**: `timestamptz` only. `updated_at` via one shared trigger
  (`set_updated_at`). Event tables have no `updated_at` — they are never
  updated.
- **Text**: `citext` for email/username uniqueness; `CHECK` length limits on
  every user-supplied text field (defense in depth in front of app
  validation).
- **Soft delete** only on `users` (legal/audit reasons). Content uses
  `hidden_at` (moderation, reversible) or hard delete + audit log.
- **Denormalised columns** are marked in comments (`like_count`,
  `install_count`, `popularity`, `average_score`, `canonical_title`,
  `next_airing_at`…). Each has exactly one writer (transaction or worker)
  and a reconciliation job.

## Indexing strategy

Indexes exist for the queries the product actually runs — each is annotated
in the SQL. The patterns:

- **Hot list queries get composite covering indexes** matching their
  `WHERE` + `ORDER BY`: e.g. `library_entries (profile_id, status,
  updated_at DESC)` (my list tabs), `topics (forum_id, pinned DESC,
  last_post_at DESC)` (forum view), `video_sources (episode_id, accuracy,
  seeders DESC)` (source picker).
- **Partial indexes** where a predicate is implied: unread notifications,
  open reports, non-completed watch progress (`continue watching`),
  published extensions, active sessions. Keeps the index small and hot.
- **Trigram GIN** (`pg_trgm`) on `anime.canonical_title` and
  `anime_synonyms.synonym` for typo-tolerant fallback search;
  **tsvector GIN** on `anime.search` (weighted title A / synopsis C,
  maintained by trigger). This is the search backend, not a fallback — see docs/search.md.
- **FK helper indexes** on every child side used for lookups (Postgres does
  not auto-index FKs).

## Partitioning & retention

High-volume append-only tables are **range-partitioned by month** on
`created_at`/`started_at`: `watch_history`, `messages`,
`extension_events`, `page_views`, `search_stats`, `performance_metrics`,
`audit_logs`, `error_logs`. The maintenance worker creates the next
partition ahead of time and drops expired ones:

| Table | Retention |
|---|---|
| `page_views`, `search_stats`, `performance_metrics` | 90 days raw; rollups forever |
| `extension_events` | 90 days |
| `error_logs` | 30 days (groups kept) |
| `watch_history`, `messages`, `audit_logs`, `security_logs` | indefinitely (cheap, user-valuable / compliance) |

Dropping a partition is O(1) — no delete storms, no vacuum pressure.

## Scaling notes (millions of users)

1. **Read/write split**: catalogue reads (anime, episodes, images —
   ~80% of traffic) go to replicas; per-user data reads from the primary
   to avoid replica-lag anomalies in "my list".
2. **Connection pooling**: PgBouncer in transaction mode in front of the
   primary; the API keeps small pools.
3. **Hot rows**: playback progress buffered through Redis write-behind
   (30 s flush) → `watch_progress` sees ~1/3000th of raw update volume.
4. **Counters**: incremented with `UPDATE … SET x = x + 1` (single-row,
   HOT-friendly); high-contention counters (trending) accumulate in Redis
   and flush periodically.
5. **Growth headroom**: partitioned event tables scale linearly; the only
   table that could someday warrant sharding is `watch_progress` /
   `library_entries` (per-profile key → clean hash-shard boundary, or
   citus if it comes to that).

## Local development

```sh
docker compose up -d postgres
for f in db/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
```

Migrations are plain, ordered SQL by design: reviewable in a diff, no ORM
lock-in, runnable by any migration runner (the server ships a tiny one:
`node --run migrate`).

## External id collisions (`mapping_conflicts`)

`anime_mappings` gives each anime at most one id per provider, and `anilist_id`,
`mal_id` and `anidb_id` are each UNIQUE. Two anime therefore cannot share a MAL
id — and they try to, often.

The cause is not corruption. **AniList splits a show into separate entries far
more readily than MyAnimeList does**: seasons, cours, and recap or compilation
releases frequently get their own AniList id while MAL keeps one entry. Two
AniList ids pointing at one MAL id is the normal shape of a multi-season show.
Some collisions *are* real duplicates in our own catalogue — the seed skipped
9 147 of 41 537 entries as duplicates — which is exactly why the pair is worth
recording rather than discarding.

### The rule: the existing mapping wins

On a collision the importer **keeps the mapping already stored**, does not
write the new one, and records the pair in `mapping_conflicts`. Two reasons:

1. `anilist_id` is the identity the enricher works from — it is how the anime
   row is found at all. `mal_id` is a cross-reference, and nothing about
   arriving second makes a cross-reference more correct than the one there.
2. Overwriting would not add a mapping, it would **move** one. Every extension
   that resolves by MAL id would silently start returning a different anime,
   with no event anywhere saying so. Refusing leaves the catalogue as it was
   and puts the disagreement somewhere a person can look at it.

### Why it used to lose 9 650 rows

The enricher wrote the id with a blind `UPDATE ... SET mal_id = coalesce(...)`,
which raised on a duplicate. Because it wraps 50 rows in one transaction and
Postgres marks an errored transaction unusable, **one collision discarded all
fifty** — the 49 rows already written correctly included. A run over 11 363
rows updated 8 326 and lost 9 650 to roughly two hundred genuine collisions.

Both halves are now closed: the write cannot raise, and each row runs inside
its own `SAVEPOINT`, so anything else that fails costs one row rather than
fifty.

### Working through them

```sql
-- what is open, most persistent first
SELECT c.external_id, a.canonical_title, h.canonical_title AS held_by, c.seen_count
  FROM mapping_conflicts c
  JOIN anime a ON a.id = c.anime_id
  LEFT JOIN anime h ON h.id = c.held_by
 WHERE c.resolved_at IS NULL
 ORDER BY c.seen_count DESC;
```

An unresolved row is **not** an error — most are legitimate season splits. Mark
one once you have looked:

```sql
UPDATE mapping_conflicts SET resolved_at = now(), resolution = 'season split, expected'
 WHERE id = 42;
```

If the resolution was to merge a duplicate, the freed id can be attached with:

```sh
node --experimental-strip-types scripts/import-anilist.ts --retry-conflicts
```

The ordinary enrich run cannot do that: it only looks at rows whose synopsis is
still NULL, and a row that hit a collision was enriched successfully — only its
MAL id was withheld.
