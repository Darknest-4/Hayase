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
import {
  DASHBOARD_URL, LABLEC, NAPOK, SZIN, YUME_URL, alapGombok, fejlec, mezo,
  oszlopok, rovidit, toltelek, trend, uzenet
} from './embed-kit.ts'

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

async function yumeStatistics (): Promise<unknown> {
  const [katalogus, tegnap, ma, het] = await Promise.all([
    queryOne<{ anime: number, episodes: number, users: number }>(
      `SELECT (SELECT count(*) FROM anime WHERE visibility = 'public')::int AS anime,
              (SELECT count(*) FROM episodes WHERE visibility = 'public')::int AS episodes,
              (SELECT count(*) FROM users)::int AS users`),
    queryOne<{ sessions: number, page_views: number, registrations: number }>(
      `SELECT sessions, page_views, registrations
         FROM analytics_daily WHERE day = current_date - 1`),
    queryOne<{ sessions: number, page_views: number, searches: number, episode_starts: number }>(
      `SELECT sessions, page_views, searches, episode_starts
         FROM analytics_daily WHERE day = current_date`),
    /*
     * A HÉT NAPJA A DIAGRAMHOZ. Hétfőtől vasárnapig, a napi összesítőből —
     * ugyanabból, amiből a panel is dolgozik. Ha egy napra nincs sor, az
     * nulla oszlop lesz, nem kihagyott: a hiányzó nap is információ.
     */
    query<{ dow: number, sessions: number }>(
      `SELECT extract(isodow FROM day)::int AS dow, sessions
         FROM analytics_daily
        WHERE day > current_date - 7 ORDER BY day`)
  ])

  const napi = Array.from({ length: 7 }, (_, i) =>
    het.find(h => h.dow === i + 1)?.sessions ?? 0)

  const valtozas = (mai: number | undefined, tegnapi: number | undefined): number | null =>
    mai === undefined || tegnapi === undefined ? null : mai - tegnapi

  return uzenet({
    author: fejlec('Statisztikák'),
    title: 'A YUME jelenlegi állapota',
    description: 'A katalógus és a mai forgalom — a saját adatbázisunkból.',
    fields: [
      mezo('📚 Animék', katalogus?.anime ?? null),
      mezo('🎬 Epizódok', katalogus?.episodes ?? null),
      mezo('👥 Felhasználók', katalogus?.users ?? null),
      mezo('🔥 Munkamenet (ma)', ma?.sessions ?? null, trend(valtozas(ma?.sessions, tegnap?.sessions), '')),
      mezo('👁️ Oldalletöltés (ma)', ma?.page_views ?? null, trend(valtozas(ma?.page_views, tegnap?.page_views), '')),
      mezo('🔎 Keresés (ma)', ma?.searches ?? null),
      mezo('▶️ Epizód indítás (ma)', ma?.episode_starts ?? null),
      mezo('✨ Regisztráció (tegnap)', tegnap?.registrations ?? null),
      toltelek(),
      {
        name: '📈 7 napos aktivitás',
        value: '```\n' + oszlopok(napi) + '\n' + NAPOK.join(' ') + '\n```',
        inline: false
      }
    ],
    footer: { text: LABLEC.text + ' • a frissítés idejét a Discord „szerkesztve" jelzése mutatja' }
  }, alapGombok([{ label: 'Statisztikák', url: `${YUME_URL}/#/home`, emoji: '📊' }]))
}

