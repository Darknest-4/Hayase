-- ============================================================================
-- 0019 — Password recovery, session-bound access tokens, and honest schema
-- ============================================================================
-- Audit 13 found three things this migration supports:
--
--  1. There was no way to change a password and no way to reset one.
--     hashPassword ran exactly twice in the whole codebase: once to build the
--     decoy hash that equalises login timing, and once at registration. A user
--     who suspected their password was compromised had no action available.
--
--  2. Signing out revoked the refresh session but left the access token valid
--     until it expired. The fix binds each access token to the session it was
--     minted under, so revoking that session kills its access token — without
--     signing the account out on every other device, which bumping
--     users.token_version would have done.
--
--  3. Thirty-four tables had no code path and no data. That is a legitimate
--     way to work, and it becomes a problem only when it is mistaken for
--     capability, so each one now says what it is.
-- ============================================================================

-- ---------------------------------------------------------------- 1. resets

-- Only the hash is stored: a reset token is a bearer credential for the whole
-- account, and a leaked backup must not hand one over. Same reasoning as
-- sessions.refresh_hash and ws_tickets.ticket.
CREATE TABLE IF NOT EXISTS password_resets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  requested_ip text,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Consuming a token looks it up by hash; expiring old rows scans by date.
CREATE INDEX IF NOT EXISTS password_resets_user_idx
  ON password_resets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS password_resets_expiry_idx
  ON password_resets (expires_at) WHERE used_at IS NULL;

COMMENT ON TABLE password_resets IS
  'Single-use password reset tokens, stored hashed. Delivery is the operator''s: the token is POSTed to PASSWORD_RESET_WEBHOOK_URL only, never through the admin-managed webhook fan-out. See server/src/lib/reset-delivery.ts.';
COMMENT ON COLUMN password_resets.token_hash IS
  'sha256 of the token. The plaintext exists only in the delivery request and the user''s inbox.';

-- ---------------------------------------------------------------- 2. session binding

-- Access tokens carry the id of the session they were minted under, so that
-- revoking one session invalidates its access token immediately. Nothing is
-- needed in the schema for that — sessions.revoked_at already exists — but the
-- lookup is now on the hot path for every authenticated request, so it gets an
-- index that answers it without touching the table.
CREATE INDEX IF NOT EXISTS sessions_live_idx
  ON sessions (id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- 3. planned tables

-- Schema ahead of code is fine; schema that reads like a shipped feature is
-- not. api_keys in particular looked like an API-key authentication system.
-- Each of these has no code path and no rows as of audit 13.
DO $$
DECLARE
  planned text[] := ARRAY[
    -- social
    'clubs', 'club_members', 'forums', 'friendships', 'follows', 'chats',
    -- gamification
    'achievements', 'badges', 'user_badges', 'profile_achievements',
    -- catalogue depth
    'people', 'characters', 'character_voices', 'anime_characters',
    'anime_staff', 'anime_recommendations',
    -- playback detail
    'video_sources', 'audio_tracks', 'subtitle_tracks', 'skip_segments',
    'source_mirrors',
    -- lists
    'custom_lists', 'custom_list_items', 'collections', 'collection_lists',
    'list_likes', 'favorites', 'bookmarks',
    -- auth and preferences
    'api_keys', 'oauth_identities', 'user_settings', 'devices',
    -- extension store
    'extension_reviews', 'review_votes'
  ];
  name text;
BEGIN
  FOREACH name IN ARRAY planned LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = name) THEN
      EXECUTE format(
        'COMMENT ON TABLE public.%I IS %L',
        name,
        'PLANNED as of migration 0019 — no code reads or writes this table. Do not treat its existence as a shipped capability.'
      );
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------- 4. naming

-- `is_public` reads as "private when false", and means "unlisted when false".
-- The room's invite code IS its credential — a capability URL, exactly like a
-- meeting link — so an unlisted room is reachable by anyone holding the code,
-- including anonymously. That is the intended design; the column name is what
-- misleads, and the gap between a name and its behaviour is what surprises
-- somebody later.
COMMENT ON COLUMN watch_together_rooms.is_public IS
  'Listed in the public room browser. FALSE means unlisted, NOT access-controlled: the invite code is the credential and anyone holding it can read the room, without signing in.';
COMMENT ON COLUMN watch_together_rooms.code IS
  'The room''s invite code AND its only access credential. Treat it like a secret link.';
