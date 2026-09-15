-- ============================================================================
-- 0042 — translation runs
-- ============================================================================
-- The catalogue holds 32 390 titles, 20 984 of them with an English synopsis
-- and 7 587 356 characters between them. Translating that is not a request, it
-- is a job: measured against a self-hosted LibreTranslate on this box it runs
-- at ~335 characters a second, which is six and a quarter hours with all four
-- cores busy. Anything that takes six hours needs to be startable, watchable,
-- pausable and resumable, or nobody will ever dare press the button.
--
-- Its own table rather than a `kind` on metadata_runs. The two look alike and
-- are not: a metadata run talks to AniList and is gated on
-- `external_sync_enabled`, this one talks to a container on the same network
-- and is gated on nothing; and they must be able to run at different times
-- without one holding the other's single run slot.
--
-- `pace` is why this is not just a loop. A run that saturates the box for six
-- hours makes the site slow for six hours, so the operator chooses: `full`
-- uses everything and finishes soonest, `gentle` leaves headroom and takes
-- about twice as long. The default is gentle, because the failure mode of the
-- other one is "the site got slow and nobody knew why".
--
-- `publish` decides whether the results are visible or wait for review.
-- anime_translations.approved already exists for exactly this and the
-- localisation join already respects it (see catalogue/localise.ts), so an
-- unapproved row is invisible without dropping the anime from any result.
-- ============================================================================

CREATE TABLE IF NOT EXISTS translation_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  language     text NOT NULL DEFAULT 'hu',
  -- 'missing' skips anything already translated, which is what makes a
  -- cancelled run resumable: start it again and it picks up the remainder.
  scope        text NOT NULL DEFAULT 'missing' CHECK (scope IN ('missing', 'all')),
  pace         text NOT NULL DEFAULT 'gentle' CHECK (pace IN ('gentle', 'full')),
  publish      boolean NOT NULL DEFAULT false,
  max_items    integer CHECK (max_items IS NULL OR max_items > 0),
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  processed    integer NOT NULL DEFAULT 0,
  total        integer NOT NULL DEFAULT 0,
  translated   integer NOT NULL DEFAULT 0,
  failed       integer NOT NULL DEFAULT 0,
  chars        bigint NOT NULL DEFAULT 0,
  error        text,
  started_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

COMMENT ON TABLE translation_runs IS
  'One machine-translation pass over the catalogue. Long enough that it has to be resumable and cancellable.';
COMMENT ON COLUMN translation_runs.pace IS
  'gentle leaves CPU for the site and takes about twice as long; full saturates the box.';
COMMENT ON COLUMN translation_runs.publish IS
  'False writes drafts with approved=false, which the localisation join hides until an editor approves them.';

CREATE INDEX IF NOT EXISTS translation_runs_active_idx
  ON translation_runs (created_at DESC) WHERE status IN ('queued', 'running');

-- 'machine' is already a value anime_translations.source accepts; this only
-- makes the common lookup — "what still needs doing" — an index scan.
CREATE INDEX IF NOT EXISTS anime_translations_lang_idx
  ON anime_translations (language, anime_id);

INSERT INTO permissions (slug, description, "group", status)
VALUES ('translation.run', 'Start and cancel machine-translation passes', 'admin', 'active')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.slug IN ('admin', 'editor') AND p.slug = 'translation.run'
ON CONFLICT DO NOTHING;
