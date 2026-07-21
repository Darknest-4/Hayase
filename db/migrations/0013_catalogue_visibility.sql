-- ============================================================================
-- 0013 — Catalogue visibility: hide / unlist anime from the public surface
-- ============================================================================
-- Adds an editorial visibility state to the anime aggregate so operators can
-- pull an entry out of the public catalogue without deleting it:
--   * public   — surfaced everywhere (browse, search, schedule, detail)
--   * unlisted — reachable by direct link only; hidden from browse/search/schedule
--   * hidden   — invisible everywhere, including the detail endpoint (404)
-- Public read paths filter on this column; the admin catalogue editor ignores
-- it so staff can still find and restore hidden rows.
-- ============================================================================

ALTER TABLE anime
  ADD COLUMN visibility text NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'unlisted', 'hidden'));

COMMENT ON COLUMN anime.visibility IS
  'Editorial surface state. public = everywhere; unlisted = direct link only; hidden = nowhere (detail 404). Public read paths filter on it.';

-- Hot list queries already filter (status, popularity …); keep the public
-- filter cheap by indexing the common case (everything that IS surfaced).
CREATE INDEX anime_visible_idx ON anime (popularity DESC) WHERE visibility = 'public';
