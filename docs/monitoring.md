# VPS Health & Monitoring

Yume monitors the machine it runs on and the services it depends on. The system
has two deliberately separate layers:

| Layer | Endpoint | Cost | Who can see it |
|---|---|---|---|
| **Liveness** | `GET /v1/health` | zero dependencies | public |
| **Readiness** | `GET /v1/health/ready` | cached dependency probes | public, minimal detail |
| **Detailed monitoring** | `GET /v1/admin/monitoring/*` | reads stored samples | `system.metrics.view` only |

Collection never happens on the request path: the **worker** collects once a
minute and the API only reads what was stored.

---

## 1. Liveness — `GET /v1/health`

```json
{ "status": "ok" }
```

Unchanged and intentionally trivial. It answers "is this process alive", which
is what Docker healthchecks and load balancers should poll. It touches nothing,
so it cannot fail because a dependency is slow.

## 2. Readiness — `GET /v1/health/ready`

```json
{
  "status": "HEALTHY",
  "services": [ { "name": "postgres", "status": "green" }, … ],
  "checkedAt": "2026-08-21T17:48:04.078Z"
}
```

* Aggregates the dependency probes and returns `HEALTHY` / `DEGRADED` / `UNHEALTHY`.
* **Cached for 5s** (`READY_CACHE_MS`) so polling can never stampede the dependencies.
* Returns HTTP **503** only when `UNHEALTHY` (Postgres down = Yume cannot serve).
  `DEGRADED` still returns 200, because the site is usable.
* Deliberately minimal: service name and colour only. **No** latency, error
  detail, hostnames, versions, paths or configuration.

### Capability-aware services

Yume's only hard dependency today is **PostgreSQL**. Redis, RabbitMQ, OpenSearch
and MinIO exist in `docker-compose.yml` behind the `infra` profile but no code
uses them yet.

Rather than reporting them as broken, each optional service is probed **only when
its URL is configured**:

| Env var | Service | Probe |
|---|---|---|
| `REDIS_URL` | Redis | TCP + inline `PING`, expects `+PONG` |
| `RABBITMQ_URL` | RabbitMQ | TCP reachability on the AMQP port |
| `OPENSEARCH_URL` | OpenSearch | `GET /_cluster/health` (cluster yellow → yellow, red → red) |
| `MINIO_URL` | MinIO | `GET /minio/health/live` |

Unconfigured services report `not_configured` (⚪) and are excluded from the
overall verdict. Set the variable and the service starts being monitored — no
code change needed.

`api` and `worker` are always monitored. Worker liveness is inferred from the
freshness of its own samples, so a dead collector cannot look healthy.

---

## 3. Detailed monitoring (admin only)

All endpoints require the **`system.metrics.view`** permission.

| Endpoint | Returns |
|---|---|
| `GET /v1/admin/monitoring/current` | latest value of every metric, classified, plus services and the dependency map |
| `GET /v1/admin/monitoring/history?metric=…&hours=24` | time series (raw ≤48h, hourly rollup beyond) |
| `GET /v1/admin/monitoring/thresholds` | the active threshold table with rationales |
| `GET /v1/admin/monitoring/queues` | job queue depth, dead letters, last errors |

### What is collected

| Group | Metrics |
|---|---|
| CPU | `cpu.usage_pct`, `cpu.load1`, `cpu.load_per_core` |
| Memory | `mem.used_pct`, `mem.used_bytes`, `mem.total_bytes`, `swap.used_pct` |
| Disk | `disk.used_pct`, `disk.used_bytes`, `disk.total_bytes` |
| Disk I/O | `disk.read_bps`, `disk.write_bps`, `disk.iops`, `disk.await_ms` |
| Network | `net.rx_bps`, `net.tx_bps`, `net.drop_pct`, `net.latency_ms` |
| Latency | `api.latency_ms`, `db.latency_ms` |
| Queue | `queue.pending`, `queue.dead` |
| Host | `host.uptime_sec` |

All readings come from `node:os`, `fs.statfs` and `/proc` — **no extra
dependency is installed**. Rate metrics (CPU, disk I/O, network) are computed
from deltas between consecutive samples.

### Staleness

`/current` reports `stale: true` when the newest sample is older than
`MONITOR_STALE_AFTER_MS` (default 180s, three collection cycles) and forces the
overall level to `red`. Stale numbers still look fine individually, so the
dashboard must never present them as healthy.

---

## 4. Thresholds

Every threshold is documented in `server/src/lib/thresholds.ts` with the
reasoning behind it, and exposed through `/v1/admin/monitoring/thresholds`.