async function latestReleases (config: Record<string, unknown>): Promise<unknown> {
  const limit = Math.min(Math.max(Number(config.limit) || 8, 1), 10)
  const rows = await query<{
    id: string, anime_id: string, title: string, native: string | null,
    number: string, ep_cim: string | null, created_at: Date
  }>(
    `SELECT e.id, a.id AS anime_id, a.canonical_title AS title,
            (SELECT t.title FROM anime_titles t WHERE t.anime_id = a.id AND t.kind = 'native') AS native,
            CASE WHEN e.number = trunc(e.number) THEN trunc(e.number)::int::text ELSE e.number::text END AS number,
            e.title AS ep_cim, e.created_at
       FROM episodes e JOIN anime a ON a.id = e.anime_id
      WHERE e.visibility = 'public' AND a.visibility = 'public'
      -- A masodlagos rendezes nem disz: azonos created_at eseten a Postgres
      -- sorrendje nem determinisztikus, tehat ket egymas utani lekerdezes MAS
      -- sorrendet adhat -- es attol a tartalom ujjlenyomata is mas lesz.
      ORDER BY e.created_at DESC, e.id DESC LIMIT $1`, [limit])

  /*
   * A SORSZÁM HELYETT IDŐBÉLYEG-JELÖLŐ. A Discord `<t:…:R>` alakja a NÉZŐ
   * saját időzónájában és nyelvén jelenik meg („2 órája") — és ami még
   * fontosabb: a SZÖVEG nem változik renderelésenként, tehát az ujjlenyomat
   * sem. Egy magunk számolta „2 órája" percenként más lenne.
   */
  const sorok = rows.map(r => {
    const mikor = Math.floor(new Date(r.created_at).getTime() / 1000)
    const cim = r.ep_cim ? ` — ${rovidit(r.ep_cim, 60)}` : ''
    return `**${r.title}**\n\`${r.number}. rész\`${cim} · <t:${mikor}:R>\n${YUME_URL}/#/anime/${r.anime_id}`
  })

  return uzenet({
    author: fejlec('Új epizódok'),
    title: 'Most elérhető legfrissebb részek',
    description: sorok.length ? sorok.join('\n\n') : 'Még nincs publikus epizód a katalógusban.',
    ...(rows[0]?.native ? { footer: { text: `${LABLEC.text} • legfrissebb: ${rows[0].native}` } } : {})
  }, alapGombok([{ label: 'Összes epizód', url: `${YUME_URL}/#/home`, emoji: '📺' }]))
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

  const osszes = rows.reduce((n, r) => n + r.attempts, 0)
  const hibas = rows.reduce((n, r) => n + r.failures, 0)
  const arany = osszes > 0 ? Math.round((hibas / osszes) * 1000) / 10 : null

  return uzenet({
    author: fejlec('Forrásszolgáltatók'),
    title: 'Honnan játszunk le — elmúlt 24 óra',
    description: rows.length
      ? rows.map(r =>
        `${r.failures > 0 ? '⚠️' : '✅'} **${r.slug}**\n` +
        `\`${r.ok}/${r.attempts} sikeres\` · \`~${r.latency_avg} ms\``).join('\n')
      : 'Ebben az időszakban egyetlen szolgáltatói kérés sem futott.',
    fields: rows.length
      ? [
          mezo('📊 Kérés', osszes),
          mezo('⚠️ Hiba', hibas),
          // NULLA KÉRÉSNÉL NINCS ARÁNY, nem nulla százalék.
          mezo('📉 Hibaarány', arany === null ? null : `${arany}%`)
        ]
      : []
  }, alapGombok())
}

