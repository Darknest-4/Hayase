// Erőforrás-mintavétel a mérés alatt.
//
// A k6 megmondja, mit látott a KLIENS: késleltetést, hibaarányt, átbocsátást.
// Arról egy szót sem mond, hogy MIÉRT lett lassabb — elfogyott a processzor,
// betelt a memória, vagy a Postgres kapcsolatai fogytak el. E kettő nélkül a
// mérés csak annyit tud: „100 VU-nál rossz lett". Amit tudni akarunk, az az,
// hogy mi lett rossz.
//
// Nem új gyűjtő: az alkalmazás meglévő host-metrikáit használja
// (infrastructure/observability/host-metrics.ts), ugyanazt, amit a monitor
// worker percenként rögzít. Itt csak sűrűbben kérdezzük — egy hatperces
// futásnak hat pontból nincs alakja.
//
//   node --experimental-strip-types scripts/load/sample.mjs --out run.ndjson [--every 5]

import { execFile } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'

import pg from 'pg'

const run = promisify(execFile)

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const OUT = arg('out', 'samples.ndjson')
const EVERY = Number(arg('every', '5')) * 1000
const DB = process.env.LOAD_DATABASE_URL ??
  `postgres://yume:${process.env.POSTGRES_PASSWORD ?? ''}@127.0.0.1:15433/yume`
const CONTAINERS = (arg('containers', 'yume-load-app-1,yume-load-worker-1,yume-load-postgres-1')).split(',')

const { collectHost } = await import('../../apps/api/src/infrastructure/observability/host-metrics.ts')
const pool = new pg.Pool({ connectionString: DB, max: 2, connectionTimeoutMillis: 3000 })

/** Konténerenkénti CPU/memória. Legjobb szándék szerint: ha nincs, kimarad. */
async function containers () {
  try {
    const { stdout } = await run('docker', ['stats', '--no-stream', '--format',
      '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.PIDs}}', ...CONTAINERS])
    const out = {}
    for (const line of stdout.trim().split('\n')) {
      const [name, cpu, mem, memPct, net, pids] = line.split('\t')
      if (!name) continue
      out[name] = {
        cpuPct: Number(String(cpu).replace('%', '')),
        memUsed: String(mem).split('/')[0].trim(),
        memPct: Number(String(memPct).replace('%', '')),
        net: String(net).trim(),
        pids: Number(pids)
      }
    }
    return out
  } catch { return {} }
}

/**
 * A Postgres oldala.
 *
 * A kapcsolatszám az a mérőszám, ami egy terhelésmérésben leghamarabb
 * elfogy, és a leglátványosabban: a készlet kimerül, a kérések sorba állnak,
 * és a kliens csak annyit lát, hogy minden lassú lett.
 */
async function postgres () {
  try {
    const { rows } = await pool.query(`
      SELECT
        (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS connections,
        (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active') AS active,
        (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock') AS waiting_on_lock,
        (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections,
        (SELECT coalesce(extract(epoch FROM max(now() - query_start)), 0)
           FROM pg_stat_activity WHERE datname = current_database() AND state = 'active') AS longest_query_sec,
        (SELECT xact_commit + xact_rollback FROM pg_stat_database WHERE datname = current_database()) AS transactions,
        (SELECT blks_hit FROM pg_stat_database WHERE datname = current_database()) AS blks_hit,
        (SELECT blks_read FROM pg_stat_database WHERE datname = current_database()) AS blks_read,
        -- Ugyanaz a két definíció, amit a monitor worker használ: „várakozik"
        -- az, ami már esedékes és még van próbálkozása, „halott" az, ami
        -- elfogyasztotta mindet. Két helyen két definíció két igazság lenne.
        (SELECT count(*) FROM jobs WHERE done_at IS NULL AND run_at <= now() AND attempts < max_attempts) AS queue_pending,
        (SELECT count(*) FROM jobs WHERE done_at IS NULL AND attempts >= max_attempts) AS queue_dead`)
    return rows[0]
  } catch (e) { return { error: String(e.message).slice(0, 120) } }
}

let previous = null

console.log(`mintavétel ${EVERY / 1000}s-onként → ${OUT}`)
writeFileSync(OUT, '')

let stopping = false
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true })

while (!stopping) {
  const at = new Date().toISOString()
  const [host, docker, db] = await Promise.all([
    collectHost().catch(e => ({ error: String(e.message) })),
    containers(),
    postgres()
  ])

  // A Postgres számlálói kumulatívak; a mintában a KÜLÖNBSÉG az érdekes.
  let rates = {}
  if (previous && db.transactions != null && previous.db?.transactions != null) {
    const dt = (Date.parse(at) - Date.parse(previous.at)) / 1000
    const hit = Number(db.blks_hit) - Number(previous.db.blks_hit)
    const read = Number(db.blks_read) - Number(previous.db.blks_read)
    rates = {
      tps: Math.round((Number(db.transactions) - Number(previous.db.transactions)) / dt),
      cacheHitPct: hit + read > 0 ? Number((100 * hit / (hit + read)).toFixed(2)) : null
    }
  }

  const sample = { at, host, docker, db, rates }
  appendFileSync(OUT, JSON.stringify(sample) + '\n')
  previous = sample

  await new Promise(r => setTimeout(r, EVERY))
}

await pool.end()
console.log('mintavétel vége')
