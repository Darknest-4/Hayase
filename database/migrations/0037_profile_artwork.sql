-- Profile pictures and banners, chosen from the catalogue.
--
-- `avatar_key` and `banner_key` have been on user_profiles since 0001 and
-- nothing has ever written to them. They stay as they are — the resolved image
-- URL, which is what every read wants: drawing fifty comment authors must not
-- mean fifty joins to anime_images.
--
-- What is added is where the picture came from. Keeping the anime alongside the
-- URL is what lets the profile say "Frieren" under the picture, what lets a
-- re-import replace stale art, and what makes the choice auditable: a key with
-- no anime behind it was not chosen through the picker.
--
-- The pair is deliberately not a foreign key onto anime_images. That table is
-- rewritten wholesale by the AniList enrichment, so a reference into it would
-- be broken by a routine re-import; the anime survives that.

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS avatar_anime_id uuid REFERENCES anime(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS banner_anime_id uuid REFERENCES anime(id) ON DELETE SET NULL;

COMMENT ON COLUMN user_profiles.avatar_key IS
  'Resolved image URL for the profile picture. Written only from a catalogue image — never from client input.';
COMMENT ON COLUMN user_profiles.banner_key IS
  'Resolved image URL for the profile banner. Same rule as avatar_key.';
COMMENT ON COLUMN user_profiles.avatar_anime_id IS
  'Which title the profile picture came from, so the profile can name it.';

-- Reading a banner means asking for the widest art a title has. Covers exist
-- for everything; banners only appear as the AniList enrichment runs, so the
-- index covers both kinds and the query falls back.
CREATE INDEX IF NOT EXISTS anime_images_kind_idx ON anime_images (anime_id, kind, is_primary);
