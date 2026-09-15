-- ============================================================================
-- 0043 — a third metadata pass, and somewhere to put what it finds
-- ============================================================================
-- The catalogue holds one cover and one banner per title and nothing else, so
-- an artwork gallery would have two pictures in it. The reference site shows
-- a hundred, because it reads TheTVDB.
--
-- TheTVDB's own API needs a key, and our `anime_mappings.tvdb_id` column is
-- empty in all 32 390 rows — so that route starts with an identity problem,
-- not an artwork one.
--
-- ani.zip solves both at once, free and without a key. One request per AniList
-- id returns thetvdb_id, themoviedb_id, imdb_id, anidb_id and kitsu_id; four
-- artworks served from artworks.thetvdb.com; per-episode titles, air dates,
-- runtimes, overviews and thumbnails; and series titles in about forty
-- languages, Hungarian among them. Measured at five parallel requests it is
-- roughly five minutes for the 22 418 titles that have an AniList id.
--
-- ---- what this migration adds ----------------------------------------------
--
-- `backdrop` as an image kind. ani.zip's `Fanart` is a wide background image,
-- and the nearest existing kind is `screenshot`, which means a still from an
-- episode. Two different things should not share a name in a column that
-- decides what a page renders.
--
-- `artwork` as a metadata run kind, so the pass is startable, watchable and
-- cancellable from the same panel as the other two rather than being a script
-- somebody has to remember.
-- ============================================================================

ALTER TABLE anime_images DROP CONSTRAINT IF EXISTS anime_images_kind_check;
ALTER TABLE anime_images ADD CONSTRAINT anime_images_kind_check
  CHECK (kind IN ('cover', 'banner', 'screenshot', 'logo', 'backdrop'));

COMMENT ON COLUMN anime_images.kind IS
  'cover and banner are the primary pair. logo is the series wordmark (transparent). backdrop is wide key art. screenshot is a still from an episode.';

ALTER TABLE metadata_runs DROP CONSTRAINT IF EXISTS metadata_runs_kind_check;
ALTER TABLE metadata_runs ADD CONSTRAINT metadata_runs_kind_check
  CHECK (kind IN ('basic', 'deep', 'artwork'));

-- The pass asks "which titles have no logo yet", which is this index.
CREATE INDEX IF NOT EXISTS anime_images_kind_idx ON anime_images (kind, anime_id);