| Metric | Warn | Critical | Why |
|---|---|---|---|
| `cpu.usage_pct` | 80 | 92 | Above 80% there is no headroom for spikes; above 92% latency degrades sharply |
| `cpu.load_per_core` | 1.0 | 2.0 | 1.0 = run queue saturated; 2.0 = tasks wait as long as they run |
| `mem.used_pct` | 85 | 94 | Based on `MemAvailable`; below ~6% free the OOM killer becomes likely |
| `swap.used_pct` | 25 | 60 | Sustained swapping hurts tail latency |
| `disk.used_pct` | 80 | 92 | Postgres needs headroom for WAL/temp/VACUUM; filesystems fragment past ~90% |
| `disk.await_ms` | 20 | 100 | NVMe answers in single-digit ms; >100ms = saturated device |
| `net.latency_ms` | 150 | 400 | TCP connect RTT; >400ms is unusable interactively |
| `net.drop_pct` | 0.1 | 1.0 | Interface drop ratio — any sustained loss means a saturated link |
| `api.latency_ms` | 300 | 1000 | Self-probe; >300ms means event-loop congestion |
| `db.latency_ms` | 100 | 500 | `SELECT 1` round-trip; slow = pool exhaustion or disk trouble |
| `queue.pending` | 100 | 1000 | Sustained backlog means the worker is down or under-provisioned |
| `queue.dead` | 1 | 25 | Each dead letter is lost work |

### Overriding at runtime

Thresholds are stored in the existing `site_settings` mechanism, so no restart
is needed:

```bash
curl -X PATCH https://your-host/v1/admin/config/settings/monitor_thresholds \
  -H 'Authorization: Bearer <admin token>' -H 'Content-Type: application/json' \
  -d '{"value": {"disk.used_pct": {"warn": 85, "crit": 95}}}'
```

Only the keys you supply are overridden; everything else keeps its documented
default. `{}` restores all defaults.

---

## 5. Storage and retention

| Table | Contents | Retention |
|---|---|---|
| `system_metrics` | raw 60s samples, monthly RANGE partitions | **7 days** (`METRICS_RETENTION_DAYS`), month-old partitions dropped as a backstop |
| `system_metrics_hourly` | hourly avg/min/max rollup | **365 days** (`METRICS_HOURLY_RETENTION_DAYS`) |
| `service_status` | one current row per dependency | current state only, with a `since` timestamp |

The monitor worker prunes rows every cycle; the maintenance worker drops expired
partitions hourly. High-frequency data is never kept forever.

---

## 6. Alerting

Monitoring only helps if sustained problems reach a human — and only if a
single spike never does. The evaluator runs on the same readings that were just
stored, so what alerts always matches what the dashboard shows.

### The state machine

```
healthy ──unhealthy──> pending ──held for N cycles──> firing
   ^                      │                             │
   └──── resolved <───────┴────── healthy for M cycles ──┘
```

| Setting | Default | Env | Meaning |
|---|---|---|---|
| Debounce | 3 cycles (~3 min) | `ALERT_DEBOUNCE_CYCLES` | consecutive unhealthy cycles before firing |
| Recovery | 2 cycles | `ALERT_RECOVERY_CYCLES` | consecutive healthy cycles before resolving |
| Cooldown | 30 min | `ALERT_COOLDOWN_MS` | minimum gap between notifications for one alert |

* A spike that clears before the debounce threshold **resolves silently** — no
  alert, no recovery message.
* A firing alert re-notifies only when the cooldown elapses **or** when it
  escalates from warning to critical. Easing from critical back to warning does
  not re-notify.
* Recovery is announced only for alerts that actually fired.
* State lives in `monitor_alerts`, not worker memory, so a worker restart does
  not lose debounce progress — and an operator can see exactly why something
  did or did not fire.

### Where alerts go

Alerts are emitted as the existing webhook events `monitor.alert` and
`monitor.recovered` (Discord embeds included), so any endpoint configured under
Admin → Webhooks receives them. Active alerts and recent history are also shown
on the Infrastructure dashboard and available at
`GET /v1/admin/monitoring/alerts`.

Resolved alerts are kept for 90 days as history.

---

## 7. Diagnostics

A separate, **manually triggered** benchmark suite. It never runs automatically
and never runs on the request path — the API queues it and the worker executes
it.

```
POST /v1/admin/monitoring/diagnostics    → 202 { id }     (system.diagnostics.run)
GET  /v1/admin/monitoring/diagnostics/:id → the report
GET  /v1/admin/monitoring/diagnostics     → recent runs
```

### Safety limits

This runs on the machine that is serving traffic, so every test is bounded:

