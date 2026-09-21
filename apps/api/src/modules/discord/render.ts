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
import { fetchGuild } from './rest-client.ts'

/** Amit a felület felkínálhat. A 10.2. pont listája. */
export const MESSAGE_TYPES = [
  'yume_statistics',
  'latest_releases',
  'provider_status',
  'system_health',
  'server_statistics',
  'anime_schedule',
  'popular_anime',
  'bot_status'
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
    `SELECT a.canonical_title AS title,
            -- A „7.0. resz" meresi hiba volt: a szam numeric, es a ::text a
            -- tizedesjegyet is kiirja. Az egesz reszeket egeszkent mutatjuk,
            -- a feleseket (7.5) valtozatlanul.
            CASE WHEN e.number = trunc(e.number) THEN trunc(e.number)::int::text
                 ELSE e.number::text END AS number,
            e.created_at
       FROM episodes e JOIN anime a ON a.id = e.anime_id
      WHERE e.visibility = 'public' AND a.visibility = 'public'
      -- A masodlagos rendezes nem disz: azonos created_at eseten a Postgres
      -- sorrendje nem determinisztikus, tehat ket egymas utani lekerdezes MAS
      -- sorrendet adhat -- es attol a tartalom ujjlenyomata is mas lesz,
      -- vagyis az uzenet folosleges modosulna. Egy tomeges importnal tobb
      -- szaz epizod kap ezredmasodpercre azonos idobelyeget.
      ORDER BY e.created_at DESC, e.id DESC LIMIT $1`, [limit])

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

  /*
   * A KÉSLEltetéS KEREKÍTVE — mérve, egy valódi hiba miatt.
   *
   * A `service_status` századmásodpercre pontos értéket tárol, és az
   * percenként ingadozik (28,9 → 3,2 → 11,4 ms). Ez VALÓDI változás, tehát
   * az ujjlenyomat is más lett, és az üzenet percenként módosult — napi
   * 1440 Discord-hívás egy szám remegése miatt.
   *
   * Tíz ezredmásodpercre kerekítve a JELZÉS megmarad (egy 300 ms-os
   * adatbázis továbbra is feltűnik), a zaj viszont eltűnik. A `skipped`
   * ettől kezdve erre az üzenetre is működik.
   */
  const kerekit = (ms: string | null): string =>
    ms ? ` — ~${Math.round(Number(ms) / 10) * 10} ms` : ''

  return {
    embeds: [{
      title: 'Rendszerállapot',
      color: SZIN,
      description: rows.length
        ? rows.map(r => `${jel(r.status)} **${r.service}**${kerekit(r.latency_ms)}`).join('\n')
        : 'Nincs állapotadat.',
      footer: { text: '➖ = szándékosan nincs bekapcsolva' }
    }]
  }
}

/**
 * A DISCORD-SZERVER SZÁMAI.
 *
 * Ez az EGYETLEN üzenettípus, ami a Discordot is megszólítja renderelés
 * közben — a taglétszám nem a mi adatunk, és kitalálni nem lehet. Ha nincs
 * token vagy nem érjük el a szervert, „—" áll a szám helyén; nem nulla.
 *
 * AZ ONLINE LÉTSZÁM TÍZRE KEREKÍTVE. Ez ugyanaz a mérés, mint a
 * rendszerállapot késleltetésénél: a jelenlét percenként ingadozik, és
 * nyersen minden körben más ujjlenyomatot adna — vagyis az üzenet a nap
 * minden frissítésénél módosulna, pusztán attól, hogy valaki lelépett. A
 * kerekítés a nagyságrendet megtartja, a remegést elveszi.
 */
async function serverStatistics (ctx: RenderContext): Promise<unknown> {
  const guild = await fetchGuild(ctx.guildId)
  const kerekit = (n: number | null): number | null => n === null ? null : Math.round(n / 10) * 10

  // A hozzákötött YUME-fiókok — ez viszont a MI adatunk.
  const kotott = await queryOne<{ n: number }>(
    `SELECT count(DISTINCT l.user_id)::int AS n
       FROM discord_links l
       JOIN discord_guild_members m ON m.discord_user_id = l.discord_user_id
      WHERE m.guild_id = $1`, [ctx.guildId])

  return {
    embeds: [{
      title: guild?.name ? `${guild.name} — a szerver számai` : 'A szerver számai',
      color: SZIN,
      fields: [
        mezo('Tagok', guild?.memberCount ?? null),
        mezo('Online (kb.)', kerekit(guild?.onlineCount ?? null)),
        mezo('YUME-fiókkal', kotott?.n ?? null)
      ],
      footer: {
        text: guild === null
          ? 'A Discord létszámai nem érhetők el — nincs bot token, vagy a bot nem tagja a szervernek.'
          : 'Az online létszám tízre kerekítve, hogy az üzenet ne frissüljön percenként.'
      }
    }]
  }
}

/**
 * A KÖVETKEZŐ EPIZÓDOK — a katalógus menetrendjéből.
 *
 * A dátum ABSZOLÚT, nem „3 nap múlva". A relatív forma naponta más szöveget
 * adna ugyanarra az adatra, és az üzenet minden nap módosulna anélkül, hogy
 * bármi történt volna. Aki percre pontos visszaszámlálást akar, a Discord
 * saját időbélyegét kapja — de az az embed tartalmát nem befolyásolja.
 */
