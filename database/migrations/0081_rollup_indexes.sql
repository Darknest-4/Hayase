-- Indexes the planner has been missing.
--
-- 1. Time windows over library rows. The daily analytics rollup, the trending
--    job and the analytics dashboard all ask "what was added to libraries /
--    favourites in this window". There was no index on `created_at` for
--    either table, so each of those questions read the whole of
--    `library_entries` — 45,823 sequential scans and 1.5 billion rows read in
--    production, for a table of 32 thousand rows.
--
-- 2. Foreign keys with nothing behind them. Deleting or merging a title, an
--    episode or a person makes Postgres look for referencing rows, and
--    without an index whose leading column is the foreign key that look is a
--    scan of the whole referencing table. `watch_progress` (364k rows) had
--    neither its episode nor its anime key indexed on its own, and every
--    catalogue merge read it end to end; so did `anime_recommendations`,
--    `video_sources`, the cast and staff tables.
--
-- Built inside the migration's transaction, so each briefly holds a write
-- lock on its table — seconds at this size, on a deploy.

CREATE INDEX IF NOT EXISTS library_entries_created_idx ON library_entries (created_at);
CREATE INDEX IF NOT EXISTS favorites_created_idx ON favorites (created_at) WHERE subject_type = 'anime';

CREATE INDEX IF NOT EXISTS watch_progress_episode_idx ON watch_progress (episode_id);
CREATE INDEX IF NOT EXISTS watch_progress_anime_only_idx ON watch_progress (anime_id);
CREATE INDEX IF NOT EXISTS watch_history_episode_idx ON watch_history (episode_id);
CREATE INDEX IF NOT EXISTS watch_history_anime_idx ON watch_history (anime_id);

CREATE INDEX IF NOT EXISTS anime_recommendations_recommended_idx ON anime_recommendations (recommended_id);
CREATE INDEX IF NOT EXISTS video_sources_added_by_idx ON video_sources (added_by) WHERE added_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS character_voices_person_idx ON character_voices (person_id);
CREATE INDEX IF NOT EXISTS anime_staff_person_idx ON anime_staff (person_id);
CREATE INDEX IF NOT EXISTS anime_characters_character_idx ON anime_characters (character_id);

CREATE INDEX IF NOT EXISTS episode_stats_daily_episode_idx ON episode_stats_daily (episode_id);
CREATE INDEX IF NOT EXISTS discord_episode_announcements_episode_idx ON discord_episode_announcements (episode_id);
CREATE INDEX IF NOT EXISTS comments_parent_idx ON comments (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS user_roles_role_idx ON user_roles (role_id);
CREATE INDEX IF NOT EXISTS role_permissions_permission_idx ON role_permissions (permission_id);
