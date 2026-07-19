-- ============================================================================
-- 0001 — Identity, authentication, authorization (RBAC), devices, audit
-- ============================================================================
-- Design notes:
--  * All PKs are UUIDs (gen_random_uuid) so ids can be generated app-side,
--    sharded later, and never leak row counts.
--  * All timestamps are timestamptz. `updated_at` is maintained by the
--    shared trigger installed below.
--  * Soft deletes (deleted_at) are used only where history matters (users);
--    everything else deletes hard and relies on audit tables.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;        -- case-insensitive email/username
CREATE EXTENSION IF NOT EXISTS pg_trgm;       -- trigram search fallback

-- shared updated_at trigger
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- users — one row per account (login identity, not display identity)
-- ----------------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  username      citext NOT NULL UNIQUE CHECK (length(username) BETWEEN 3 AND 32 AND username ~ '^[a-zA-Z0-9_]+$'),
  password_hash text,                          -- null when the account only has OAuth identities
  email_verified_at timestamptz,
  mfa_secret    text,                          -- TOTP secret, encrypted at the app layer
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'banned', 'deleted')),
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz                    -- soft delete; unique email/username freed by app rename on delete
);
COMMENT ON TABLE users IS 'Account identities: credentials, status and MFA. Display data lives in user_profiles.';
CREATE INDEX users_status_idx ON users (status) WHERE status <> 'active';
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- oauth_identities — external logins (AniList, MAL, Discord, Google…)
-- ----------------------------------------------------------------------------
CREATE TABLE oauth_identities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('anilist', 'mal', 'kitsu', 'simkl', 'discord', 'google', 'github')),
  provider_uid  text NOT NULL,                 -- user id at the provider
  access_token  text,                          -- encrypted at the app layer
  refresh_token text,
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_uid)
);
COMMENT ON TABLE oauth_identities IS 'Linked third-party accounts, also used to sync anime lists to AniList/MAL/etc.';
CREATE INDEX oauth_identities_user_idx ON oauth_identities (user_id);

-- ----------------------------------------------------------------------------
-- user_profiles — 1..N display profiles per account (Netflix-style)
-- ----------------------------------------------------------------------------
CREATE TABLE user_profiles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 50),
  avatar_key    text,                          -- object-storage key, not a URL
  banner_key    text,
  bio           text CHECK (length(bio) <= 1000),
  is_default    boolean NOT NULL DEFAULT false,
  is_kids       boolean NOT NULL DEFAULT false, -- restricted profile: filters by age rating
  nsfw_enabled  boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE user_profiles IS 'Watch profiles under one account. Progress, lists and history hang off profiles, not users.';
CREATE INDEX user_profiles_user_idx ON user_profiles (user_id);
CREATE UNIQUE INDEX user_profiles_one_default ON user_profiles (user_id) WHERE is_default;
CREATE TRIGGER user_profiles_updated BEFORE UPDATE ON user_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- user_settings — key/value settings per profile (theme, language, player…)
-- ----------------------------------------------------------------------------
CREATE TABLE user_settings (
  profile_id    uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  key           text NOT NULL CHECK (length(key) <= 64),
  value         jsonb NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, key)
);
COMMENT ON TABLE user_settings IS 'Typed-at-the-app-layer settings store. JSONB values keep the schema stable as settings evolve.';

-- ----------------------------------------------------------------------------
-- sessions — refresh-token sessions; access tokens are stateless JWTs
-- ----------------------------------------------------------------------------
CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash  text NOT NULL,                 -- sha256 of the refresh token; token itself is never stored
  device_id     uuid,                          -- FK added after devices table below
  ip            inet,
  user_agent    text,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE sessions IS 'Server-side session records backing refresh tokens. Hot lookups are cached in Redis (session:{id}).';
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX sessions_refresh_idx ON sessions (refresh_hash);

-- ----------------------------------------------------------------------------
-- devices — registered devices for push notifications and session display
-- ----------------------------------------------------------------------------
CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform      text NOT NULL CHECK (platform IN ('web', 'windows', 'macos', 'linux', 'android', 'ios', 'tv')),
  name          text,                          -- "Chrome on Windows", user-editable
  push_token    text,                          -- FCM/APNs/WebPush token
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE devices IS 'Known devices per user; drives push notification fan-out and the "active sessions" settings page.';
CREATE INDEX devices_user_idx ON devices (user_id);

