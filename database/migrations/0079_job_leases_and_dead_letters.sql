-- Jobs: a lease that can be told apart from the next one, and a dead letter
-- that stops holding its dedupe key.
--
-- 1. `dead_at`. A job that ran out of attempts stayed `done_at IS NULL`, and
--    the dedupe index covers every job with `done_at IS NULL`. So a dead job
--    kept its dedupe key for the thirty days until the maintenance job pruned
--    it — and every enqueue with that key was silently dropped meanwhile. The
--    recurring jobs all have fixed keys ('maintenance', 'monitor', …): one bad
--    night and the partition maintenance, the pruning and the monitoring would
--    stop for a month. In production an analytics rollup already sat there.
--    A dead job now says so, and leaves the index.
--
-- 2. `lease_id`. A claim is identified by the moment it happened, and the
--    heartbeat moves that moment — so a worker whose lease had been reclaimed
--    could still mark the job done or failed under the new owner. Every claim
--    now mints an id, and heartbeat, completion and failure only apply when
--    the row still carries it.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dead_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_id uuid;

COMMENT ON COLUMN jobs.dead_at IS 'When the job ran out of attempts. A dead job no longer holds its dedupe key.';
COMMENT ON COLUMN jobs.lease_id IS 'The current claim. Heartbeat, completion and failure only apply while the row still carries it.';

-- Jobs that are dead already.
UPDATE jobs SET dead_at = coalesce(run_at, now())
 WHERE done_at IS NULL AND dead_at IS NULL AND attempts >= max_attempts;

DROP INDEX IF EXISTS jobs_dedupe_idx;
CREATE UNIQUE INDEX jobs_dedupe_idx ON jobs (queue, (payload->>'dedupe'))
 WHERE done_at IS NULL AND dead_at IS NULL AND payload ? 'dedupe';

DROP INDEX IF EXISTS jobs_poll_idx;
CREATE INDEX jobs_poll_idx ON jobs (queue, run_at) WHERE done_at IS NULL AND dead_at IS NULL;

CREATE INDEX IF NOT EXISTS jobs_dead_idx ON jobs (queue, dead_at DESC) WHERE dead_at IS NOT NULL AND done_at IS NULL;
