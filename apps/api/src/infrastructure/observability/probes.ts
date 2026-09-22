// Service probes — capability-aware liveness checks for Yume's dependencies.
//
// Only Postgres is a hard dependency today. Redis, RabbitMQ, OpenSearch and
// MinIO are probed ONLY when their URL is configured; otherwise they report
// 'not_configured' rather than a false 'red'. That way the dashboard is honest
// now and lights up automatically the day one of them is adopted.
//
// Every probe is dependency-free (raw TCP or fetch), bounded by a short
// timeout, and never throws. `detail` carries a short human reason and must
// never contain credentials or connection strings.

import net from 'node:net'

import { config } from '../../config.ts'
import { query, queryOne } from '../database/index.ts'

export type ServiceStatus = 'green' | 'yellow' | 'red' | 'not_configured'

export interface ProbeResult {
  service: string
  status: ServiceStatus
  latencyMs: number | null
  detail: string | null
}

const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 2000)
/** Reachable but slower than this → yellow. */
const SLOW_MS = Number(process.env.PROBE_SLOW_MS ?? 500)

const notConfigured = (service: string): ProbeResult =>
  ({ service, status: 'not_configured', latencyMs: null, detail: 'not configured' })

/**
 * Strip anything that could carry a credential out of an error message.
 *
 * A HITELESÍTŐ JELSOR IS IDE TARTOZIK, és ez egy MÉRT hiány volt. A címeket
 * és az IP-ket eddig is kimaszkolta, de egy `Bot <token>` vagy
 * `Bearer <token>` alakú részlet SÉRTETLENÜL átment — és ez a szöveg a
 * `service_status.detail` mezőbe, onnan az adminfelületre és a
 * Discord-embedbe is kimegy.
 *
 * Nem elméleti eset: egy `fetch` hibája gyakran visszaadja a kérés
 * fejlécének egy darabját, és egy könyvtár, ami „hasznos" hibaüzenetet ír,
 * pont ezt teszi.
 *
 * A hosszú, elválasztó nélküli jelsorokat is levágjuk: egy 32 karakternél
 * hosszabb, szóköz nélküli `A-Za-z0-9._-` blokk gyakorlatilag mindig kulcs
 * vagy azonosító, és egy hibaüzenetben semmi dolga.
 */
export function safeDetail (error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/[a-z]+:\/\/[^\s]*/gi, '<url>')   // scheme://user:pass@host
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>')
    // `Bot xxx`, `Bearer xxx`, `token=xxx`, `authorization: xxx`
    .replace(/\b(bot|bearer|token|authorization|apikey|api[_-]?key)\b\s*[:=]?\s*\S+/gi, '$1 <titok>')
    // minden hosszú, összefüggő jelsor
    .replace(/\b[A-Za-z0-9._-]{32,}\b/g, '<titok>')
    .slice(0, 120)
}

const rate = (latencyMs: number, detail: string | null = null): Omit<ProbeResult, 'service'> =>
  ({ status: latencyMs > SLOW_MS ? 'yellow' : 'green', latencyMs, detail })

/** Time an async probe, converting any failure into a red result. */
async function timed (service: string, fn: () => Promise<Omit<ProbeResult, 'service' | 'latencyMs'> | void>): Promise<ProbeResult> {
  const started = process.hrtime.bigint()
  try {
    const outcome = await fn()
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6
    if (outcome?.status) return { service, latencyMs, ...outcome }
    return { service, ...rate(latencyMs) }
  } catch (error) {
    return { service, status: 'red', latencyMs: null, detail: safeDetail(error) }
  }
}

/** Open a TCP connection, optionally write a payload and read one reply. */
function tcpProbe (host: string, port: number, payload?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    let buffer = ''
    const finish = (err?: Error): void => {
      socket.destroy()
      if (err) reject(err); else resolve(buffer)
    }
    socket.setTimeout(TIMEOUT_MS)
    socket.once('connect', () => {
      if (!payload) return finish()
      socket.write(payload)
    })
    socket.on('data', chunk => {
      buffer += chunk.toString()
      finish()
    })
    socket.once('timeout', () => finish(new Error('timed out')))
    socket.once('error', err => finish(err))
  })
}

