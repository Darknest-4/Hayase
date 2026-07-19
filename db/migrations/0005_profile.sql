-- ============================================================================
-- 0005 — Profile features: lists, collections, ratings, reviews, gamification
-- ============================================================================
-- Design notes:
--  * library_entries is the canonical "my anime list" (status + progress +
--    score in one row) — the same shape AniList/MAL sync maps onto.
--  * custom_lists are ordered, shareable lists; collections are folders of
--    lists. favorites is its own tiny table (hot path, simple semantics).
--  * XP/levels are derived: xp_events is the ledger, profile_stats caches
--    the aggregates. Never update a total without writing the event.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- library_entries — per-profile anime list (watching/planning/completed…)
-- ----------------------------------------------------------------------------
CREATE TYPE library_status AS ENUM ('WATCHING', 'PLANNING', 'COMPLETED', 'PAUSED', 'DROPPED', 'REWATCHING');

CREATE TABLE library_entries (
  profile_id  uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  anime_id    uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  status      library_status NOT NULL DEFAULT 'PLANNING',
  progress    smallint NOT NULL DEFAULT 0 CHECK (progress >= 0),
  score       numeric(3,1) CHECK (score BETWEEN 0 AND 10),
  rewatches   smallint NOT NULL DEFAULT 0,
  notes       text CHECK (length(notes) <= 2000),
  started_at  date,
  finished_at date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, anime_id)
);
COMMENT ON TABLE library_entries IS 'The anime list. One row per (profile, anime); status transitions drive continue-watching and sync.';
CREATE INDEX library_entries_status_idx ON library_entries (profile_id, status, updated_at DESC);
CREATE INDEX library_entries_anime_idx  ON library_entries (anime_id, status); -- popularity aggregation
CREATE TRIGGER library_entries_updated BEFORE UPDATE ON library_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- favorites — hearts on anime/characters/people/studios
-- ----------------------------------------------------------------------------
CREATE TABLE favorites (
  profile_id   uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('anime', 'character', 'person', 'company')),
  subject_id   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, subject_type, subject_id)
);
COMMENT ON TABLE favorites IS 'Hearted entities of any supported type; ordering on the profile page = created_at.';
CREATE INDEX favorites_subject_idx ON favorites (subject_type, subject_id); -- favourite counts

-- ----------------------------------------------------------------------------
-- custom_lists — ordered, shareable lists; collections group lists
-- ----------------------------------------------------------------------------
CREATE TABLE custom_lists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description text CHECK (length(description) <= 2000),
  cover_key   text,
  visibility  text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unlisted', 'public')),
  item_count  integer NOT NULL DEFAULT 0,      -- denormalised
  like_count  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX custom_lists_profile_idx ON custom_lists (profile_id);
CREATE INDEX custom_lists_public_idx  ON custom_lists (like_count DESC) WHERE visibility = 'public';
CREATE TRIGGER custom_lists_updated BEFORE UPDATE ON custom_lists FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE custom_list_items (
  list_id   uuid NOT NULL REFERENCES custom_lists(id) ON DELETE CASCADE,
  anime_id  uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  position  integer NOT NULL,                  -- explicit ordering; sparse (100, 200…) to allow cheap inserts
  note      text CHECK (length(note) <= 500),
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, anime_id)
);
CREATE INDEX custom_list_items_pos_idx ON custom_list_items (list_id, position);

CREATE TABLE collections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  visibility  text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unlisted', 'public')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE collections IS 'Folders of custom lists ("Seasonal picks 2026" containing per-season lists).';

CREATE TABLE collection_lists (
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  list_id       uuid NOT NULL REFERENCES custom_lists(id) ON DELETE CASCADE,
  position      integer NOT NULL,
  PRIMARY KEY (collection_id, list_id)
);

CREATE TABLE list_likes (
  list_id   uuid NOT NULL REFERENCES custom_lists(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, user_id)
);

-- ----------------------------------------------------------------------------
-- ratings & reviews
-- ----------------------------------------------------------------------------
-- Quick score lives on library_entries.score. reviews are long-form.
CREATE TABLE reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  anime_id    uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  score       numeric(3,1) NOT NULL CHECK (score BETWEEN 0 AND 10),
  title       text CHECK (length(title) <= 150),
  body        text NOT NULL CHECK (length(body) BETWEEN 100 AND 30000),
  spoiler     boolean NOT NULL DEFAULT false,
  helpful_count integer NOT NULL DEFAULT 0,    -- denormalised from review_votes
  hidden_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, anime_id)
);
COMMENT ON TABLE reviews IS 'Long-form reviews, one per profile per anime. Short scoring stays on library_entries.';
CREATE INDEX reviews_anime_idx ON reviews (anime_id, helpful_count DESC) WHERE hidden_at IS NULL;
CREATE TRIGGER reviews_updated BEFORE UPDATE ON reviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE review_votes (
  review_id uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  helpful   boolean NOT NULL,
  PRIMARY KEY (review_id, user_id)
);

-- ----------------------------------------------------------------------------
-- gamification: achievements, badges, XP ledger, cached stats
-- ----------------------------------------------------------------------------
CREATE TABLE achievements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,            -- 'first-episode', 'marathon-24h', 'century-club'
  name        text NOT NULL,
  description text NOT NULL,
  icon_key    text,
  xp_reward   integer NOT NULL DEFAULT 0,
  hidden      boolean NOT NULL DEFAULT false   -- secret achievements
);
COMMENT ON TABLE achievements IS 'Achievement definitions; unlock conditions are evaluated by the stats worker.';

CREATE TABLE profile_achievements (
  profile_id     uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  achievement_id uuid NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  unlocked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, achievement_id)
);

CREATE TABLE badges (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug     text NOT NULL UNIQUE,               -- 'early-adopter', 'extension-dev', 'moderator'
  name     text NOT NULL,
  icon_key text
);
CREATE TABLE user_badges (
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id uuid NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, badge_id)
);
COMMENT ON TABLE user_badges IS 'Badges are account-level (unlike achievements, which are per-profile).';

CREATE TABLE xp_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  amount     integer NOT NULL,
  reason     text NOT NULL,                    -- 'episode_watched', 'review_written', 'achievement', 'daily_login'
  ref_id     uuid,                             -- optional pointer to the triggering entity
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE xp_events IS 'Append-only XP ledger. Totals/levels are derived, cached in profile_stats.';
CREATE INDEX xp_events_profile_idx ON xp_events (profile_id, created_at DESC);

CREATE TABLE profile_stats (
  profile_id       uuid PRIMARY KEY REFERENCES user_profiles(id) ON DELETE CASCADE,
  xp_total         bigint NOT NULL DEFAULT 0,
  level            integer NOT NULL DEFAULT 1,  -- level = floor(sqrt(xp/100)) + 1, computed by worker
  minutes_watched  bigint NOT NULL DEFAULT 0,
  episodes_watched integer NOT NULL DEFAULT 0,
  anime_completed  integer NOT NULL DEFAULT 0,
  mean_score       numeric(4,2),
  genre_breakdown  jsonb NOT NULL DEFAULT '{}', -- {"Action": 1200, …} minutes per genre
  updated_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE profile_stats IS 'Materialised per-profile statistics, recomputed incrementally by the stats worker from watch_history and xp_events.';
