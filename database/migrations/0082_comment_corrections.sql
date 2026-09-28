-- Table comments that described infrastructure which was never built.
--
-- Seven tables said they were cached in, or written through, Redis. There is
-- no Redis client in this code base (see docs/operations/redis.md), and a
-- comment an operator reads in `\d+` or the admin database view should say
-- what actually happens.

COMMENT ON TABLE sessions IS
  'Server-side session records backing refresh tokens (sha256 of the token only). Rotated on every refresh; started_at is carried over, rotated_at marks a retired link.';
COMMENT ON TABLE roles IS
  'Assignable role bundles. Permission checks resolve user → roles → permissions, cached in-process for 30 seconds.';
COMMENT ON TABLE notifications IS
  'Per-user notification inbox. Written by queue workers; read through /v1/me/notifications and pushed live over the WebSocket.';
COMMENT ON TABLE messages IS
  'Chat messages, range-partitioned monthly. Delivery is the WebSocket hub, fanned out across instances with Postgres LISTEN/NOTIFY; this is the durable log.';
COMMENT ON TABLE anime_recommendations IS
  'Recommendation edges imported from AniList; listed by /v1/anime/:id/recommendations (public titles only).';
COMMENT ON TABLE watch_progress IS
  'Playback positions, one row per profile and episode. Written directly by PATCH /v1/me/progress (with the watch-history session, in one transaction).';
COMMENT ON TABLE watch_together_rooms IS
  'W2G room registry. Live playback sync and presence run over the WebSocket hub.';
