-- Metadata synchronisation runs.
--
-- Enriching the catalogue from AniList was a shell command: someone with SSH
-- access ran `scripts/import-anilist.ts`, watched it print, and that was the
-- entire interface. Nothing recorded that a run had happened, how far it got,
-- or what it changed, so "is the metadata up to date?" had no answer short of
-- counting rows by hand — and an operator without a terminal could not start
-- one at all.
--
-- One row per run, written by the worker as it goes, so the administration
-- panel can show a live one and the history behind it.

CREATE TABLE IF NOT EXISTS metadata_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'basic' is the scalar pass (synopsis, art, score, genres); 'deep' is the
  -- cast/staff/relations pass, which asks for far more per title.
  kind         text NOT NULL CHECK (kind IN ('basic', 'deep')),
  -- 'missing' only touches rows that have nothing yet; 'all' re-fetches.
  scope        text NOT NULL CHECK (scope IN ('missing', 'all')),
  max_items    integer CHECK (max_items IS NULL OR max_items > 0),
  status       text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  processed    integer NOT NULL DEFAULT 0,
  total        integer NOT NULL DEFAULT 0,
  updated_rows integer NOT NULL DEFAULT 0,
  -- Per-kind tallies: {updated} for basic, {characters, voices, staff, …} for
  -- deep. jsonb because the two passes count different things and neither set
  -- is worth a column apiece.
  counts       jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text,
  -- Who asked for it. ON DELETE SET NULL: deleting an account must not delete
  -- the record that the catalogue was touched.
  started_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

CREATE INDEX IF NOT EXISTS metadata_runs_recent ON metadata_runs (created_at DESC);

-- At most one run may be queued or running.
--
-- Not a nicety: AniList is rate-limited and the pass is paced to stay under
-- that limit. Two runs at once would double the request rate and get the
-- deployment throttled — the provider's limit is the provider's decision, and
-- the way to respect it is to make exceeding it impossible rather than to ask
-- operators not to press the button twice.
CREATE UNIQUE INDEX IF NOT EXISTS metadata_runs_one_active
  ON metadata_runs ((true)) WHERE status IN ('queued', 'running');
