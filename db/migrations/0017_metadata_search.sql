-- ============================================================================
-- 0017 — Metadata provenance & conflict resolution, plus search indexes
-- ============================================================================
-- Two problems this fixes:
--
--  1. Importers blindly overwrote canonical data. The AniList enricher ran
--     `canonical_title = coalesce($new, canonical_title)`, so a value an
--     administrator had corrected by hand was silently replaced on the next
--     import. Fields now carry provenance, and anything edited by a human is
--     locked against automatic sources.
--
--  2. Search never looked at anime_titles. Romaji, English and native titles
--     were invisible to the search endpoint even though they were stored, and
--     there were no indexes to match them efficiently.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- provenance: who last set each field, and which fields a human owns
-- ----------------------------------------------------------------------------
ALTER TABLE anime
  ADD COLUMN locked_fields text[] NOT NULL DEFAULT '{}',
  ADD COLUMN metadata_sources jsonb NOT NULL DEFAULT '{}';

COMMENT ON COLUMN anime.locked_fields IS
  'Fields edited by a human through the catalogue admin. Automatic importers must never overwrite these.';
COMMENT ON COLUMN anime.metadata_sources IS
  'Provenance per field: {"synopsis": {"provider": "anilist", "at": "2026-08-21T..."}}. Drives precedence between providers.';

-- ----------------------------------------------------------------------------
-- search: exact-match and fuzzy indexes over every title form
-- ----------------------------------------------------------------------------
-- Exact matches are the top ranking tier, so they need to be index lookups
-- rather than sequential scans over 25k rows.
CREATE INDEX anime_canonical_lower_idx ON anime (lower(canonical_title));
CREATE INDEX anime_titles_lower_idx    ON anime_titles (lower(title));
CREATE INDEX anime_synonyms_lower_idx  ON anime_synonyms (lower(synonym));

-- Fuzzy matching over alternative titles — anime_synonyms already had this,
-- anime_titles did not, which is why romaji/english/native never matched.
CREATE INDEX anime_titles_trgm ON anime_titles USING gin (title gin_trgm_ops);

-- Popularity is the final tiebreak in every search tier.
CREATE INDEX anime_popularity_idx ON anime (popularity DESC) WHERE visibility = 'public';

-- ----------------------------------------------------------------------------
-- duplicate detection support
-- ----------------------------------------------------------------------------
-- Candidate pairs are found by title similarity within the same year/format,
-- which needs the trigram index above plus this to narrow the scan.
CREATE INDEX anime_year_format_idx ON anime (season_year, format) WHERE season_year IS NOT NULL;

-- anime.merge is now enforced by the duplicate/merge routes, so it becomes
-- live. Only permissions a route actually checks are marked active — a slug
-- nothing enforces stays 'planned' so the Roles admin never claims otherwise.
UPDATE permissions SET status = 'active' WHERE slug = 'anime.merge';