async function systemHealth (): Promise<unknown> {
  const [rows, gw] = await Promise.all([
    query<{ service: string, status: string, latency_ms: string | null, since: Date | null }>(
      'SELECT service, status, latency_ms, since FROM service_status ORDER BY service'),
    queryOne<{ status: string, reconnects: string, last_ready_at: Date | null }>(
      'SELECT status, reconnects, last_ready_at FROM discord_gateway_state WHERE id = 1')
  ])

  // A `not_configured` NEM HIBA — szándékosan nincs bekapcsolva.
  const jel = (status: string): string =>
    status === 'green' ? '🟢' : status === 'not_configured' ? '⚪' : status === 'unknown' ? '❔' : '🟡'

  /*
   * A KÉSLELTETÉS TÍZRE KEREKÍTVE — mérve, egy valódi hiba miatt.
   *
   * A `service_status` századmásodpercre pontos értéket tárol, és az
   * percenként ingadozik (28,9 → 3,2 → 11,4 ms). Ez VALÓDI változás, tehát
   * az ujjlenyomat is más lett, és az üzenet percenként módosult — napi
   * 1440 Discord-hívás egy szám remegése miatt.
   */
  const kerekit = (ms: string | null): string =>
    ms ? `${Math.round(Number(ms) / 10) * 10} ms` : '—'

  const elo = rows.filter(r => r.status !== 'not_configured')
  const kikapcsolt = rows.filter(r => r.status === 'not_configured')

  return uzenet({
    author: fejlec('Rendszer állapot'),
    title: 'Szolgáltatások és infrastruktúra',
    description: elo.length
      ? elo.map(r => `${jel(r.status)} **${r.service}** \`${kerekit(r.latency_ms)}\``).join('\n')
      : 'Nincs állapotadat.',
    fields: [
      mezo('🔌 Gateway', gw?.status ?? '—'),
      /*
       * AZ ÚJRACSATLAKOZÁSOK SZÁMA STABIL ADAT — nem ingadozik
       * percenként, tehát nem mozgatja az ujjlenyomatot. Egy „uptime"
       * viszont igen: az MINDEN másodpercben más, és ezért nincs itt.
       */
      mezo('♻️ Újracsatlakozás', Number(gw?.reconnects ?? 0)),
      mezo('⚪ Nincs bekapcsolva', kikapcsolt.length,
        kikapcsolt.length ? kikapcsolt.map(k => k.service).join(', ') : null)
    ],
    footer: { text: `${LABLEC.text} • ⚪ = szándékosan nincs bekapcsolva` }
  }, alapGombok([{ label: 'Rendszerállapot', url: `${DASHBOARD_URL}/#/health`, emoji: '🩺' }]))
}

/**
 * A DISCORD-SZERVER SZÁMAI.
 *
 * Ez az EGYETLEN üzenettípus, ami a Discordot is megszólítja renderelés
 * közben — a taglétszám nem a mi adatunk, és kitalálni nem lehet. Ha nincs
 * token vagy nem érjük el a szervert, „—" áll a szám helyén; nem nulla.
 *
 * AZ ONLINE LÉTSZÁM TÍZRE KEREKÍTVE, mert a jelenlét percenként ingadozik,
 * és nyersen minden körben új ujjlenyomatot adna.
 */
