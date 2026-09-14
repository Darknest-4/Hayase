-- ============================================================================
-- 0040 — Say what happened to each row the enricher touched
-- ============================================================================
-- 1 335 anime have an AniList id and no synopsis, and nothing anywhere can say
-- why. `metadata_runs` records counts — processed, updated, failed — which
-- answers "how did the run go" and not "what happened to this title". So
-- "AniList has no description for it", "the run has not reached it yet" and
-- "the write was refused because an operator had locked the field" all look
-- identical from the outside: an empty description and no explanation.
--
-- One row per anime per source, overwritten on each attempt. Not an event log:
-- the question is always "what is the state of this title", and keeping every
-- attempt would grow a table the size of the catalogue times the number of
-- runs to answer a question about the latest one. `attempts` counts the tries
-- that a single row would otherwise lose.
--
-- The outcomes, and the distinction each one exists to draw:
--
--   updated      fields were written
--   unchanged    reached, nothing to change — the common good case
--   no_synopsis  reached, and AniList itself has no description. This is the
--                one that matters: it is not a gap in our pipeline, and
--                chasing it is wasted effort
--   not_found    the id was asked for and AniList returned nothing, so the
--                mapping is stale or the entry was removed upstream
--   locked       refused by field resolution — an operator edited it by hand,
--                or a higher-precedence provider owns the field
--   failed       the row raised; `detail` carries the message
--
-- A title with no row at all has never been attempted, which is why absence is
-- meaningful here and why nothing is pre-seeded.
--
-- Additive. No existing table, column or row is touched, and an older binary
-- neither writes nor reads this, so it simply stays empty.
-- ============================================================================

CREATE TABLE IF NOT EXISTS metadata_attempts (
  anime_id     uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  source       text NOT NULL CHECK (source IN ('anilist-basic', 'anilist-deep', 'anilist-link')),
  outcome      text NOT NULL CHECK (outcome IN ('updated', 'unchanged', 'no_synopsis', 'not_found', 'locked', 'failed')),
  detail       text,
  attempts     integer NOT NULL DEFAULT 1,
  first_at     timestamptz NOT NULL DEFAULT now(),
  last_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (anime_id, source)
);

COMMENT ON TABLE metadata_attempts IS
  'What the last enrichment attempt did to each title. A title with no row here has never been attempted — that absence is the point.';
COMMENT ON COLUMN metadata_attempts.outcome IS
  'no_synopsis means AniList has no description, which is not a gap in this pipeline. not_found means the mapping points at nothing upstream.';

-- "What is still unexplained", which is the question the coverage panel asks.
CREATE INDEX IF NOT EXISTS metadata_attempts_outcome_idx ON metadata_attempts (source, outcome, last_at DESC);
