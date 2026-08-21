# Metadata & search

Two layers that share one goal: the catalogue holds one correct entry per
anime, and a user can find it by any name they know it under.

- **Metadata engine** — `server/src/lib/metadata.ts`
- **Search** — `server/src/lib/search.ts`
- Schema — `db/migrations/0017_metadata_search.sql`

---

## Why the metadata engine exists

The AniList enricher used to write straight onto the row:

```sql
UPDATE anime SET canonical_title = coalesce($2, canonical_title),
                 synopsis = coalesce($3, synopsis), ...
```

`coalesce` only protects against a *missing* incoming value. When AniList had
a value — which is most of the time — it won, every time. An administrator who
fixed a title or rewrote a synopsis by hand lost that work on the next
importer run, silently, with nothing in the logs.

Every automatic write now goes through `resolveFields()`, which decides field
by field whether the incoming value may land.

### The three rules, in order

**1. Human edits are absolute.** Saving in the catalogue admin adds the fields
you touched to `anime.locked_fields`. No automatic source ever writes a locked
field. Only a human can release one (the *Release* button in the editor, or
`POST /v1/admin/catalogue/:id/unlock`).

**2. Provider precedence.** Each field records who set it in
`anime.metadata_sources`. A lower-ranked source cannot overwrite a
higher-ranked one:

| Provider | Rank | What it is |
|---|---:|---|
| `manual` | 100 | a person in the catalogue admin |
| `anilist` | 60 | the enrichment importer — richest automatic source |
| `mal` | 50 | MyAnimeList |
| `aod` | 30 | anime-offline-database, the initial seed |
| `stub` | 10 | placeholder row created by `/v1/anime/resolve` |
| *unknown* | 0 | anything unrecognised — cannot overwrite anything |

A provider may always refresh **its own** field, so re-running the importer
still picks up upstream corrections.

**3. Nothing is erased by absence.** `null`, `undefined` and blank strings are
skipped, never written. An empty stored field is fillable by anyone.

**Exception — volatile statistics.** `popularity` and `average_score` are
readings, not facts: the freshest value always wins regardless of precedence.
A human lock still holds, so a curated entry can pin its score.

### What it looks like in the database

```json
{
  "synopsis":  { "provider": "manual",  "at": "2026-08-21T23:20:23.769Z" },
  "popularity":{ "provider": "anilist", "at": "2026-08-21T23:20:43.124Z" }
}
```

The catalogue editor renders this as a *Metadata sources* panel: which
provider set each field, how long ago, and whether it is locked.

### Duplicate detection & merge

`findDuplicates()` compares titles by trigram similarity **within the same
`(season_year, format)` bucket** — a full cross join over 25k rows would not
be viable, and same-year-same-format is where real duplicates live. Entries
already linked by `anime_relations` are excluded, so a sequel is never
proposed as a duplicate of its prequel.

The scan only ever **proposes**. A merge is irreversible, so it needs
`anime.merge` and an explicit confirmation. `mergeAnime()` moves titles (kept
as synonyms of the winner), synonyms, genres, tags, relations, external ids
and library entries — where a profile tracked both, the further progress
survives — then deletes the losing row.

`normaliseTitle()` folds a title to a comparison key: accents stripped,
punctuation dropped, articles removed, and season markers unified, so
`Fate/Zero 2nd Season` and `Fate Zero Season II` collapse to `fate zero season 2`.

---

## Search

### What was wrong

Search matched `canonical_title` and `anime_synonyms` only. **`anime_titles`
was never queried** — so the romaji, English and native titles were invisible
despite being stored and imported. Searching *Attack on Titan* returned
nothing, because the row is called *Shingeki no Kyojin*.

Ranking was a single `similarity()` score over 200 rows re-sorted in
JavaScript, so a fuzzy near-miss could outrank an exact title.

### Tiered ranking

A result's tier is decided by **how** it matched. Only inside a tier does the
fuzzy score matter:

| Tier | Match |
|---:|---|
| 100 | the canonical title is exactly the query |
| 90 | a romaji / english / native title is exactly the query |
| 80 | a synonym is exactly the query |
| 70 | a title starts with the query |
| 60 | a title contains the query |
| 40 | full-text match (`websearch_to_tsquery` over the stored tsvector) |
| 20 | trigram similarity only — the typo-tolerant tail |

Ties break on similarity, then popularity. That is what makes `one piece`
return *One Piece* above *One Piece Film: Red*, which the old single-score
ranking could not guarantee.

Each row reports its `tier` and `matched_title`, so it is visible *why*
something matched.

### Filters

`genre`, `year`, `season`, `format`, `status` and `nsfw` combine freely, and
`sort` can replace relevance ordering with `popularity` / `score` / `newest` /
`title` (tier stays as the tiebreak). Hidden and unlisted entries never
appear. Every filter value is a bound parameter.

### Endpoints

| Route | Purpose |
|---|---|
| `GET /v1/anime/search` | full search — filters, sorting, pagination |
| `GET /v1/anime/suggest` | quick-search box: minimal payload, no telemetry |
| `GET /v1/admin/catalogue/duplicates` | proposed duplicate pairs (`anime.merge`) |
| `POST /v1/admin/catalogue/:id/merge` | merge another entry into this one (`anime.merge`) |
| `POST /v1/admin/catalogue/:id/unlock` | release fields back to the importers (`anime.edit`) |

The web client prefers the catalogue and falls back to AniList when no
backend is configured, or when the catalogue's hits have no `anilist_id` to
navigate to yet.

### Telemetry

`/v1/anime/search` records the query and result count into `search_stats`;
zero-result queries are the catalogue-gap report. `/suggest` records nothing —
it fires on every keystroke, which would be noise. Only the query text,
normalised form and result count are stored: no IP, no user agent, and the
profile id only when it is a well-formed UUID. Rows are dropped with their
monthly partition after 3 months (`maintenance.ts`). A telemetry failure is
swallowed — it can never break a search.

---

## Why not OpenSearch

`docker-compose.yml` carries an OpenSearch service and the schema comments
mention it, but it is **not used, and deliberately so.**

At 25,672 catalogue rows, Postgres with `pg_trgm` and `tsvector` answers off
the indexes in migration 0017 in single-digit milliseconds. OpenSearch would
add ~1 GB of RAM on a single VPS, a JVM to operate, an index to keep in sync,
and a second failure mode — for no measurable gain at this scale.

The point at which this should be revisited: several hundred thousand
entries, or a requirement Postgres genuinely cannot serve (learned ranking
from click feedback, multi-language analyzers). Until then the cost is real
and the benefit is not.

---

## Indexes (migration 0017)

| Index | Serves |
|---|---|
| `anime_canonical_lower_idx` | exact/prefix canonical match (tiers 100, 70) |
| `anime_titles_lower_idx` | exact/prefix alternative-title match (tiers 90, 70) |
| `anime_synonyms_lower_idx` | exact synonym match (tier 80) |
| `anime_titles_trgm` | fuzzy alternative titles — **this is what was missing** |
| `anime_popularity_idx` | the final tiebreak, public rows only |
| `anime_year_format_idx` | narrows the duplicate scan |

## Tests

`server/test/metadata.test.ts` (16) — every precedence branch, lock
behaviour, empty/unchanged handling, volatile fields, title normalisation.
`server/test/search.test.ts` (16) — tier definitions, filter composition,
parameter binding, limit clamping, telemetry redaction and failure isolation.
