/**
 * A tartós üzenetek tartalma — VALÓS adatból.
 *
 * SEMMI NINCS KITALÁLVA. Minden szám a YUME saját adatbázisából jön, abból a
 * táblából, amit a kimutatásokhoz is használunk. Ahol nincs adat, ott az
 * embedben is az áll, hogy nincs — nem nulla, és nem kitalált szám.
 *
 * MIÉRT KÜLÖN MODUL. A motor (`persistent-messages.ts`) nem tudja, mi van az
 * üzenetben — csak ujjlenyomatot képez belőle és elküldi. Ez a szétválasztás
 * teszi lehetővé, hogy a motort valós Discord és valós adat nélkül is
 * végigmérjük.
 *
 * NINCS RENDERELÉSKORI IDŐBÉLYEG AZ EMBEDBEN, ÉS EZ EGY MÉRT HIBA JAVÍTÁSA.
 * Eredetileg minden embed `timestamp: new Date()` mezőt kapott — amitől a
 * tartalom ujjlenyomata MINDEN renderelésnél más lett, és a motor minden
 * körben módosítást küldött. Élesben mérve: három üzenet, percenkénti kör,
 * csupa `edited` és egyetlen `skipped` sem — naponta 4320 fölösleges
 * Discord-hívás, pontosan az a forgalom, ami ellen az ujjlenyomat készült.
 *
 * A frissesség így sem vész el: a Discord maga jelzi a „szerkesztve"
 * bélyeggel, mikor módosult utoljára az üzenet.
 */

import { query, queryOne } from '../../infrastructure/database/index.ts'

/** Amit a felület felkínálhat. A 10.2. pont listája. */
export const MESSAGE_TYPES = [
  'yume_statistics',
  'latest_releases',
  'provider_status',
  'system_health'
] as const

export type MessageType = typeof MESSAGE_TYPES[number]

export interface RenderContext {
  guildId: string
  configuration: Record<string, unknown>
}

/** A YUME arcszíne az embedhez. */
const SZIN = 0xE4_1E_63

/** Egy mező, ahol a hiányzó adat nem nulla. */
function mezo (name: string, value: number | string | null, inline = true): { name: string, value: string, inline: boolean } {
  return {
    name,
    // A NULLA ÉS A „NINCS ADAT" NEM UGYANAZ. Egy friss telepítésen a „0
    // megtekintés" azt állítaná, hogy mérünk és senki nem jött — pedig még
    // nem mérünk.
    value: value === null || value === undefined ? '—' : String(value),
    inline
  }
}

async function yumeStatistics (): Promise<unknown> {
  const [katalogus, tegnap, ma] = await Promise.all([
    queryOne<{ anime: number, episodes: number, users: number }>(
      `SELECT (SELECT count(*) FROM anime WHERE visibility = 'public')::int AS anime,
              (SELECT count(*) FROM episodes WHERE visibility = 'public')::int AS episodes,
              (SELECT count(*) FROM users)::int AS users`),
    queryOne<{ sessions: number, page_views: number, registrations: number }>(
      `SELECT sessions, page_views, registrations
         FROM analytics_daily WHERE day = current_date - 1`),
    queryOne<{ sessions: number, page_views: number }>(
      `SELECT sessions, page_views FROM analytics_daily WHERE day = current_date`)
  ])

  return {
    embeds: [{
      title: 'YUME — statisztika',
      url: 'https://animehub.hu',
      color: SZIN,
      fields: [
        mezo('Animék', katalogus?.anime ?? null),
        mezo('Epizódok', katalogus?.episodes ?? null),
        mezo('Felhasználók', katalogus?.users ?? null),
        mezo('Munkamenet (ma)', ma?.sessions ?? null),
        mezo('Oldalletöltés (ma)', ma?.page_views ?? null),
        mezo('Regisztráció (tegnap)', tegnap?.registrations ?? null)
      ],
      footer: { text: 'A számok a YUME saját adatbázisából származnak. A frissítés idejét a Discord „szerkesztve" jelzése mutatja.' }
    }]
  }
}