async function serverStatistics (ctx: RenderContext): Promise<unknown> {
  const [guild, kotott, csatornak, uzenetek, tagok] = await Promise.all([
    fetchGuild(ctx.guildId),
    queryOne<{ n: number }>(
      `SELECT count(DISTINCT l.user_id)::int AS n
         FROM discord_links l
         JOIN discord_guild_members m ON m.discord_user_id = l.discord_user_id
        WHERE m.guild_id = $1`, [ctx.guildId]),
    queryOne<{ csatorna: number, rang: number }>(
      `SELECT count(*) FILTER (WHERE object_type = 'channel')::int AS csatorna,
              count(*) FILTER (WHERE object_type = 'role')::int AS rang
         FROM discord_registry WHERE guild_id = $1 AND deleted_at IS NULL`, [ctx.guildId]),
    // A GATEWAY GYŰJTÉSÉBŐL. Ami a bekapcsolás előtt volt, az nem létezik.
    queryOne<{ ma: string, het: string }>(
      `SELECT coalesce(sum(messages) FILTER (WHERE day = current_date), 0)::text AS ma,
              coalesce(sum(messages), 0)::text AS het
         FROM discord_message_stats_daily
        WHERE guild_id = $1 AND day > current_date - 7`, [ctx.guildId]),
    queryOne<{ mai: number | null, joins: number | null, leaves: number | null }>(
      `SELECT (SELECT member_count FROM discord_member_stats_daily
                WHERE guild_id = $1 ORDER BY day DESC LIMIT 1) AS mai,
              (SELECT sum(joins)::int FROM discord_member_stats_daily
                WHERE guild_id = $1 AND day > current_date - 7) AS joins,
              (SELECT sum(leaves)::int FROM discord_member_stats_daily
                WHERE guild_id = $1 AND day > current_date - 7) AS leaves`, [ctx.guildId])
  ])

  const kerekit = (n: number | null | undefined): number | null =>
    n === null || n === undefined ? null : Math.round(n / 10) * 10

  const merunkUzenetet = Number(uzenetek?.het ?? 0) > 0

  return uzenet({
    author: fejlec('Szerver áttekintés'),
    title: guild?.name ? `${guild.name} — a szerver számai` : 'A szerver számai',
    description: 'Discord-szerverstatisztika · a bot saját méréséből.',
    fields: [
      mezo('👥 Összes tag', guild?.memberCount ?? tagok?.mai ?? null),
      mezo('🔥 Online (kb.)', kerekit(guild?.onlineCount)),
      mezo('🌸 YUME-fiókkal', kotott?.n ?? null),
      mezo('💬 Üzenet (ma)', merunkUzenetet ? Number(uzenetek?.ma ?? 0) : null,
        merunkUzenetet ? null : 'gateway kell hozzá'),
      /*
       * A BE- ÉS KILÉPÉS PRIVILEGIZÁLT INTENTET IGÉNYEL. A `null` azt
       * jelenti, hogy NEM MÉRJÜK — a nulla azt állítaná, hogy senki nem
       * lépett be. A kettő nem ugyanaz.
       */
      mezo('➕ Csatlakozás (7 nap)', tagok?.joins ?? null,
        tagok?.joins === null ? 'privilegizált intent kell' : null),
      mezo('➖ Kilépés (7 nap)', tagok?.leaves ?? null,
        tagok?.leaves === null ? 'privilegizált intent kell' : null),
      mezo('🗂️ Csatorna', csatornak?.csatorna ?? null, 'a YUME kezeli'),
      mezo('🛡️ Szerepkör', csatornak?.rang ?? null, 'a YUME kezeli'),
      toltelek()
    ],
    footer: {
      text: guild === null
        ? `${LABLEC.text} • a Discord létszámai nem érhetők el`
        : `${LABLEC.text} • az online létszám tízre kerekítve`
    }
  }, alapGombok())
}

/**
 * A KÖVETKEZŐ EPIZÓDOK — a katalógus menetrendjéből, NAPOKRA BONTVA.
 *
 * AZ IDŐPONT DISCORD-JELÖLŐVEL megy ki (`<t:…:t>`): a néző a SAJÁT
 * időzónájában látja, és a szöveg nem változik renderelésenként — tehát az
 * ujjlenyomatot sem mozgatja. Egy magunk formázott „18:30" egy másik
 * időzónában rossz volna, egy relatív „2 óra múlva" pedig percenként más.
 */
