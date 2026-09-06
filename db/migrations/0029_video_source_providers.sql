-- Video sources an operator registers by hand, from any provider.
--
-- `video_sources` has existed since 0003 and nothing ever wrote to it. The
-- table was designed for an extension to fill: a torrent hash or a URL that a
-- provider plug-in discovered, with health data attached. That left the
-- platform with exactly two ways to play anything — a loaded extension, or a
-- URL pasted into the player by the viewer — and neither is something an
-- operator can curate.
--
-- These columns are what a hand-registered source needs that a discovered one
-- did not: who it is from, whether it is currently to be used, and in what
-- order to try it. Every one is nullable or defaulted, so rows written by the
-- old shape stay valid.

ALTER TABLE video_sources
  -- The provider's name as the viewer should see it. Free text on purpose:
  -- "any provider" means the set is not ours to enumerate, and an enum here
  -- would need a migration every time an operator adds a mirror.
  ADD COLUMN IF NOT EXISTS provider  text,
  -- A dead link is worth keeping while it is being fixed. Deleting is how you
  -- lose the note about which episode it belonged to.
  ADD COLUMN IF NOT EXISTS enabled   boolean NOT NULL DEFAULT true,
  -- Lower is tried first. Same default for everything means the ordering falls
  -- back to what the table already sorted by.
  ADD COLUMN IF NOT EXISTS priority  smallint NOT NULL DEFAULT 0,
  -- Provenance. ON DELETE SET NULL: removing an account must not remove the
  -- sources it registered.
  ADD COLUMN IF NOT EXISTS added_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  -- The audio language, and whether this is a subbed, dubbed or raw release.
  -- audio_tracks can say it in more detail; this is the one line the player's
  -- variant switch reads, and most hand-added sources will never have a track
  -- list attached.
  ADD COLUMN IF NOT EXISTS language  text,
  ADD COLUMN IF NOT EXISTS variant   text;

ALTER TABLE video_sources
  DROP CONSTRAINT IF EXISTS video_sources_variant_check;
ALTER TABLE video_sources
  ADD CONSTRAINT video_sources_variant_check
  CHECK (variant IS NULL OR variant IN ('sub', 'dub', 'raw'));

-- 'embed' joins the transports: a provider that only offers a player page
-- rather than a media URL is the common case outside torrents, and the schema
-- refusing to record one does not make it go away — it just means the operator
-- writes it somewhere the platform cannot see.
ALTER TABLE video_sources
  DROP CONSTRAINT IF EXISTS video_sources_kind_check;
ALTER TABLE video_sources
  ADD CONSTRAINT video_sources_kind_check
  CHECK (kind IN ('torrent', 'http', 'nzb', 'embed'));

-- `title` was NOT NULL because a discovered source always has a release name.
-- A hand-added one often has nothing but a provider and a link, and forcing
-- the operator to invent a title is how you get a column full of "1080p".
ALTER TABLE video_sources ALTER COLUMN title DROP NOT NULL;

COMMENT ON TABLE video_sources IS
  'Playable references — hand-registered by operators or discovered by extensions. Never stores media, only pointers.';
COMMENT ON COLUMN video_sources.provider IS
  'Provider name as shown to the viewer. Free text: the set of providers is not ours to enumerate.';
COMMENT ON COLUMN video_sources.enabled IS
  'False takes a source out of playback without losing the record of it.';

-- What playback asks for: the enabled sources of one episode, best first.
CREATE INDEX IF NOT EXISTS video_sources_playable_idx
  ON video_sources (episode_id, priority, created_at) WHERE enabled;