async function animeSchedule (config: Record<string, unknown>): Promise<unknown> {
  const limit = Math.min(Math.max(Number(config.limit) || 8, 1), 15)
  const rows = await query<{ title: string, ep: number | null, at: Date }>(
    `SELECT canonical_title AS title, next_airing_ep AS ep, next_airing_at AS at
       FROM anime
      WHERE visibility = 'public' AND next_airing_at > now()
      -- Azonos időpontnál a cím dönt; enélkül a sorrend futásonként más
      -- lehetne, es az ujjlenyomat is (lasd a latestReleases-t).
      ORDER BY next_airing_at, canonical_title LIMIT $1`, [limit])

  const nap = (d: Date): string => new Date(d).toISOString().slice(0, 10)

  return {
    embeds: [{
      title: 'Következő epizódok',
      url: 'https://animehub.hu',
      color: SZIN,
      description: rows.length
        ? rows.map(r => `• **${r.title}** — ${r.ep !== null ? `${r.ep}. rész · ` : ''}${nap(r.at)}`).join('\n')
        : 'A katalógusban egyetlen animéhez sincs jövőbeli adásidő.'
    }]
  }
}

/**
 * A LEGNÉZETTEBB CÍMEK — a napi összesítőből, nem nyers eseményből.
 *
 * Hét nap, mert egyetlen nap egy kis forgalmú oldalon egyetlen látogató
 * ízlését mutatná. A megtekintések a `anime_stats_daily`-ből jönnek, abból
 * a táblából, amiből a kimutatás is dolgozik — nem külön számolunk.
 */
async function popularAnime (config: Record<string, unknown>): Promise<unknown> {
  const limit = Math.min(Math.max(Number(config.limit) || 5, 1), 10)
  const days = Math.min(Math.max(Number(config.days) || 7, 1), 30)
  const rows = await query<{ title: string, views: number, viewers: number }>(
    `SELECT a.canonical_title AS title,
            sum(s.views)::int AS views,
            sum(s.unique_viewers)::int AS viewers
       FROM anime_stats_daily s
       JOIN anime a ON a.id = s.anime_id
      WHERE s.day >= current_date - $2::int AND a.visibility = 'public'
      GROUP BY a.canonical_title
     HAVING sum(s.views) > 0
      ORDER BY sum(s.views) DESC, a.canonical_title
      LIMIT $1`, [limit, days])

  return {
    embeds: [{
      title: `Legnézettebb — elmúlt ${days} nap`,
      url: 'https://animehub.hu',
      color: SZIN,
      description: rows.length
        ? rows.map((r, i) => `**${i + 1}.** ${r.title} — ${r.views} megtekintés · ${r.viewers} néző`).join('\n')
        : 'Ebben az időszakban egyetlen címnél sem mértünk megtekintést.'
    }]
  }
}

/**
 * A BOT ÁLLAPOTA — ebben a szerverben.
 *
 * NINCS BENNE IDŐBÉLYEG, ÉS EZ NEM ESZTÉTIKAI DÖNTÉS. Ez az üzenet a saját
 * frissítéseiről számol be: ha kiírná, mikor frissült utoljára, a
 * tartalma MINDEN körben megváltozna — az üzenet önmagát hajtaná, percenként,
 * örökké. Ezért csak állapotot mutat: mennyi van, mennyi egészséges, és ami
 * elromlott, azon MI a hiba.
 */
async function botStatus (ctx: RenderContext): Promise<unknown> {
  const rows = await query<{
    message_type: string, enabled: boolean, failure_count: number,
    last_error: string | null, has_message: boolean
  }>(
    `SELECT message_type, enabled, failure_count, last_error,
            (message_id IS NOT NULL) AS has_message
       FROM persistent_messages WHERE guild_id = $1 ORDER BY message_type`,
    [ctx.guildId])

  const hibas = rows.filter(r => r.failure_count > 0)
  const aktiv = rows.filter(r => r.enabled)

  return {
    embeds: [{
      title: 'A bot állapota',
      color: SZIN,
      fields: [
        mezo('Tartós üzenet', rows.length),
        mezo('Aktív', aktiv.length),
        mezo('Hibás', hibas.length)
      ],
      description: rows.length
        ? rows.map(r => {
            const jel = !r.enabled ? '➖' : r.failure_count > 0 ? '⚠️' : r.has_message ? '✅' : '🕓'
            const meg = !r.enabled
              ? 'letiltva'
              : r.failure_count > 0
                ? `${r.failure_count} sikertelen kísérlet — ${r.last_error ?? 'ismeretlen hiba'}`
                : r.has_message ? 'kint van' : 'még nem ment ki'
            return `${jel} **${r.message_type}** — ${meg}`
          }).join('\n')
        : 'Ebben a szerverben még nincs tartós üzenet.',
      footer: { text: '➖ letiltva · 🕓 még nem ment ki · ⚠️ hibás' }
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
    case 'server_statistics': return await serverStatistics(ctx)
    case 'anime_schedule': return await animeSchedule(ctx.configuration ?? {})
    case 'popular_anime': return await popularAnime(ctx.configuration ?? {})
    case 'bot_status': return await botStatus(ctx)
    default: throw new Error(`ismeretlen üzenettípus: ${type}`)
  }
}