| Test | Budget | Notes |
|---|---|---|
| CPU | 700 ms (`DIAG_CPU_MS`) | single-threaded integer loop; never forks or scales with core count |
| RAM | 128 MB (`DIAG_RAM_BYTES`) | pages pre-faulted so the result is bandwidth, not allocation; released immediately |
| Disk | 32 MB (`DIAG_DISK_BYTES`) | temp file, `fsync`, read back, **always deleted**; skipped entirely unless 2 GB of headroom remains |
| API / DB | 10–20 samples | short timeouts, p50/p95 reported |

Additionally: one run at a time (a second request gets **409**), a per-test
timeout that degrades to `fail` rather than hanging, and a sweep that marks a
run failed if the worker died mid-benchmark. Nothing spawns processes.

### The report

```
YUME VPS DIAGNOSTIC
────────────────────────────────────────
CPU                 PASS  75M ops/s
RAM                 PASS  10.3 GB/s write · 4.4 GB/s read
Disk                PASS  486 MB/s write · 3139 MB/s read

Postgres            PASS  2ms
Redis               SKIP  not configured
Api                 PASS  9ms
Worker              PASS  green

API latency         PASS  p95 3ms
DB queries          PASS  p50 0.2ms · p95 0.6ms
Catalogue query     PASS  0.5ms
Worker & queues     PASS  1 pending · 0 dead

TOTAL               10/10 PASS · 4 SKIPPED
```

Unconfigured optional services are **skipped, not failed** — counting them
against the score would punish a correct setup.

---

## 8. Deployment

> **The `worker` service is required.** Besides metrics it creates next month's
> table partitions and enforces retention. Without it, inserts into the
> time-partitioned tables start failing once the existing partitions run out.

`docker compose up` starts `app`, `worker` and `postgres`.

### Host metrics from inside a container

`/proc/stat`, `/proc/meminfo`, `/proc/diskstats` and `/proc/net/dev` are **not**
namespaced by Docker, so CPU, RAM, disk I/O and network already describe the VPS
host. Filesystem usage is the exception — `statfs('/')` would measure the
container overlay — so the compose file bind-mounts the host root read-only and
points `DISK_PATH` at it:

```yaml
worker:
  environment:
    DISK_PATH: /host
  volumes:
    - /:/host:ro
```

This is the same approach Prometheus `node-exporter` uses.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MONITOR_INTERVAL_MS` | `60000` | collection cadence |
| `METRICS_RETENTION_DAYS` | `7` | raw sample retention |
| `METRICS_HOURLY_RETENTION_DAYS` | `365` | rollup retention |
| `MONITOR_STALE_AFTER_MS` | `180000` | when a snapshot counts as stale |
| `READY_CACHE_MS` | `5000` | readiness cache TTL |
| `PROBE_TIMEOUT_MS` | `2000` | per-probe timeout |
| `PROBE_SLOW_MS` | `500` | reachable-but-slow → yellow |
| `DISK_PATH` | `/` | filesystem measured for disk usage |
| `NET_LATENCY_TARGET` | `1.1.1.1:443` | TCP endpoint for latency probing |
| `SELF_URL` | `http://127.0.0.1:$PORT` | where the worker reaches the API |

---

## 9. Security

* Detailed monitoring is behind `system.metrics.view`, enforced by the existing
  RBAC layer. No second authentication system was introduced.
* Unauthenticated requests get **401**, authenticated non-admins get **403**.
* Probe failure messages are redacted before storage: URLs, credentials and IP
  addresses are stripped and the message is truncated (`safeDetail`).
* The public readiness endpoint exposes only service names and colours.
* Docker socket introspection is **not** enabled. Mounting `/var/run/docker.sock`
  grants root-equivalent access to the host, so container-level detail is
  deliberately left out; service health is inferred from the probes instead.

## 10. Known limitations

* `net.drop_pct` is the NIC's own drop/error ratio — it indicates a saturated
  link or queue, **not** end-to-end packet loss between client and server.
* Network latency is a **TCP connect** RTT, not ICMP ping: the container runs
  unprivileged and cannot open raw sockets.
* `disk.await_ms` is the average service time per I/O across physical devices;
  it is `null` when no I/O happened during the window.
* Per-container CPU/RAM breakdown is not collected (see the Docker socket note).
* Alerts are delivered through webhooks only — there is no in-app admin
  notification or email channel yet.
* The disk benchmark measures the filesystem `DISK_PATH` points at; the read
  figure is served from the page cache, so only the write number (which
  includes `fsync`) reflects the device.
* Diagnostics need the worker running. If it is down the run stays queued and
  is marked failed after 10 minutes.