async function animeSchedule (config: Record<string, unknown>): Promise<unknown> {
  const limit = Math.min(Math.max(Number(config.limit) || 10, 1), 15)
  const rows = await query<{ id: string, title: string, ep: number | null, at: Date }>(
    `SELECT id, canonical_title AS title, next_airing_ep AS ep, next_airing_at AS at
       FROM anime
      WHERE visibility = 'public' AND next_airing_at > now()
      -- Azonos időpontnál a cím dönt; enélkül a sorrend futásonként más
      -- lehetne, es az ujjlenyomat is (lasd a latestReleases-t).
      ORDER BY next_airing_at, canonical_title LIMIT $1`, [limit])

  /** Napokra bontva, ahogy a tervrajz mutatja. */
  const napok = new Map<string, typeof rows>()
  for (const r of rows) {
    const nap = new Date(r.at).toISOString().slice(0, 10)
    const lista = napok.get(nap) ?? []
    lista.push(r)
    napok.set(nap, lista)
  }

  const HETNAP = ['vasárnap', 'hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat']
  const mezok = [...napok.entries()].slice(0, 6).map(([nap, lista]) => {
    const d = new Date(nap + 'T00:00:00Z')
    return {
      name: `📅 ${nap} — ${HETNAP[d.getUTCDay()]}`,
      value: lista.map(r => {
        const mikor = Math.floor(new Date(r.at).getTime() / 1000)
        return `<t:${mikor}:t> · **${rovidit(r.title, 45)}**${r.ep !== null ? ` \`${r.ep}. rész\`` : ''}`
      }).join('\n').slice(0, 1024),
      inline: false
    }
  })

  return uzenet({
    author: fejlec('Adásmenetrend'),
    title: 'Következő epizódok a héten',
    description: rows.length
      ? 'Az időpontok a te időzónádban jelennek meg.'
      : 'A katalógusban egyetlen animéhez sincs jövőbeli adásidő.',
    fields: mezok
  }, alapGombok([{ label: 'Teljes menetrend', url: `${YUME_URL}/#/home`, emoji: '📅' }]))
}

/**
 * A LEGNÉZETTEBB CÍMEK — a napi összesítőből, nem nyers eseményből.
 *
 * Hét nap, mert egyetlen nap egy kis forgalmú oldalon egyetlen látogató
 * ízlését mutatná. A megtekintések az `anime_stats_daily`-ből jönnek, abból
 * a táblából, amiből a kimutatás is dolgozik — nem külön számolunk.
 *
 * NEM ÁLLÍTUNK ELŐ RANGSORT HIÁNYOS ADATBÓL: ha egyetlen címnél sem volt
 * megtekintés, üres állapot megy ki, nem egy nullákból épített lista.
 */
async function popularAnime (config: Record<string, unknown>): Promise<unknown> {
  const limit = Math.min(Math.max(Number(config.limit) || 10, 1), 10)
  const days = Math.min(Math.max(Number(config.days) || 7, 1), 30)
  const rows = await query<{ id: string, title: string, views: number, viewers: number, ep: number | null }>(
    `SELECT a.id, a.canonical_title AS title,
            sum(s.views)::int AS views,
            sum(s.unique_viewers)::int AS viewers,
            a.episode_count AS ep
       FROM anime_stats_daily s
       JOIN anime a ON a.id = s.anime_id
      WHERE s.day >= current_date - $2::int AND a.visibility = 'public'
      GROUP BY a.id, a.canonical_title, a.episode_count
     HAVING sum(s.views) > 0
      ORDER BY sum(s.views) DESC, a.canonical_title
      LIMIT $1`, [limit, days])

  const HELYEZES = ['🥇', '🥈', '🥉']

  return uzenet({
    author: fejlec('Népszerű animék'),
    title: `A legnézettebb címek — elmúlt ${days} nap`,
    description: rows.length
      ? rows.map((r, i) =>
        `${HELYEZES[i] ?? `\`${String(i + 1).padStart(2, ' ')}.\``} **${rovidit(r.title, 42)}**\n` +
        `　👁️ ${r.views.toLocaleString('hu-HU')} megtekintés · 👤 ${r.viewers.toLocaleString('hu-HU')} néző` +
        (r.ep ? ` · \`${r.ep} rész\`` : '')).join('\n')
      : 'Ebben az időszakban egyetlen címnél sem mértünk megtekintést.',
    footer: { text: `${LABLEC.text} • forrás: napi összesítő, ${days} nap` }
  }, alapGombok([{ label: 'Katalógus', url: `${YUME_URL}/#/home`, emoji: '🔥' }]))
}

/**
 * A BOT ÁLLAPOTA — ebben a szerverben.
 *
 * NINCS BENNE IDŐBÉLYEG, ÉS EZ NEM ESZTÉTIKAI DÖNTÉS. Ez az üzenet a saját
 * frissítéseiről számol be: ha kiírná, mikor frissült utoljára, a tartalma
 * MINDEN körben megváltozna — az üzenet önmagát hajtaná, percenként,
 * örökké. A parancsstatisztika ugyanezért 24 órás ablak helyett a mai napra
 * összesít: az óráról órára csúszó ablak minden körben más számot adna.
 */
async function botStatus (ctx: RenderContext): Promise<unknown> {
  const [rows, parancsok, gw, esemenyek] = await Promise.all([
    query<{
      message_type: string, enabled: boolean, failure_count: number,
      last_error: string | null, has_message: boolean
    }>(
      `SELECT message_type, enabled, failure_count, last_error,
              (message_id IS NOT NULL) AS has_message
         FROM persistent_messages WHERE guild_id = $1 ORDER BY message_type`,
      [ctx.guildId]),
    /*
     * A PARANCSHASZNÁLAT A MAI NAPRA. Az egységes eseménysémából — abból,
     * amibe a parancskezelő ír.
     */
    query<{ subject_id: string, n: string }>(
      `SELECT subject_id, count(*)::text AS n
         FROM analytics_events
        WHERE event_type = 'discord.command.use'
          AND created_at >= current_date
        GROUP BY subject_id ORDER BY count(*) DESC LIMIT 5`),
    queryOne<{ status: string, reconnects: string }>(
      'SELECT status, reconnects FROM discord_gateway_state WHERE id = 1'),
    query<{ event: string, n: string }>(
      `SELECT e.event, count(*)::text AS n
         FROM persistent_message_events e
         JOIN persistent_messages m ON m.id = e.message_id
        WHERE m.guild_id = $1 AND e.at >= current_date
        GROUP BY e.event`, [ctx.guildId])
  ])

  const hibas = rows.filter(r => r.failure_count > 0)
  const aktiv = rows.filter(r => r.enabled)
  const kihagyva = Number(esemenyek.find(e => e.event === 'skipped')?.n ?? 0)
  const modositva = Number(esemenyek.find(e => e.event === 'edited')?.n ?? 0)
  const osszesParancs = parancsok.reduce((n, p) => n + Number(p.n), 0)

  return uzenet({
    author: fejlec('Bot statisztikák'),
    title: 'Parancsok, üzenetek és állapot',
    description: rows.length
      ? rows.map(r => {
          const jel = !r.enabled ? '⚪' : r.failure_count > 0 ? '🔴' : r.has_message ? '🟢' : '🕓'
          const meg = !r.enabled
            ? 'letiltva'
            : r.failure_count > 0
              ? `${r.failure_count} sikertelen kísérlet — ${rovidit(r.last_error, 80) || 'ismeretlen hiba'}`
              : r.has_message ? 'kint van' : 'még nem ment ki'
          return `${jel} **${r.message_type}** · ${meg}`
        }).join('\n')
      : 'Ebben a szerverben még nincs tartós üzenet.',
    fields: [
      mezo('⌨️ Parancs (ma)', osszesParancs),
      mezo('🔌 Gateway', gw?.status ?? '—'),
      mezo('♻️ Újracsatlakozás', Number(gw?.reconnects ?? 0)),
      /*
       * A `skipped` A LEGFONTOSABB SZÁM, pedig a legunalmasabbnak tűnik: azt
       * mutatja, hogy a tartalom nem változott, tehát a bot NEM küldött
       * felesleges kérést. Ha ez eltűnik, valami minden körben módosul.
       */
      mezo('💤 Kihagyott frissítés (ma)', kihagyva, 'nem változott a tartalom'),
      mezo('✏️ Módosítás (ma)', modositva),
      mezo('🔴 Hibás üzenet', hibas.length),
      ...(parancsok.length
        ? [{
            name: '🏆 Legtöbbet használt parancsok (ma)',
            value: parancsok.map((p, i) => `\`${i + 1}.\` /${p.subject_id} — **${p.n}**`).join('\n'),
            inline: false
          }]
        : [])
    ],
    footer: { text: `${LABLEC.text} • ⚪ letiltva · 🕓 még nem ment ki · 🔴 hibás` }
  }, alapGombok([{ label: 'Bot állapota', url: `${DASHBOARD_URL}/#/health`, emoji: '🤖' }]))
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
