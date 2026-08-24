-- ============================================================================
-- 0022 — Hungarian text handling: accents, stemming, and alphabetical order
-- ============================================================================
-- Everything here exists because the audience types Hungarian, and Postgres
-- does none of this by default.
--
-- Three separate problems, three separate answers:
--
--   1. ACCENTS. Nobody types "támadás" on a phone — they type "tamadas". With
--      no help, that finds nothing. `unaccent` folds the accents away so both
--      spellings reach the same row.
--
--   2. STEMMING. The synopsis index is built with the 'english' dictionary.
--      On a Hungarian description that is simply the wrong language, and
--      Hungarian is heavily agglutinative, so the loss is larger than it
--      would be between two European languages. Hungarian text gets the
--      'hungarian' dictionary.
--
--   3. ORDER. The database sorts by byte value under a C collation, which puts
--      "Zebra" before "Álom". That is fixed per-query with COLLATE rather
--      than by changing the database default — see the comment at the bottom.
--
-- None of this works correctly unless the database is UTF8. That is enforced
-- in server/src/lib/db-encoding.ts, which refuses to create a schema on a
-- database that cannot store the text in the first place.
-- ============================================================================

-- ---------------------------------------------------------------- 1. unaccent

CREATE EXTENSION IF NOT EXISTS unaccent;

-- unaccent() is STABLE, not IMMUTABLE: it reads a dictionary that a superuser
-- could in principle reload, so Postgres refuses it in an index expression.
-- The standard answer is a wrapper that promises immutability. The promise is
-- kept as long as nobody edits unaccent.rules, which nothing here does.
--
-- Schema-qualified and with an empty search_path: an index expression calling
-- an unqualified function is a privilege-escalation route if someone can
-- create a same-named function in a schema earlier on the path.
CREATE OR REPLACE FUNCTION yume_unaccent (text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  STRICT
  SET search_path = ''
AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

COMMENT ON FUNCTION yume_unaccent (text) IS
  'Accent-folding for search. IMMUTABLE so it can be indexed — safe as long as the unaccent dictionary is not modified.';

-- ---------------------------------------------------------------- 2. configs

-- A text-search configuration that folds accents before stemming, so an index
-- built with it answers accent-insensitive queries without the caller having
-- to remember to wrap anything.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'hungarian_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION hungarian_unaccent (COPY = hungarian);
    ALTER TEXT SEARCH CONFIGURATION hungarian_unaccent
      ALTER MAPPING FOR hword, hword_part, word
      WITH unaccent, hungarian_stem;
  END IF;
END $$;

COMMENT ON TEXT SEARCH CONFIGURATION hungarian_unaccent IS
  'Hungarian stemming with accents folded first. Used for Hungarian synopses in anime_translations.';

-- The same for English, so a query typed without accents still matches an
-- English synopsis containing a loanword that has them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'english_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION english_unaccent (COPY = english);
    ALTER TEXT SEARCH CONFIGURATION english_unaccent
      ALTER MAPPING FOR hword, hword_part, word
      WITH unaccent, english_stem;
  END IF;
END $$;

-- ---------------------------------------------------------------- 3. indexes

-- Accent-folded trigram indexes alongside the existing ones. The existing
-- indexes are left untouched: an exact-accent query is still the better match
-- and should keep its index, this one only adds the fallback path.
--
-- pg_trgm is already installed (0002 created anime_synonyms_trgm).
CREATE INDEX IF NOT EXISTS anime_title_unaccent_trgm
  ON anime USING gin (yume_unaccent(canonical_title) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS anime_titles_unaccent_trgm
  ON anime_titles USING gin (yume_unaccent(title) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS anime_synonyms_unaccent_trgm
  ON anime_synonyms USING gin (yume_unaccent(synonym) gin_trgm_ops);

-- ---------------------------------------------------------------- 4. ordering

-- Deliberately NOT changing the database's default collation.
--
-- Changing it would rewrite every text index in the database and change the
-- meaning of every existing comparison, including ones where byte order is
-- exactly what is wanted (slugs, ids, tokens). Hungarian alphabetical order
-- is a display concern, so it belongs on the queries that produce a display
-- list:
--
--   ORDER BY a.canonical_title COLLATE "hu-HU-x-icu"
--
-- "hu-HU-x-icu" is an ICU collation and ships with the standard Postgres
-- build; server/test/hungarian-text.test.ts asserts it is present rather than
-- assuming it.
COMMENT ON COLUMN anime.canonical_title IS
  'Primary display title. For Hungarian alphabetical ordering use ORDER BY … COLLATE "hu-HU-x-icu" — the database default sorts by byte value.';
