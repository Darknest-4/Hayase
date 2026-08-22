-- ============================================================================
-- 0018 — Access-token revocation, and a WebSocket handshake without the token
-- ============================================================================
-- Two gaps the production-readiness audit found:
--
--  1. Signing out or banning an account revoked the refresh token, but the
--     access token stayed valid until it expired. On HTTP that window is
--     bounded by the token lifetime; the socket layer had no bound at all
--     until a re-authentication sweep was added.
--
--  2. The WebSocket carried its access token in the query string, so it landed
--     in reverse-proxy access logs and browser history — the two places a
--     credential should never be written down.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- token_version — a cheap global revocation switch
-- ----------------------------------------------------------------------------
-- Every access token carries the version it was minted under. Bumping this
-- invalidates all of a user's outstanding tokens at once, without a blocklist
-- to store, expire and look up on every request.
ALTER TABLE users ADD COLUMN token_version integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN users.token_version IS
  'Incremented to invalidate every outstanding access token for this user (sign-out-everywhere, ban, password change).';

-- ----------------------------------------------------------------------------
-- ws_tickets — single-use handshake credentials
-- ----------------------------------------------------------------------------
-- The client exchanges its access token (in an Authorization header, over the
-- normal API) for a short-lived ticket, and connects with that instead. A
-- ticket that leaks into a log is worth nothing: it is single-use and expires
-- in under a minute.
CREATE TABLE ws_tickets (
  ticket     text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE ws_tickets IS
  'Single-use WebSocket handshake credentials. Short TTL so a ticket in an access log is already useless.';

-- Expired and spent tickets are swept by the maintenance job; this index keeps
-- both the lookup and the sweep cheap.
CREATE INDEX ws_tickets_expiry_idx ON ws_tickets (expires_at);
