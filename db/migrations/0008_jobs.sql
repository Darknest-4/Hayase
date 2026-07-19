-- ============================================================================
-- 0008 — Durable job queue (Postgres-backed)
-- ============================================================================
-- The queue abstraction (server/src/lib/queue.ts) has two drivers:
--  * PgQueue (this table, FOR UPDATE SKIP LOCKED) — default; durable,
--    transactional with the data it acts on, zero extra infrastructure.
--  * RabbitMQ — drop-in for higher fan-out once volume demands it.
-- Jobs are small pointers ("recompute stats for profile X"), never payloads
-- of record data — handlers re-read state from the source tables.
-- ============================================================================

CREATE TABLE jobs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue       text NOT NULL,                   -- 'stats' | 'notify' | 'maintenance' | 'import' | 'search-index' | 'ext-review'
  payload     jsonb NOT NULL DEFAULT '{}',
  run_at      timestamptz NOT NULL DEFAULT now(),
  attempts    smallint NOT NULL DEFAULT 0,
  max_attempts smallint NOT NULL DEFAULT 5,
  locked_at   timestamptz,                     -- worker lease start; stale leases are reclaimed
  done_at     timestamptz,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE jobs IS 'Durable background jobs. Claimed with FOR UPDATE SKIP LOCKED; done rows are pruned by the maintenance worker.';

-- the poll query: pending jobs per queue, oldest runnable first
CREATE INDEX jobs_poll_idx ON jobs (queue, run_at) WHERE done_at IS NULL;

-- de-duplication for coalescing jobs (e.g. one pending stats job per profile)
CREATE UNIQUE INDEX jobs_dedupe_idx ON jobs (queue, (payload->>'dedupe')) WHERE done_at IS NULL AND payload ? 'dedupe';
