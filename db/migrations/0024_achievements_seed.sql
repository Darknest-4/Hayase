-- ============================================================================
-- 0024 — The achievement catalogue gets rows
-- ============================================================================
-- `achievements` and `profile_achievements` have existed since the profile
-- migration with nothing in them and no code touching them. The conditions
-- lived in the client and were evaluated against browser storage, because at
-- the time that was the only place the data was — the server had no watch
-- history, no favourites and no genre breakdown to evaluate against.
--
-- It has all three now, so the catalogue moves here and the server decides
-- what a profile has unlocked. The definitions are in
-- server/src/lib/achievements.ts; this seeds the rows those grants point at,
-- and `seedCatalogue()` keeps them in step on every boot.
--
-- Slugs match the ones the client has always used, so a profile that had
-- achievements shown to it locally sees the same ones after the change.
-- ============================================================================

INSERT INTO achievements (slug, name, description, icon_key, xp_reward) VALUES
  ('first-episode',   'First Steps',      'Watch your first episode.',                          '▶️',  10),
  ('getting-into-it', 'Getting Into It',  'Watch 50 episodes.',                                 '📺',  50),
  ('binge-watcher',   'Binge Watcher',    'Watch 500 episodes.',                                '🍿', 200),
  ('no-life',         'No Life',          'Watch 2,000 episodes.',                              '🌀', 500),
  ('first-finish',    'The End',          'Complete your first anime.',                         '🎬',  20),
  ('collector',       'Collector',        'Complete 25 anime.',                                 '🏆', 150),
  ('century-club',    'Century Club',     'Complete 100 anime.',                                '💯', 400),
  ('librarian',       'Librarian',        'Have 50 titles in your library.',                    '📚', 100),
  ('planner',         'Planner',          'Plan to watch 20 titles.',                           '🗓️',  40),
  ('curator',         'Curator',          'Favourite 10 titles.',                               '❤️',  40),
  ('critic',          'Critic',           'Rate 25 titles.',                                    '⭐', 100),
  ('day-one',         'Day One',          'Watch a full day (24h) of anime.',                   '⏳', 300),
  ('marathon',        'Marathon',         'Watch 10 episodes in a single day.',                 '🏃', 120),
  ('consistent',      'Consistent',       'Be active on 7 different days.',                     '📆', 120),
  ('explorer',        'Explorer',         'Watch across 10 different genres.',                  '🧭', 150),
  ('omnivore',        'Omnivore',         'Watch every format (TV, Movie, OVA, ONA, Special).', '🍱', 250)
ON CONFLICT (slug) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      icon_key = EXCLUDED.icon_key,
      xp_reward = EXCLUDED.xp_reward;

-- The grant path looks a profile's unlocks up by achievement; without this it
-- reads the whole table to answer "what has this profile earned".
CREATE INDEX IF NOT EXISTS profile_achievements_profile_idx
  ON profile_achievements (profile_id, unlocked_at DESC);

COMMENT ON TABLE achievements IS
  'Catalogue rows for the definitions in server/src/lib/achievements.ts; grants point at these.';