/** fetch with a hard timeout — used for the HTTP-speaking services. */
async function httpProbe (url: string, path: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(new URL(path, url), { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

const hostPort = (url: string, fallbackPort: number): { host: string, port: number } => {
  const parsed = new URL(url.includes('://') ? url : `tcp://${url}`)
  return { host: parsed.hostname, port: Number(parsed.port) || fallbackPort }
}

// ---------------------------------------------------------------- probes

/** Postgres — the one hard dependency. A trivial round-trip, not a query cost. */
export const probePostgres = (): Promise<ProbeResult> =>
  timed('postgres', async () => { await query('SELECT 1') })

/** Redis — inline PING command over raw TCP (no client library needed). */
export const probeRedis = (): Promise<ProbeResult> => {
  if (!config.redisUrl) return Promise.resolve(notConfigured('redis'))
  return timed('redis', async () => {
    const { host, port } = hostPort(config.redisUrl!, 6379)
    const reply = await tcpProbe(host, port, 'PING\r\n')
    if (!reply.startsWith('+PONG')) return { status: 'yellow' as const, detail: 'unexpected PING reply' }
  })
}

/** RabbitMQ — TCP reachability (the AMQP handshake needs a full client). */
export const probeRabbit = (): Promise<ProbeResult> => {
  if (!config.rabbitUrl) return Promise.resolve(notConfigured('rabbitmq'))
  return timed('rabbitmq', async () => {
    const { host, port } = hostPort(config.rabbitUrl!, 5672)
    await tcpProbe(host, port)
  })
}

/** OpenSearch — cluster health; a yellow cluster maps to yellow, red to red. */
export const probeOpenSearch = (): Promise<ProbeResult> => {
  if (!config.openSearchUrl) return Promise.resolve(notConfigured('opensearch'))
  return timed('opensearch', async () => {
    const res = await httpProbe(config.openSearchUrl!, '/_cluster/health')
    if (!res.ok) return { status: 'red' as const, detail: `HTTP ${res.status}` }
    const body = await res.json() as { status?: string }
    if (body.status === 'red') return { status: 'red' as const, detail: 'cluster red' }
    if (body.status === 'yellow') return { status: 'yellow' as const, detail: 'cluster yellow' }
  })
}

/** MinIO — the documented unauthenticated liveness endpoint. */
export const probeMinio = (): Promise<ProbeResult> => {
  if (!config.minioUrl) return Promise.resolve(notConfigured('minio'))
  return timed('minio', async () => {
    const res = await httpProbe(config.minioUrl!, '/minio/health/live')
    if (!res.ok) return { status: 'red' as const, detail: `HTTP ${res.status}` }
  })
}

/** The API's own response time, measured from wherever the collector runs. */
export const probeApi = (): Promise<ProbeResult> =>
  timed('api', async () => {
    const res = await httpProbe(config.selfUrl, '/v1/health')
    if (!res.ok) return { status: 'red' as const, detail: `HTTP ${res.status}` }
  })

/**
 * Worker liveness, inferred from the freshness of its own collected metrics —
 * the collector runs inside the worker, so a stale newest sample means the
 * worker is not running. No heartbeat table needed.
 */
export async function probeWorker (staleAfterMs = 180_000): Promise<ProbeResult> {
  try {
    const rows = await query<{ age_ms: number | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - max(created_at))) * 1000 AS age_ms FROM system_metrics`
    )
    const ageMs = rows[0]?.age_ms
    if (ageMs === null || ageMs === undefined) {
      return { service: 'worker', status: 'yellow', latencyMs: null, detail: 'no metrics collected yet' }
    }
    if (ageMs > staleAfterMs) {
      return { service: 'worker', status: 'red', latencyMs: null, detail: `last sample ${Math.round(ageMs / 1000)}s ago` }
    }
    return { service: 'worker', status: 'green', latencyMs: null, detail: null }
  } catch (error) {
    return { service: 'worker', status: 'red', latencyMs: null, detail: safeDetail(error) }
  }
}

/** Every probe, in parallel. Order is stable for the dashboard. */
/**
 * A Discord API elérhetősége — csak ha van bot token.
 *
 * TOKEN NÉLKÜL `not_configured`, NEM `red`. Ez ugyanaz az elv, ami a Redisre
 * és a RabbitMQ-ra is áll: egy szándékosan be nem kapcsolt függőség nem
 * hiba. Pirosra festve a panel folyamatosan riasztana egy működő rendszerre,
 * és onnantól senki nem nézné.
 *
 * A `/users/@me` a legolcsóbb hitelesített végpont: egyetlen rekordot ad, és
 * pontosan azt méri, ami érdekel — él-e a Discord, és érvényes-e a tokenünk.
 *
 * A TOKEN SOHA NEM KERÜL A `detail`-BE. A `safeDetail` a címeket kimaszkolja,
 * de a fejlécet eleve nem is hivatkozzuk: a hibaág csak a HTTP-állapotot
 * adja tovább.
 */
async function probeDiscord (): Promise<ProbeResult> {
  const token = process.env.DISCORD_BOT_TOKEN
  if (!token || token.trim() === '') return notConfigured('discord')

  return await timed('discord', async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { authorization: `Bot ${token.trim()}` },
        signal: controller.signal
      })
      if (res.status === 401) {
        // ÉRVÉNYTELEN TOKEN KÜLÖN ESET. Ez nem „a Discord nem elérhető",
        // hanem „a mi tokenünk rossz" — és az üzemeltetőnek más a teendője.
        return { status: 'red' as const, detail: 'a bot tokenje érvénytelen' }
      }
      if (res.status === 429) return { status: 'yellow' as const, detail: 'a Discord korlátoz' }
      if (!res.ok) return { status: 'red' as const, detail: `HTTP ${res.status}` }
      return
    } finally {
      clearTimeout(timer)
    }
  })
}

/**
 * A tartós üzenetek állapota — a mi oldalunkon.
 *
 * MÁST MÉR, MINT A `discord` SZONDA. Az azt mondja meg, hogy a Discord él; ez
 * azt, hogy a MI üzeneteink mennek-e ki. A kettő külön romlik el: a Discord
 * lehet tökéletesen elérhető, miközben minden üzenetünk jogosultsági hibán
 * áll.
 *
 * A kimerült kudarcszámlálójú rekordok száma a jel: azok már fel is adták.
 */
async function probePersistentMessages (): Promise<ProbeResult> {
  if (!process.env.DISCORD_BOT_TOKEN) return notConfigured('discord-messages')

  return await timed('discord-messages', async () => {
    /*
     * A FELDOLGOZÁS IDEJE SZÁMÍT, NEM A KÜLDÉSÉ — és ezt először elrontottam.
     *
     * A szonda a `last_success_at`-ot nézte: mikor ment ki utoljára VALAMI a
     * Discordra. Csakhogy a motor egész lényege az, hogy NE küldjön, ha a
     * tartalom nem változott — ilyenkor `skipped`, és a `last_success_at`
     * érintetlen marad. Egy tökéletesen egészséges, órák óta változatlan
     * üzenet tehát sárgára váltotta a rendszerállapotot.
     *
     * MÉRVE, élesben: mind a négy üzenet `skipped` volt ugyanabban a
     * percben — vagyis a kör pontosan úgy futott, ahogy kell —, és a szonda
     * közben azt írta ki, hogy „2 üzenet egy órája nem frissült". Egy
     * riasztás, ami a helyes működésre szól, rosszabb a hiányzó riasztásnál:
     * pár nap alatt megtanulja mindenki, hogy nem kell odanézni.
     *
     * A `last_updated_at` az, amit a motor MINDEN körben frissít — kihagyott
     * és elküldött üzenetnél egyaránt. Ez mondja meg, hogy a ciklus él.
     */
    const row = await queryOne<{ total: number, elakadt: number, frissitve: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE failure_count >= 5)::int AS elakadt,
              count(*) FILTER (WHERE last_updated_at > now() - interval '1 hour')::int AS frissitve
         FROM persistent_messages WHERE enabled`)
    const total = row?.total ?? 0
    if (total === 0) return { status: 'not_configured' as const, detail: 'nincs beállított üzenet' }
    if ((row?.elakadt ?? 0) > 0) {
      return { status: 'red' as const, detail: `${row!.elakadt} üzenet elakadt` }
    }
    if ((row?.frissitve ?? 0) < total) {
      // Itt már tényleg baj van: a KÖR nem futott le rájuk, nem csak a
      // küldés maradt el.
      return { status: 'yellow' as const, detail: `${total - (row?.frissitve ?? 0)} üzenetre egy órája nem futott a kör` }
    }
    return
  })
}

