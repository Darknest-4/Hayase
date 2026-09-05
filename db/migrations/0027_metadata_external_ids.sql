-- ============================================================================
-- 0027 — Give characters and people an external id, so the import can repeat
-- ============================================================================
-- `characters` and `people` were created with no external identifier and no
-- unique constraint on their names. That was survivable while nothing filled
-- them — and nothing did: the AniList enricher never asked for characters,
-- staff, relations or recommendations at all, so all four tables have been
-- empty since the schema was written.
--
-- Filling them without a stable key would be worse than leaving them empty:
-- names are not unique (there are several characters called "Akira", and two
-- people can share a name), so every re-run would insert the whole cast again.
-- The AniList id is the key the importer already works from.
--
-- Nullable, because a character or person added by hand through the admin has
-- no AniList id and must stay legal. UNIQUE ignores NULLs, so any number of
-- hand-made rows coexist with the imported ones.
-- ============================================================================

ALTER TABLE characters ADD COLUMN anilist_id integer UNIQUE;
ALTER TABLE people     ADD COLUMN anilist_id integer UNIQUE;

COMMENT ON COLUMN characters.anilist_id IS
  'AniList character id. The key the importer upserts on; NULL for rows created by hand.';
COMMENT ON COLUMN people.anilist_id IS
  'AniList staff id. The key the importer upserts on; NULL for rows created by hand.';

-- The credit tables are read by anime, and always in full: "the cast of this
-- show", never "every show this character is in" from this direction.
CREATE INDEX anime_characters_anime_idx ON anime_characters (anime_id);
CREATE INDEX anime_staff_anime_idx      ON anime_staff (anime_id, role);
CREATE INDEX character_voices_anime_idx ON character_voices (anime_id, language);
CREATE INDEX anime_recommendations_anime_idx
  ON anime_recommendations (anime_id, score DESC);