ALTER TABLE sessions ADD CONSTRAINT sessions_device_fk FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------
-- RBAC: roles ← role_permissions → permissions; users ← user_roles
-- ----------------------------------------------------------------------------
CREATE TABLE roles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,          -- 'admin', 'moderator', 'developer', 'user'
  name          text NOT NULL,
  description   text,
  is_system     boolean NOT NULL DEFAULT false, -- system roles cannot be deleted from the admin UI
  created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE roles IS 'Assignable role bundles. Permission checks resolve user → roles → permissions, cached in Redis.';

CREATE TABLE permissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,          -- dot notation: 'anime.edit', 'extensions.publish', 'admin.users.ban'
  description   text NOT NULL,
  "group"       text NOT NULL                  -- grouping for the admin UI: 'anime', 'community', 'extensions', 'admin'
);
COMMENT ON TABLE permissions IS 'Atomic capabilities. Grouped for display; enforced by slug at the API layer.';
CREATE INDEX permissions_group_idx ON permissions ("group");

CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

-- ----------------------------------------------------------------------------
-- api_keys — programmatic access for the Developer API
-- ----------------------------------------------------------------------------
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  key_hash      text NOT NULL UNIQUE,          -- sha256; plaintext shown once at creation
  scopes        text[] NOT NULL DEFAULT '{}',  -- permission slugs this key may exercise (subset of the owner''s)
  rate_limit    integer NOT NULL DEFAULT 90,   -- requests/minute; enforced by the Redis rate limiter
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE api_keys IS 'Developer API keys with scoped permissions and per-key rate limits.';
CREATE INDEX api_keys_user_idx ON api_keys (user_id);

-- ----------------------------------------------------------------------------
-- notifications — fan-out-on-write inbox per user
-- ----------------------------------------------------------------------------
CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          text NOT NULL,                 -- 'episode_aired', 'comment_reply', 'friend_request', 'extension_update', 'system'
  payload       jsonb NOT NULL DEFAULT '{}',   -- type-specific data: anime_id, episode, comment_id, actor…
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE notifications IS 'Per-user notification inbox. Written by queue workers; unread counts cached in Redis.';
CREATE INDEX notifications_inbox_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- ----------------------------------------------------------------------------
-- security_logs — append-only auth events
-- ----------------------------------------------------------------------------
CREATE TABLE security_logs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  event         text NOT NULL,                 -- 'login', 'login_failed', 'password_changed', 'mfa_enabled', 'session_revoked', 'api_key_created'
  ip            inet,
  user_agent    text,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE security_logs IS 'Append-only security audit trail. Bigint identity PK: high write volume, never updated.';
CREATE INDEX security_logs_user_idx ON security_logs (user_id, created_at DESC);
CREATE INDEX security_logs_event_idx ON security_logs (event, created_at DESC);

-- ----------------------------------------------------------------------------
-- seed system roles + core permissions
-- ----------------------------------------------------------------------------
INSERT INTO roles (slug, name, is_system, description) VALUES
  ('user', 'User', true, 'Default role for every registered account'),
  ('developer', 'Extension Developer', true, 'Can publish extensions to the store'),
  ('moderator', 'Moderator', true, 'Community moderation tools'),
  ('admin', 'Administrator', true, 'Full platform administration');

INSERT INTO permissions (slug, "group", description) VALUES
  ('anime.edit',            'anime',      'Edit anime metadata'),
  ('anime.import',          'anime',      'Run metadata importers'),
  ('community.post',        'community',  'Create posts, topics and comments'),
  ('community.moderate',    'community',  'Hide/delete content, act on reports'),
  ('extensions.publish',    'extensions', 'Publish and update store extensions'),
  ('extensions.review',     'extensions', 'Approve or reject submitted extensions'),
  ('admin.users.manage',    'admin',      'View, suspend and ban users'),
  ('admin.roles.manage',    'admin',      'Assign roles and edit permissions'),
  ('admin.analytics.view',  'admin',      'View platform analytics dashboards');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON
  (r.slug = 'user'      AND p.slug IN ('community.post')) OR
  (r.slug = 'developer' AND p.slug IN ('community.post', 'extensions.publish')) OR
  (r.slug = 'moderator' AND p.slug IN ('community.post', 'community.moderate')) OR
  (r.slug = 'admin');   -- admin gets everything
