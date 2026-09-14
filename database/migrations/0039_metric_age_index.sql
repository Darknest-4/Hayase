-- ============================================================================
-- 0039 — Let the diagnostics page find the newest metric without reading them all
-- ============================================================================
-- `SELECT max(created_at) FROM system_metrics` had no index it could use. The
-- only one is (metric, created_at DESC), which answers "the newest sample of
-- this metric" and not "the newest sample of anything" — so the planner read
-- every partition in full. Measured on the live instance: a parallel
-- sequential scan over 231 944 rows, 2 689 buffers, 28 ms, on every diagnostics
-- run, and growing with the retention window. pg_stat_user_tables had 34 198
-- sequential scans of the current partition on record.
--
-- Declared on the partitioned parent, so every existing partition gets it and
-- every partition the worker creates next month inherits it. With the caller's
-- new time bound (diagnostics.ts) the planner prunes the partitions that
-- cannot hold the answer and walks one index backwards for the rest.
--
-- Index only. No column, constraint or row is touched, so an older binary
-- running against this schema behaves exactly as it did.
-- ============================================================================

CREATE INDEX IF NOT EXISTS system_metrics_created_idx ON system_metrics (created_at DESC);

COMMENT ON INDEX system_metrics_created_idx IS
  'Newest-sample-of-anything, for the worker liveness probe. The (metric, created_at) index cannot answer that without a full scan.';
