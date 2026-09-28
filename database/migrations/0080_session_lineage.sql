-- Sessions: where a refresh chain began, and how each link ended.
--
-- 1. `started_at`. A refresh rotates the session — the old row is revoked and
--    a new one opened — so `created_at` is the time of the last refresh, not
--    of the sign-in. Maintenance's drain window ("people already here may
--    finish") needs the sign-in time; it was using the access token's `iat`,
--    which is re-minted every fifteen minutes, so nobody ever counted as
--    "already here". `started_at` is copied from link to link.
--
-- 2. `rotated_at`. Set when a session is retired by a refresh, as opposed to
--    a sign-out. A refresh token presented again after its session was
--    rotated is either a second tab losing a race by a few milliseconds, or
--    a copy in somebody else's hands. The timing tells them apart: past a
--    short grace period, the whole account is signed out.
--
-- 3. `ws_tickets.session_id` / `token_version`. A WebSocket outlived the
--    session that opened it: signing out, changing the password or being
--    banned left an open socket open. The ticket now remembers what it was
--    issued under, and the hub re-checks it.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS started_at timestamptz;
UPDATE sessions SET started_at = created_at WHERE started_at IS NULL;
ALTER TABLE sessions ALTER COLUMN started_at SET DEFAULT now();
ALTER TABLE sessions ALTER COLUMN started_at SET NOT NULL;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS rotated_at timestamptz;

COMMENT ON COLUMN sessions.started_at IS 'When the sign-in behind this refresh chain happened; carried over on every rotation.';
COMMENT ON COLUMN sessions.rotated_at IS 'Set when a refresh retired this session. A later presentation of its token is a reuse.';

ALTER TABLE ws_tickets ADD COLUMN IF NOT EXISTS session_id uuid;
ALTER TABLE ws_tickets ADD COLUMN IF NOT EXISTS token_version integer;

COMMENT ON COLUMN ws_tickets.session_id IS 'The session the ticket was issued under; the socket closes when it ends.';
COMMENT ON COLUMN ws_tickets.token_version IS 'users.token_version at issue; the socket closes when it moves.';
