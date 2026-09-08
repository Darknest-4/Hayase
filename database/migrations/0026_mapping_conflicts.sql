-- ============================================================================
-- 0026 — Record external-id collisions instead of losing the batch to them
-- ============================================================================
-- `anime_mappings.mal_id` is UNIQUE, and the AniList enricher wrote it with a
-- blind `UPDATE ... SET mal_id = coalesce(mal_id, $2)`. When another anime
-- already held that MAL id the statement raised, and because the enricher
-- wraps 50 rows in one transaction, one collision discarded all fifty — the
-- 49 innocent rows included. A run over 11 363 rows updated 8 326 and lost
-- 9 650 that way.
--
-- Collisions are not corruption and not a bug in the data. AniList splits a
-- show into separate entries far more often than MyAnimeList does, so two
-- AniList ids legitimately point at one MAL entry: seasons, cours, and
-- recap/compilation releases. There is nothing to "fix" in most of them.
--
-- What was missing is a record. A collision was a log line inside a failed
-- batch, so nobody could answer "which anime wanted which MAL id, and who
-- already had it" after the fact. This table answers exactly that, and the
-- unique key means re-running the importer updates a row rather than adding
-- a duplicate — a collision that keeps happening reads as one entry with a
-- rising `seen_count`, not as thousands of rows.
-- ============================================================================

CREATE TABLE mapping_conflicts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  anime_id    uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  provider    text NOT NULL CHECK (provider IN ('mal', 'anidb', 'anilist', 'kitsu', 'tvdb', 'tmdb', 'imdb')),
  external_id text NOT NULL,
  -- The anime that already owns the id. Nullable because it may be deleted
  -- later, and the record of the collision is still worth keeping.
  held_by     uuid REFERENCES anime(id) ON DELETE SET NULL,
  source      text NOT NULL,                       -- which importer saw it
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  seen_count  integer NOT NULL DEFAULT 1,
  -- Set by hand once somebody has looked: merged the duplicates, or decided
  -- the split is correct and the collision is expected.
  resolved_at timestamptz,
  resolution  text,
  UNIQUE (anime_id, provider, external_id)
);

COMMENT ON TABLE mapping_conflicts IS
  'External ids an importer could not write because another anime already held them. Mostly AniList season splits against one MAL entry, not corruption — but recorded so duplicates in the catalogue can be found.';
COMMENT ON COLUMN mapping_conflicts.held_by IS
  'The anime that already owns external_id. Together with anime_id this is the candidate duplicate pair.';
COMMENT ON COLUMN mapping_conflicts.resolved_at IS
  'Set by hand. An unresolved row is not an error — most collisions are legitimate season splits.';

-- The review queue: what is still unlooked-at, most persistent first.
CREATE INDEX mapping_conflicts_open_idx
  ON mapping_conflicts (seen_count DESC, last_seen DESC) WHERE resolved_at IS NULL;
-- "who else wanted this id" and "is this anime involved in any collision"
CREATE INDEX mapping_conflicts_external_idx ON mapping_conflicts (provider, external_id);
CREATE INDEX mapping_conflicts_held_by_idx  ON mapping_conflicts (held_by) WHERE held_by IS NOT NULL;
