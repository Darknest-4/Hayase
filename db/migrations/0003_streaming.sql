-- ============================================================================
-- 0003 — Streaming: sources, tracks, watch progress/history, skip data
-- ============================================================================
-- Design notes:
--  * The platform hosts no content. video_sources stores *references*
--    resolved by extensions (torrent hash, external URL) plus their health.
--  * watch_progress is the hottest write path in the system: one row per
--    (profile, episode), updated every ~10s during playback through Redis
--    write-behind (see docs/architecture.md).
--  * watch_history is append-only and separate from progress: progress is
--    "where am I", history is "what did I do".
-- ============================================================================

-- ----------------------------------------------------------------------------
-- video_sources — playable references discovered by extensions
-- ----------------------------------------------------------------------------
CREATE TABLE video_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id    uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  extension_id  uuid,                          -- FK to extensions added in 0006 (created later)
  kind          text NOT NULL CHECK (kind IN ('torrent', 'http', 'nzb')),
  ref           text NOT NULL,                 -- info hash / URL / nzb id
  title         text NOT NULL,                 -- release name as published
  resolution    text CHECK (resolution IN ('2160', '1080', '720', '540', '480')),
  codec         text,                          -- 'h264', 'hevc', 'av1'
  size_bytes    bigint,
  seeders       integer,
  leechers      integer,
  accuracy      text NOT NULL DEFAULT 'medium' CHECK (accuracy IN ('high', 'medium', 'low')),
  is_batch      boolean NOT NULL DEFAULT false,
  published_at  timestamptz,
  last_checked_at timestamptz,                 -- health-check worker timestamp
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (episode_id, kind, ref)
);
COMMENT ON TABLE video_sources IS 'Extension-resolved playable references with health data. Never stores media, only pointers.';
CREATE INDEX video_sources_episode_idx ON video_sources (episode_id, accuracy, seeders DESC NULLS LAST);

-- mirrors: alternative endpoints for an http source (region failover)
CREATE TABLE source_mirrors (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id  uuid NOT NULL REFERENCES video_sources(id) ON DELETE CASCADE,
  url        text NOT NULL,
  region     char(2),
  priority   smallint NOT NULL DEFAULT 0,
  healthy    boolean NOT NULL DEFAULT true
);
CREATE INDEX source_mirrors_source_idx ON source_mirrors (source_id, priority);

-- ----------------------------------------------------------------------------
-- subtitle & audio tracks attached to a source
-- ----------------------------------------------------------------------------
CREATE TABLE subtitle_tracks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  source_id  uuid REFERENCES video_sources(id) ON DELETE CASCADE, -- null = external sub usable with any source
  language   text NOT NULL,                    -- BCP-47: 'en', 'hu', 'pt-BR'
  kind       text NOT NULL DEFAULT 'subtitles' CHECK (kind IN ('subtitles', 'captions', 'signs')),
  format     text NOT NULL CHECK (format IN ('ass', 'srt', 'vtt')),
  object_key text,                             -- stored copy, when we host the file
  url        text,                             -- or an extension-provided URL
  CHECK (object_key IS NOT NULL OR url IS NOT NULL)
);
COMMENT ON TABLE subtitle_tracks IS 'Subtitles either hosted (object_key) or referenced (url), resolvable per-episode or per-source.';
CREATE INDEX subtitle_tracks_episode_idx ON subtitle_tracks (episode_id, language);

CREATE TABLE audio_tracks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id  uuid NOT NULL REFERENCES video_sources(id) ON DELETE CASCADE,
  language   text NOT NULL,
  codec      text,
  channels   text,                             -- '2.0', '5.1'
  is_default boolean NOT NULL DEFAULT false
);
CREATE INDEX audio_tracks_source_idx ON audio_tracks (source_id);

-- ----------------------------------------------------------------------------
-- skip_segments — intro/outro/recap ranges per episode (community + import)
-- ----------------------------------------------------------------------------
CREATE TABLE skip_segments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id  uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('intro', 'outro', 'recap', 'preview')),
  start_sec   numeric(8,3) NOT NULL,
  end_sec     numeric(8,3) NOT NULL,
  votes       integer NOT NULL DEFAULT 0,      -- community confirmation; highest wins per kind
  submitted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_sec > start_sec)
);
COMMENT ON TABLE skip_segments IS 'Skip-intro/outro ranges. Player picks the highest-voted segment per kind.';
CREATE INDEX skip_segments_episode_idx ON skip_segments (episode_id, kind, votes DESC);

-- ----------------------------------------------------------------------------
-- watch_progress — hottest table: current position per (profile, episode)
-- ----------------------------------------------------------------------------
CREATE TABLE watch_progress (
  profile_id   uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  episode_id   uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  anime_id     uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE, -- denormalised for continue-watching queries
  position_sec numeric(8,3) NOT NULL DEFAULT 0,
  duration_sec numeric(8,3),
  completed    boolean NOT NULL DEFAULT false, -- crossed the 85% threshold
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, episode_id)
);
COMMENT ON TABLE watch_progress IS 'Playback positions. Written through Redis write-behind (flush every 30s), read directly on player start.';
-- continue-watching: latest in-progress items per profile
CREATE INDEX watch_progress_continue_idx ON watch_progress (profile_id, updated_at DESC) WHERE NOT completed;
CREATE INDEX watch_progress_anime_idx ON watch_progress (profile_id, anime_id);

-- ----------------------------------------------------------------------------
-- watch_history — append-only sessions log (drives stats + "watched on")
-- ----------------------------------------------------------------------------
CREATE TABLE watch_history (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  profile_id  uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  episode_id  uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  anime_id    uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  device_id   uuid REFERENCES devices(id) ON DELETE SET NULL,
  watched_sec integer NOT NULL DEFAULT 0,      -- seconds actually watched in this session
  finished    boolean NOT NULL DEFAULT false,
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz,
  PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);
COMMENT ON TABLE watch_history IS 'Append-only viewing sessions, range-partitioned by month. Source of truth for user statistics.';
CREATE INDEX watch_history_profile_idx ON watch_history (profile_id, started_at DESC);
-- partitions are created by the maintenance worker; two initial ones:
CREATE TABLE watch_history_2026_07 PARTITION OF watch_history FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE watch_history_2026_08 PARTITION OF watch_history FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- ----------------------------------------------------------------------------
-- bookmarks — timestamped markers inside episodes ("that scene")
-- ----------------------------------------------------------------------------
CREATE TABLE bookmarks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  episode_id  uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  position_sec numeric(8,3) NOT NULL,
  note        text CHECK (length(note) <= 500),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bookmarks_profile_idx ON bookmarks (profile_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- watch_together_rooms — live co-watching sessions (state lives in Redis,
-- this table persists room identity and history)
-- ----------------------------------------------------------------------------
CREATE TABLE watch_together_rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,            -- short join code
  host_profile uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  episode_id  uuid REFERENCES episodes(id) ON DELETE SET NULL,
  is_public   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);
COMMENT ON TABLE watch_together_rooms IS 'W2G room registry. Live playback sync + presence run over WebSocket with Redis pub/sub.';
CREATE INDEX w2g_rooms_open_idx ON watch_together_rooms (created_at DESC) WHERE closed_at IS NULL;
