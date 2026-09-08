-- ============================================================================
-- 0020 — Nothing imported is published until somebody publishes it
-- ============================================================================
-- This platform serves a Hungarian audience, and a Hungarian subtitle does not
-- exist the moment an episode airs — it arrives days later. An import that
-- lands straight on the public surface therefore advertises episodes nobody
-- can watch, which is worse than not listing them at all.
--
-- Two changes, both in the same direction: the safe state is "not published",
-- and publishing is a decision somebody makes.
--
--   1. anime.visibility defaulted to 'public', so an automatic import was
--      live the instant the row was written. The default becomes 'hidden'.
--
--   2. episodes had no visibility at all — an episode was watchable the moment
--      it existed, which is precisely the case this is about. It gets the same
--      three states the anime aggregate uses, so operators learn one
--      vocabulary rather than two.
--
-- Existing rows keep their current surface state. A migration that silently
-- un-published live content would be a far worse failure than the one it is
-- fixing.
-- ============================================================================

-- ---------------------------------------------------------------- 1. anime

-- Existing rows are untouched: ALTER … SET DEFAULT applies to future inserts.
ALTER TABLE anime ALTER COLUMN visibility SET DEFAULT 'hidden';

COMMENT ON COLUMN anime.visibility IS
  'Editorial surface state. public = everywhere; unlisted = direct link only; hidden = nowhere (detail 404). Defaults to hidden: an automatic import is not published until a human publishes it.';

-- ---------------------------------------------------------------- 2. episodes

ALTER TABLE episodes
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'hidden'
    CHECK (visibility IN ('public', 'unlisted', 'hidden'));

-- Everything that already exists was already watchable. Publishing state is
-- new information, and inventing "unpublished" for content that has been live
-- would pull it out from under viewers mid-season.
UPDATE episodes SET visibility = 'public' WHERE visibility = 'hidden';

COMMENT ON COLUMN episodes.visibility IS
  'Editorial surface state, same vocabulary as anime.visibility. public = listed and playable; unlisted = playable by direct link, not listed; hidden = unavailable. Defaults to hidden so an imported episode is not offered before its subtitle exists.';

-- The public episode list is the hottest read on the watch page and now
-- carries a filter, so it gets an index that answers it in order.
CREATE INDEX IF NOT EXISTS episodes_public_idx
  ON episodes (anime_id, number) WHERE visibility = 'public';

-- ---------------------------------------------------------------- 3. audit

-- Publishing and un-publishing are editorial acts, and "who put this live"
-- is exactly the question asked afterwards. The action names are added here
-- so the audit vocabulary lives with the schema it describes.
COMMENT ON TABLE audit_logs IS
  'Editorial and administrative actions. Includes anime.visibility and episode.visibility changes — publishing is an act somebody is accountable for.';
