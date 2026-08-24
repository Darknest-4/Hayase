-- ============================================================================
-- 0023 — Hungarian catalogue text, kept where the importer cannot reach it
-- ============================================================================
-- The catalogue holds 25,703 English synopses and zero Hungarian ones. That is
-- not something an import can fix — a Hungarian description is written by a
-- person — so this is storage for editorial work, and its shape follows from
-- that one fact.
--
-- WHY NOT anime_titles
--
-- The obvious move is `kind = 'hungarian'` in anime_titles: the table exists
-- and only its CHECK constraint would need widening. It is the wrong home, and
-- the reason is decisive rather than aesthetic.
--
-- anime_titles is the importer's territory. Every re-import rewrites it. A
-- Hungarian title written by hand would survive exactly until the next AniList
-- sync and then vanish, with nothing to show what happened. The project
-- already knows this problem — anime.locked_fields exists, and
-- server/src/lib/metadata.ts opens with "fields a human edited. Automatic
-- sources never overwrite them."
--
-- So: human text lives in its own table, which no importer writes.
--
-- WHY AN OVERLAY RATHER THAN COLUMNS
--
-- Sparse. It starts empty and only ever holds what somebody actually wrote —
-- 25,703 rows are not duplicated so that forty of them can have a Hungarian
-- description. A third language later needs no schema change.
--
-- Reading is a LEFT JOIN with COALESCE: the translation when there is one, the
-- base row when there is not. Nothing 404s for want of a translation.
-- ============================================================================

-- ---------------------------------------------------------------- 1. anime

CREATE TABLE IF NOT EXISTS anime_translations (
  anime_id    uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  language    text NOT NULL CHECK (language IN ('hu', 'en')),
  title       text,
  synopsis    text,

  -- Where the text came from. 'editorial' is a person; 'machine' is a draft
  -- that a person has not approved yet. The distinction is here from the start
  -- so that machine drafts can never be mistaken for reviewed text later —
  -- retrofitting it after the fact is how a catalogue ends up unable to say
  -- which of its descriptions anyone actually read.
  source      text NOT NULL DEFAULT 'editorial' CHECK (source IN ('editorial', 'machine', 'import')),

  -- Machine drafts are written but not shown. Same principle as migration
  -- 0020: the safe state is "not published", and publishing is a decision.
  approved    boolean NOT NULL DEFAULT true,

  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (anime_id, language),

  -- A row with neither field is not a translation, it is a stray record that
  -- makes the "missing translations" queue lie about its own size.
  CONSTRAINT anime_translations_not_empty CHECK (title IS NOT NULL OR synopsis IS NOT NULL)
);

COMMENT ON TABLE anime_translations IS
  'Human-written catalogue text per language. Sparse overlay over anime; the importer never writes here, so editorial work survives a re-import (contrast anime_titles, which is rewritten on every sync).';
COMMENT ON COLUMN anime_translations.approved IS
  'False for an unreviewed machine draft. Reads filter on this, so a draft is stored but never served.';

CREATE INDEX IF NOT EXISTS anime_translations_language_idx
  ON anime_translations (language) WHERE approved;

-- ---------------------------------------------------------------- 2. episodes

CREATE TABLE IF NOT EXISTS episode_translations (
  episode_id  uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  language    text NOT NULL CHECK (language IN ('hu', 'en')),
  title       text,
  synopsis    text,
  source      text NOT NULL DEFAULT 'editorial' CHECK (source IN ('editorial', 'machine', 'import')),
  approved    boolean NOT NULL DEFAULT true,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (episode_id, language),
  CONSTRAINT episode_translations_not_empty CHECK (title IS NOT NULL OR synopsis IS NOT NULL)
);

COMMENT ON TABLE episode_translations IS
  'Human-written episode text per language. Same contract as anime_translations.';

CREATE INDEX IF NOT EXISTS episode_translations_language_idx
  ON episode_translations (language) WHERE approved;

-- ---------------------------------------------------------------- 3. search

-- Translated text has to be searchable, or a Hungarian description is
-- invisible to the one audience it was written for.
--
-- Per-language stemming: the base anime.search vector uses the 'english'
-- dictionary, which is simply the wrong language for Hungarian, and Hungarian
-- is agglutinative enough that the loss is larger than it would be between two
-- European languages. Migration 0022 created the accent-folding configurations
-- this uses.
ALTER TABLE anime_translations
  ADD COLUMN IF NOT EXISTS search tsvector;

CREATE OR REPLACE FUNCTION anime_translations_search_update ()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  config regconfig;
BEGIN
  config := CASE NEW.language
              WHEN 'hu' THEN 'hungarian_unaccent'::regconfig
              ELSE 'english_unaccent'::regconfig
            END;
  -- The title outranks the synopsis, matching the weights the base vector uses.
  NEW.search :=
      setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A')
   || setweight(to_tsvector(config, coalesce(NEW.synopsis, '')), 'C');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS anime_translations_search ON anime_translations;
CREATE TRIGGER anime_translations_search
  BEFORE INSERT OR UPDATE OF title, synopsis, language ON anime_translations
  FOR EACH ROW EXECUTE FUNCTION anime_translations_search_update();

CREATE INDEX IF NOT EXISTS anime_translations_search_idx
  ON anime_translations USING gin (search);

-- ---------------------------------------------------------------- 4. queue

-- "What still needs translating, most-watched first" is the question an editor
-- opens the admin panel to ask, and answering it from scratch every time means
-- a NOT EXISTS over the whole catalogue. As a view it stays one place to fix.
CREATE OR REPLACE VIEW anime_missing_translations AS
  SELECT a.id,
         a.canonical_title,
         a.popularity,
         a.visibility,
         m.anilist_id,
         (t.title IS NOT NULL)    AS has_title,
         (t.synopsis IS NOT NULL) AS has_synopsis
    FROM anime a
    LEFT JOIN anime_mappings m ON m.anime_id = a.id
    LEFT JOIN anime_translations t ON t.anime_id = a.id AND t.language = 'hu' AND t.approved
   WHERE t.anime_id IS NULL OR t.synopsis IS NULL;

COMMENT ON VIEW anime_missing_translations IS
  'Titles with no approved Hungarian description. Ordered by popularity at the call site so effort goes where the most people will see it.';