/**
 * A GATEWAY — és miért nem a saját állítását hisszük el.
 *
 * A kapcsolat állapotát a gateway-folyamat írja az adatbázisba. Egy
 * LEFAGYOTT folyamat viszont `ready` állapotban hagyja a sort, és onnantól a
 * rendszer örökké azt hinné, hogy gyűjtünk. Az utolsó esemény IDEJE a valódi
 * jel: a Discord szívverése ~41 másodperc, tehát ha percekig semmi nem jött,
 * a kapcsolat halott, akármit mond magáról.
 *
 * A KIKAPCSOLT GATEWAY NEM HIBA. Ha nincs token vagy az üzemeltető
 * kikapcsolta, ez `not_configured` — pirosra festeni annyi volna, mint
 * folyamatos hibát jelezni egy szándékos állapotra, és onnantól senki nem
 * nézi a panelt.
 */
async function probeGateway (): Promise<ProbeResult> {
  if (!process.env.DISCORD_BOT_TOKEN) return notConfigured('discord-gateway')
  if (process.env.DISCORD_GATEWAY_ENABLED === 'false') return notConfigured('discord-gateway')

  return await timed('discord-gateway', async () => {
    const row = await queryOne<{
      status: string, last_event_at: string | null, reconnects: string, last_error: string | null
    }>('SELECT status, last_event_at, reconnects, last_error FROM discord_gateway_state WHERE id = 1')

    if (!row) return { status: 'yellow' as const, detail: 'nincs állapotsor' }
    if (row.status === 'failed') {
      // BEÁLLÍTÁSI HIBA — ezt nem javítja az idő, és az üzemeltetőnek kell
      // beavatkoznia. A `last_error` már meg van tisztítva a forrásnál.
      return { status: 'red' as const, detail: row.last_error ?? 'a gateway leállt' }
    }

    const utolso = row.last_event_at ? new Date(row.last_event_at).getTime() : 0
    const eltelt = Date.now() - utolso
    if (row.status !== 'ready') return { status: 'yellow' as const, detail: row.status }
    if (eltelt > STALE_MS) {
      return { status: 'yellow' as const, detail: `${Math.round(eltelt / 60_000)} perce nem jött esemény` }
    }
    return
  })
}

/** Meddig hisszük el, hogy a gateway él. Lásd `probeGateway`. */
const STALE_MS = Number(process.env.DISCORD_GATEWAY_STALE_MS ?? 5 * 60_000)

export async function probeAll (): Promise<ProbeResult[]> {
  return Promise.all([
    probePostgres(), probeRedis(), probeRabbit(),
    probeOpenSearch(), probeMinio(), probeApi(), probeWorker(),
    probeDiscord(), probePersistentMessages(), probeGateway()
  ])
}

/** Roll individual probes up into the overall service health verdict. */
export function overall (results: ProbeResult[]): 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' {
  const relevant = results.filter(r => r.status !== 'not_configured')
  // Postgres is the hard dependency: without it Yume cannot serve anything.
  if (relevant.some(r => r.service === 'postgres' && r.status === 'red')) return 'UNHEALTHY'
  if (relevant.some(r => r.status === 'red')) return 'DEGRADED'
  if (relevant.some(r => r.status === 'yellow')) return 'DEGRADED'
  return 'HEALTHY'
}
