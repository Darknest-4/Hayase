-- ============================================================================
-- 0016 — Monitoring alerts and on-demand diagnostics
-- ============================================================================
-- Design notes:
--  * Alert state lives in the database, not worker memory, so debounce and
--    cooldown survive a worker restart and an operator can inspect why
--    something did (or did not) fire.
--  * One open alert per subject is enforced by a partial unique index;
--    resolved rows stay as history.
--  * Diagnostics are recorded runs, not fire-and-forget: an admin triggers a
--    run, the worker executes the bounded benchmarks, and the report is stored
--    so it can be read later and compared.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- monitor_alerts — sustained problems, with debounce/cooldown state
-- ----------------------------------------------------------------------------
CREATE TABLE monitor_alerts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject       text NOT NULL,                 -- 'cpu.usage_pct' or 'service:postgres'
  kind          text NOT NULL CHECK (kind IN ('metric', 'service')),
  severity      text NOT NULL CHECK (severity IN ('warning', 'critical')),
  status        text NOT NULL CHECK (status IN ('pending', 'firing', 'resolved')),
  value         numeric(20,4),                 -- reading that triggered it
  threshold     numeric(20,4),                 -- the limit it crossed
  detail        text,                          -- short, redacted reason
  streak        integer NOT NULL DEFAULT 1,    -- consecutive unhealthy cycles
  healthy_streak integer NOT NULL DEFAULT 0,   -- consecutive healthy cycles while open
  started_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  notified_at   timestamptz,                   -- last outbound notification (cooldown)
  resolved_at   timestamptz
);
COMMENT ON TABLE monitor_alerts IS 'Sustained monitoring problems. A condition must hold for several cycles before it fires, so a single spike never alerts.';
COMMENT ON COLUMN monitor_alerts.streak IS 'Consecutive unhealthy collection cycles. Fires when it reaches the debounce threshold.';
COMMENT ON COLUMN monitor_alerts.notified_at IS 'Drives the cooldown: a firing alert re-notifies at most once per cooldown window.';

-- at most one open alert per subject; resolved rows accumulate as history
CREATE UNIQUE INDEX monitor_alerts_open_idx ON monitor_alerts (subject) WHERE status <> 'resolved';
CREATE INDEX monitor_alerts_history_idx ON monitor_alerts (started_at DESC);

-- ----------------------------------------------------------------------------
-- diagnostic_runs — administrator-triggered benchmark reports
-- ----------------------------------------------------------------------------
CREATE TABLE diagnostic_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  passed       integer NOT NULL DEFAULT 0,
  warned       integer NOT NULL DEFAULT 0,
  failed       integer NOT NULL DEFAULT 0,
  results      jsonb NOT NULL DEFAULT '[]',    -- [{ name, group, status, value, detail }]
  error        text
);
COMMENT ON TABLE diagnostic_runs IS 'Recorded diagnostic/benchmark runs. Executed by the worker with hard time and resource limits; never triggered automatically.';
CREATE INDEX diagnostic_runs_recent_idx ON diagnostic_runs (started_at DESC);