async function latestReleases (config: Record<string, unknown>): Promise<unknown> {
  const limit = Math.min(Math.max(Number(config.limit) || 5, 1), 10)
  const rows = await query<{ title: string, number: string, created_at: Date }>(
    `SELECT a.canonical_title AS title, e.number::text AS number, e.created_at
       FROM episodes e JOIN anime a ON a.id = e.anime_id
      WHERE e.visibility = 'public' AND a.visibility = 'public'
      ORDER BY e.created_at DESC LIMIT $1`, [limit])

  return {
    embeds: [{
      title: 'Legfrissebb epizódok',
      url: 'https://animehub.hu',
      color: SZIN,
      description: rows.length
        ? rows.map(r => `• **${r.title}** — ${r.number}. rész`).join('\n')
        : 'Még nincs publikus epizód a katalógusban.'
    }]
  }
}

async function providerStatus (): Promise<unknown> {
  const rows = await query<{
    slug: string, attempts: number, ok: number, failures: number, latency_avg: number
  }>(
    `SELECT slug,
            coalesce(sum(attempts), 0)::int AS attempts,
            coalesce(sum(attempts) FILTER (WHERE outcome = 'ok'), 0)::int AS ok,
            coalesce(sum(attempts) FILTER (WHERE outcome IN ('error','timeout')), 0)::int AS failures,
            CASE WHEN sum(attempts) FILTER (WHERE outcome IN ('ok','empty','error','timeout')) > 0
                 THEN round(sum(latency_ms_sum) FILTER (WHERE outcome IN ('ok','empty','error','timeout'))::numeric
                            / sum(attempts) FILTER (WHERE outcome IN ('ok','empty','error','timeout')))::int
                 ELSE 0 END AS latency_avg
       FROM provider_metrics_daily
      WHERE day >= current_date - 1
      GROUP BY slug ORDER BY attempts DESC`)

  return {
    embeds: [{
      title: 'Forrásszolgáltatók — elmúlt 24 óra',
      color: SZIN,
      description: rows.length
        ? rows.map(r => `${r.failures > 0 ? '⚠️' : '✅'} **${r.slug}** — ${r.ok}/${r.attempts} · ${r.latency_avg} ms`).join('\n')
        : 'Ebben az időszakban egyetlen szolgáltatói kérés sem futott.'
    }]
  }
}

async function systemHealth (): Promise<unknown> {
  const rows = await query<{ service: string, status: string, latency_ms: string | null }>(
    'SELECT service, status, latency_ms FROM service_status ORDER BY service')

  // A `not_configured` NEM HIBA — szándékosan nincs bekapcsolva.
  const jel = (status: string): string =>
    status === 'green' ? '✅' : status === 'not_configured' ? '➖' : status === 'unknown' ? '❔' : '⚠️'

  return {
    embeds: [{
      title: 'Rendszerállapot',
      color: SZIN,
      description: rows.length
        ? rows.map(r => `${jel(r.status)} **${r.service}**${r.latency_ms ? ` — ${Number(r.latency_ms).toFixed(1)} ms` : ''}`).join('\n')
        : 'Nincs állapotadat.',
      footer: { text: '➖ = szándékosan nincs bekapcsolva' }
    }]
  }
}

/**
 * Egy üzenet tartalmának előállítása.
 *
 * ISMERETLEN TÍPUSRA KIVÉTEL, nem üres üzenet. Egy üres embed kimenne a
 * Discordra, és a csatornában egy néma doboz maradna — a hiba pedig sehol
 * nem látszana.
 */
export async function renderMessage (type: string, ctx: RenderContext): Promise<unknown> {
  switch (type) {
    case 'yume_statistics': return await yumeStatistics()
    case 'latest_releases': return await latestReleases(ctx.configuration ?? {})
    case 'provider_status': return await providerStatus()
    case 'system_health': return await systemHealth()
    default: throw new Error(`ismeretlen üzenettípus: ${type}`)
  }
}
