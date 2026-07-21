-- ============================================================================
-- 0011 — Site configuration & feature flags
-- ============================================================================
-- A database-driven control plane for the whole product: every page and major
-- feature is a togglable flag with an access level (public / auth / permission),
-- and a small set of global site settings (site name, whole-site login gate,
-- open registration). The public /v1/config endpoint projects the effective
-- config to the client, which hides nav, gates routes and can lock the entire
-- site behind login — all changeable live from the admin UI.

-- ----------------------------------------------------------------------------
-- feature_flags — one row per page / feature the client can gate
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feature_flags (
  key                 text PRIMARY KEY,                 -- 'page.community', 'feature.reviews'
  label               text NOT NULL,
  category            text NOT NULL,                    -- 'page' | 'feature'
  enabled             boolean NOT NULL DEFAULT true,
  access              text NOT NULL DEFAULT 'public',   -- 'public' | 'auth' | 'permission'
  required_permission text,                             -- when access = 'permission'
  description         text,
  sort                integer NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT feature_flags_access_check CHECK (access IN ('public', 'auth', 'permission'))
);
COMMENT ON TABLE feature_flags IS 'DB-driven toggles + access levels for every page and major feature; projected to clients by /v1/config.';

-- ----------------------------------------------------------------------------
-- site_settings — global key/value config (jsonb values)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);
COMMENT ON TABLE site_settings IS 'Global site configuration (site name, whole-site login gate, open registration, …).';

-- ----------------------------------------------------------------------------
-- seed: one flag per page (nav + route) …
-- ----------------------------------------------------------------------------
INSERT INTO feature_flags (key, label, category, access, required_permission, description, sort) VALUES
  ('page.home',          'Home',            'page', 'public',     NULL,                 'Landing page with hero and rails', 10),
  ('page.dashboard',     'Dashboard',       'page', 'public',     NULL,                 'Customizable widget dashboard', 20),
  ('page.search',        'Search',          'page', 'public',     NULL,                 'Full-text + image search', 30),
  ('page.schedule',      'Schedule',        'page', 'public',     NULL,                 'Weekly airing calendar', 40),
  ('page.w2g',           'Watch Together',  'page', 'auth',       NULL,                 'Synced watch rooms', 50),
  ('page.community',     'Community',       'page', 'public',     NULL,                 'Live discussion feed', 60),
  ('page.list',          'Library',         'page', 'public',     NULL,                 'Personal anime library', 70),
  ('page.notifications', 'Notifications',   'page', 'public',     NULL,                 'Notification inbox', 80),
  ('page.extensions',    'Extension Store', 'page', 'public',     NULL,                 'Extension marketplace', 90),
  ('page.developer',     'Developer Portal','page', 'permission', 'developer.publish',  'Extension developer portal', 100),
  ('page.profile',       'Profile',         'page', 'public',     NULL,                 'Profile hub (stats/analytics/achievements/history)', 110),
  ('page.settings',      'Settings',        'page', 'public',     NULL,                 'Client settings', 120),
  ('page.admin',         'Admin',           'page', 'permission', 'analytics.view',     'Admin control panel', 130),
  ('page.anime',         'Anime detail',    'page', 'public',     NULL,                 'Anime detail pages', 140),
  ('page.watch',         'Watch',           'page', 'public',     NULL,                 'Video player pages', 150),
-- … and one per cross-cutting feature
  ('feature.comments',       'Comments',        'feature', 'public', NULL, 'Comment threads on anime, episodes and clips', 200),
  ('feature.reviews',        'Reviews',         'feature', 'public', NULL, 'Star reviews on the anime page', 210),
  ('feature.watch_together', 'Watch Together',  'feature', 'auth',   NULL, 'The Watch Together popup on the player', 220),
  ('feature.image_search',   'Image search',    'feature', 'public', NULL, 'Search anime by a video frame (trace.moe)', 230),
  ('feature.trailers',       'Trailers',        'feature', 'public', NULL, 'Trailer playback (hero, hover preview, modal)', 240),
  ('feature.hover_preview',  'Hover previews',  'feature', 'public', NULL, 'Card hover preview panels', 250),
  ('feature.custom_lists',   'Custom lists',    'feature', 'auth',   NULL, 'User-created shareable lists', 260),
  ('feature.registration',   'Registration',    'feature', 'public', NULL, 'New account sign-up', 270)
ON CONFLICT (key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- seed: default global settings
-- ----------------------------------------------------------------------------
INSERT INTO site_settings (key, value) VALUES
  ('site_name',          '"Yume"'::jsonb),
  ('tagline',            '"Track, discover and watch anime — your way."'::jsonb),
  ('require_login',      'false'::jsonb),
  ('registration_open',  'true'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- system-settings permission already exists (0010); make sure admin has it
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.slug = 'admin' AND p.slug IN ('settings.system', 'settings.security')
ON CONFLICT DO NOTHING;
