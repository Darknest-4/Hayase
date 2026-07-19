-- ============================================================================
-- 0002 — Anime catalogue: media, titles, people, episodes, relations, assets
-- ============================================================================
-- Design notes:
--  * `anime` is the aggregate root. Episodes, titles, images etc. reference it.
--  * External ids (AniList/MAL/AniDB/TVDB/TMDB/IMDB) live in anime_mappings —
--    the single most important table for extension search accuracy.
--  * Full documents for search live in OpenSearch; Postgres keeps a tsvector
--    as a fallback and for simple LIKE-free autocomplete.
--  * Genres are curated (fixed set), tags are folksonomy with per-anime rank.
-- ============================================================================

CREATE TYPE anime_format AS ENUM ('TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC');
CREATE TYPE anime_status AS ENUM ('NOT_YET_RELEASED', 'RELEASING', 'FINISHED', 'CANCELLED', 'HIATUS');
CREATE TYPE anime_season AS ENUM ('WINTER', 'SPRING', 'SUMMER', 'FALL');
CREATE TYPE age_rating   AS ENUM ('G', 'PG', 'PG_13', 'R', 'R_PLUS', 'RX');

-- ----------------------------------------------------------------------------
-- anime — one row per series/movie/OVA entry
-- ----------------------------------------------------------------------------
CREATE TABLE anime (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_title text NOT NULL,               -- denormalised preferred title for fast lists
  format         anime_format NOT NULL,
  status         anime_status NOT NULL,
  season         anime_season,
  season_year    smallint CHECK (season_year BETWEEN 1917 AND 2100),
  start_date     date,
  end_date       date,
  episode_count  smallint CHECK (episode_count >= 0),   -- planned total; null while unknown
  episode_duration smallint,                             -- minutes, typical episode
  age_rating     age_rating,
  is_adult       boolean NOT NULL DEFAULT false,
  synopsis       text,
  country        char(2) NOT NULL DEFAULT 'JP',
  source_material text,                                  -- 'MANGA', 'LIGHT_NOVEL', 'ORIGINAL', …
  average_score  numeric(4,1) CHECK (average_score BETWEEN 0 AND 100), -- denormalised from ratings
  ratings_count  integer NOT NULL DEFAULT 0,
  popularity     integer NOT NULL DEFAULT 0,             -- denormalised: list-adds, refreshed by worker
  trending       integer NOT NULL DEFAULT 0,             -- rolling activity score, refreshed hourly from Redis
  next_airing_at timestamptz,                            -- denormalised from episodes for cheap "airing soon"
  next_airing_ep smallint,
  search         tsvector,                               -- maintained by trigger below
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE anime IS 'Aggregate root of the catalogue. Denormalised score/popularity/next-airing keep hot list queries single-table.';
CREATE INDEX anime_browse_idx    ON anime (status, season_year DESC, popularity DESC);
CREATE INDEX anime_season_idx    ON anime (season_year, season) WHERE season IS NOT NULL;
CREATE INDEX anime_trending_idx  ON anime (trending DESC) WHERE trending > 0;
CREATE INDEX anime_airing_idx    ON anime (next_airing_at) WHERE next_airing_at IS NOT NULL;
CREATE INDEX anime_search_idx    ON anime USING gin (search);
CREATE INDEX anime_title_trgm    ON anime USING gin (canonical_title gin_trgm_ops);
CREATE TRIGGER anime_updated BEFORE UPDATE ON anime FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION anime_search_update() RETURNS trigger AS $$
BEGIN
  NEW.search = setweight(to_tsvector('simple', coalesce(NEW.canonical_title, '')), 'A')
             || setweight(to_tsvector('english', coalesce(NEW.synopsis, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER anime_search_trg BEFORE INSERT OR UPDATE OF canonical_title, synopsis ON anime
  FOR EACH ROW EXECUTE FUNCTION anime_search_update();

-- ----------------------------------------------------------------------------
-- anime_titles / anime_synonyms — localised titles and alternative names
-- ----------------------------------------------------------------------------
CREATE TABLE anime_titles (
  anime_id   uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('romaji', 'english', 'native', 'preferred')),
  title      text NOT NULL,
  PRIMARY KEY (anime_id, kind)
);
COMMENT ON TABLE anime_titles IS 'Primary titles per language form. Synonyms (fan names, abbreviations) go to anime_synonyms.';

CREATE TABLE anime_synonyms (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  anime_id   uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  synonym    text NOT NULL,
  UNIQUE (anime_id, synonym)
);
CREATE INDEX anime_synonyms_trgm ON anime_synonyms USING gin (synonym gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- anime_mappings — external ids; drives extension queries and importers
-- ----------------------------------------------------------------------------
CREATE TABLE anime_mappings (
  anime_id   uuid PRIMARY KEY REFERENCES anime(id) ON DELETE CASCADE,
  anilist_id integer UNIQUE,
  mal_id     integer UNIQUE,
  anidb_id   integer UNIQUE,
  kitsu_id   integer,
  tvdb_id    integer,
  tmdb_id    integer,
  imdb_id    text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE anime_mappings IS 'External-service id map. High-accuracy extension matching (anidb episode ids) depends on this being fresh.';
CREATE INDEX anime_mappings_tvdb_idx ON anime_mappings (tvdb_id) WHERE tvdb_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- genres (curated) and tags (ranked folksonomy)
-- ----------------------------------------------------------------------------
CREATE TABLE genres (
  id    smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug  text NOT NULL UNIQUE,
  name  text NOT NULL
);
CREATE TABLE anime_genres (
  anime_id uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  genre_id smallint NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  PRIMARY KEY (anime_id, genre_id)
);
CREATE INDEX anime_genres_genre_idx ON anime_genres (genre_id);

CREATE TABLE tags (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  category    text,                            -- 'theme', 'setting', 'demographic', 'content-warning'
  is_spoiler  boolean NOT NULL DEFAULT false,
  is_adult    boolean NOT NULL DEFAULT false
);
CREATE TABLE anime_tags (
  anime_id uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  tag_id   integer NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  rank     smallint NOT NULL DEFAULT 0 CHECK (rank BETWEEN 0 AND 100), -- relevance %
  PRIMARY KEY (anime_id, tag_id)
);
CREATE INDEX anime_tags_tag_idx ON anime_tags (tag_id, rank DESC);
COMMENT ON TABLE anime_tags IS 'Ranked tags; rank powers "more like this" scoring together with genres.';

-- ----------------------------------------------------------------------------
-- companies — studios, producers, publishers, licensors in one table
-- ----------------------------------------------------------------------------
CREATE TABLE companies (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name     text NOT NULL,
  country  char(2),
  logo_key text,
  UNIQUE (name, country)
);
CREATE TABLE anime_companies (
  anime_id   uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('studio', 'producer', 'publisher', 'licensor')),
  is_main    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (anime_id, company_id, role)
);
COMMENT ON TABLE anime_companies IS 'Studio/producer/publisher/licensor credits; role column replaces four join tables.';
CREATE INDEX anime_companies_company_idx ON anime_companies (company_id);

-- ----------------------------------------------------------------------------
-- people, characters, credits
-- ----------------------------------------------------------------------------
CREATE TABLE people (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  native_name text,
  image_key  text,
  birthday   date,
  bio        text
);
COMMENT ON TABLE people IS 'Voice actors and production staff share this table; the credit tables define the role.';

CREATE TABLE characters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  native_name text,
  image_key   text,
  description text
);

CREATE TABLE anime_characters (
  anime_id     uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('MAIN', 'SUPPORTING', 'BACKGROUND')),
  PRIMARY KEY (anime_id, character_id)
);

CREATE TABLE character_voices (
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  anime_id     uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  person_id    uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  language     text NOT NULL DEFAULT 'ja',
  PRIMARY KEY (character_id, anime_id, person_id, language)
);
COMMENT ON TABLE character_voices IS 'Voice credits are per anime AND per language (dubs).';

CREATE TABLE anime_staff (
  anime_id  uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role      text NOT NULL,                     -- 'Director', 'Original Creator', 'Character Design', …
  PRIMARY KEY (anime_id, person_id, role)
);

-- ----------------------------------------------------------------------------
-- episodes — one row per episode; movies get a single episode row
-- ----------------------------------------------------------------------------
CREATE TABLE episodes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anime_id     uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  number       numeric(6,1) NOT NULL,          -- numeric: supports 6.5 recap episodes
  absolute_number integer,                     -- continuous numbering across seasons
  title        text,
  synopsis     text,
  thumbnail_key text,
  air_date     timestamptz,
  duration     smallint,                       -- minutes
  is_filler    boolean NOT NULL DEFAULT false,
  is_recap     boolean NOT NULL DEFAULT false,
  anidb_eid    integer,                        -- per-episode external ids for extension matching
  tvdb_eid     integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (anime_id, number)
);
COMMENT ON TABLE episodes IS 'Episode metadata incl. filler flags and per-episode external ids (anidb_eid = high-accuracy source matching).';
CREATE INDEX episodes_air_idx ON episodes (air_date DESC) WHERE air_date IS NOT NULL;
CREATE TRIGGER episodes_updated BEFORE UPDATE ON episodes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- anime_relations — typed edges between entries (sequel, prequel, side story…)
-- ----------------------------------------------------------------------------
CREATE TABLE anime_relations (
  anime_id    uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  related_id  uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  relation    text NOT NULL CHECK (relation IN ('SEQUEL', 'PREQUEL', 'SIDE_STORY', 'PARENT', 'SUMMARY', 'ALTERNATIVE', 'SPIN_OFF', 'ADAPTATION', 'OTHER')),
  PRIMARY KEY (anime_id, related_id, relation),
  CHECK (anime_id <> related_id)
);
COMMENT ON TABLE anime_relations IS 'Directed relation graph; the relation tree UI walks this recursively (WITH RECURSIVE).';
CREATE INDEX anime_relations_related_idx ON anime_relations (related_id);

-- ----------------------------------------------------------------------------
-- anime_recommendations — curated/derived "if you liked X" pairs
-- ----------------------------------------------------------------------------
CREATE TABLE anime_recommendations (
  anime_id       uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  recommended_id uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  score          integer NOT NULL DEFAULT 0,   -- votes + model weight; ordering key
  source         text NOT NULL DEFAULT 'model' CHECK (source IN ('model', 'community', 'import')),
  PRIMARY KEY (anime_id, recommended_id),
  CHECK (anime_id <> recommended_id)
);
COMMENT ON TABLE anime_recommendations IS 'Static recommendation edges; personalised AI recs are computed in the rec worker and cached in Redis.';

-- ----------------------------------------------------------------------------
-- media assets: images (covers/banners/screenshots) and videos (trailers/PVs)
-- ----------------------------------------------------------------------------
CREATE TABLE anime_images (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anime_id  uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  kind      text NOT NULL CHECK (kind IN ('cover', 'banner', 'screenshot', 'logo')),
  object_key text NOT NULL,                    -- object-storage key; CDN URL is derived
  width     integer,
  height    integer,
  blurhash  text,                              -- placeholder while loading
  dominant_color text,                         -- hex, for UI accents
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE anime_images IS 'All artwork lives in object storage; this table stores keys + render hints (blurhash, dominant color).';
CREATE INDEX anime_images_lookup_idx ON anime_images (anime_id, kind);
CREATE UNIQUE INDEX anime_images_primary_idx ON anime_images (anime_id, kind) WHERE is_primary;

CREATE TABLE anime_videos (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anime_id  uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  kind      text NOT NULL CHECK (kind IN ('trailer', 'pv', 'opening', 'ending', 'clip')),
  provider  text NOT NULL CHECK (provider IN ('youtube', 'storage')),
  ref       text NOT NULL,                     -- youtube id or object-storage key
  title     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX anime_videos_anime_idx ON anime_videos (anime_id);
