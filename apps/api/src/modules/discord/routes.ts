/**
 * `/v1/discord` — a tartós üzenetek vezérlése.
 *
 * MINDEN VÉGPONT HÁROM KAPUN MEGY ÁT, ebben a sorrendben:
 *
 *   1. hitelesítés (a YUME meglévő session-rendszere),
 *   2. guild-hozzáférés (`guild-access.ts`) — MINDEN kérésnél újra,
 *   3. bemenet-ellenőrzés (séma).
 *
 * A HARMADIK NEM HELYETTESÍTI A MÁSODIKAT. Egy érvényes alakú `guildId` még
 * nem jelenti, hogy a hívónak köze van hozzá — és ez az a hiba, amitől egy
 * szerver adminja egy másik szerver adatait látná.
 */

import { audit } from '../audit/audit.ts'
import { query, queryOne } from '../../infrastructure/database/index.ts'
import { guildAccess } from './guild-access.ts'
import { createRestClient, diagnoseChannel, fetchChannels, fetchGuild, fetchRoles, isConfigured } from './rest-client.ts'
import { allapot as gatewayAllapot, elo as gatewayElo, intentsFromEnv, INTENTS } from './gateway.ts'
import { findById, listForGuild, recreateMessage, syncMessage, type PersistentMessage } from './persistent-messages.ts'
import { renderMessage, MESSAGE_TYPES } from './render.ts'
import * as oauth from './oauth.ts'
import { can, parsePermissions } from './permissions.ts'

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'

/** Discord-azonosító: csak számjegy. Lásd `rest-client.ts` `safeId`. */
const SNOWFLAKE = { type: 'string', pattern: '^[0-9]{17,20}$' } as const

const GUILD_PARAMS = {
  type: 'object',
  required: ['guildId'],
  additionalProperties: false,
  properties: { guildId: SNOWFLAKE }
} as const

const MESSAGE_PARAMS = {
  type: 'object',
  required: ['guildId', 'id'],
  additionalProperties: false,
  properties: { guildId: SNOWFLAKE, id: { type: 'string', format: 'uuid' } }
} as const

/**
 * A kapu.
 *
 * A HIBAVÁLASZ NEM ÁRUL EL TÖBBET A KELLETÉNÉL. Egy „nincs ilyen guild" és
 * egy „nincs jogod" megkülönböztetése megmondaná egy idegennek, hogy melyik
 * guildeket kezeljük — ezért mindkettő 403.
 */
/**
 * Birtokolja-e a hívó ezt a YUME-jogosultságot.
 *
 * UGYANAZ A MINTA, MINT A FÓRUMMODULBAN, és ez nem véletlen: a
 * `permission-status` teszt forráskódból gyűjti össze, mely jogosultságokat
 * érvényesítünk, és két alakot ismer fel — a route-kaput és ezt a
 * segédfüggvényt, EZEN a néven. Egy saját nevű változattal a jogosultság
 * „senki nem érvényesíti"-ként jelenne meg a katalógusban, pedig
 * érvényesítjük; csak nem kapuként, mert két út is bevezet.
 *
 * (A megjegyzésben szándékosan nem írom le a keresett alakok mintáit: a
 * szkenner a KOMMENTET IS OLVASSA, és egy példa `'x'` szlug valódi
 * használatnak látszana. Ez már megtörtént — ez a mondat a javítás.)
 */
async function holds (request: FastifyRequest, slug: string): Promise<boolean> {
  if (!request.user) return false
  const row = await queryOne(
    `SELECT 1 FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = $1 AND p.slug = $2`,
    [(request.user as { sub: string }).sub, slug])
  return !!row
}

async function gate (
  request: FastifyRequest, reply: FastifyReply, capability: Parameters<typeof guildAccess>[1]
): Promise<string | null> {
  const { guildId } = request.params as { guildId: string }
  const decision = await guildAccess(guildId, capability, {
    userId: (request.user as { sub: string }).sub,
    hasPermission: async () => await holds(request, 'discord.manage')
  })

  if (!decision.allowed) {
    await reply.code(403).send({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      // A RÖVID OK MEHET: az üzemeltetőnek meg kell tudnia, hogy a fiókja
      // nincs összekötve, vagy a jogosultsága járt le. Az nem árulja el,
      // hogy a guild létezik-e nálunk.
      detail: decision.reason
    })
    return null
  }
  return guildId
}

function publicView (row: PersistentMessage): Record<string, unknown> {
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    messageType: row.message_type,
    configuration: row.configuration,
    enabled: row.enabled,
    lastUpdatedAt: row.last_updated_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    failureCount: row.failure_count,
    version: row.version
  }
}

const routes: FastifyPluginAsync = async fastify => {
  // ---- a rendszer állapota -----------------------------------------------

  /**
   * Be van-e egyáltalán kötve a bot.
   *
   * SAJÁT VÉGPONT, mert enélkül minden más hibája „valami nem megy" volna. A
   * felület ebből tudja, hogy a hiányzó tokenre kell figyelmeztetnie, nem a
   * beállításokat kell javítgatni.
   */
  fastify.get('/status', { onRequest: fastify.authenticate }, async () => ({
    configured: isConfigured(),
    messageTypes: MESSAGE_TYPES
  }))

  // ---- OAuth --------------------------------------------------------------

  /**
   * A folyamat indítása.
   *
   * A FELHASZNÁLÓ MÁR BE VAN JELENTKEZVE A YUME-BA — ez nem bejelentkezés,
   * hanem fiók-összekötés. Ezért kell hitelesítés MÁR ITT: tudnunk kell,
   * KINEK a fiókjához kötjük a Discordot.
   */
  fastify.post('/oauth/start', { onRequest: fastify.authenticate }, async (request, reply) => {
    if (!oauth.isConfigured()) {
      return await reply.code(503).send({
        type: 'about:blank', title: 'Service Unavailable', status: 503,
        detail: 'nincs beállítva Discord OAuth'
      })
    }
    const userId = (request.user as { sub: string }).sub
    const state = await oauth.createState(userId)
    return { url: oauth.authorizeUrl(state) }
  })

  /**
   * A visszairányítás.
   *
   * NINCS `onRequest: authenticate`, ÉS EZ SZÁNDÉKOS. A Discord egy
   * átirányítással hozza ide a böngészőt; a kérésben nincs `Authorization`
   * fejléc, mert nem a mi kliensünk küldi. A hívót a `state` azonosítja —
   * azt mi adtuk ki, egy bejelentkezett felhasználónak, és egyszer
   * használható.
   *
   * A VÁLASZ ÁTIRÁNYÍTÁS, NEM JSON: a böngésző van a vonal végén, nem egy
   * program. A hiba is átirányítás, mert egy JSON-hibalap a felhasználónak
   * zsákutca.
   */
  fastify.get('/oauth/callback', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: true,
        properties: {
          code: { type: 'string', maxLength: 512 },
          state: { type: 'string', maxLength: 512 },
          error: { type: 'string', maxLength: 128 }
        }
      }
    }
  }, async (request, reply) => {
    const q = request.query as { code?: string, state?: string, error?: string }
    const vissza = (allapot: string): void => {
      // A cél a vezérlőpult, nem egy API-válasz.
      void reply.redirect(`/#/admin/discord?link=${encodeURIComponent(allapot)}`)
    }

    // A felhasználó elutasította az engedélyt. Ez nem hiba, csak nem igen.
    if (q.error) return vissza('cancelled')
    if (!q.code || !q.state) return vissza('invalid')

    const userId = await oauth.consumeState(q.state)
    if (!userId) {
      /*
       * ISMERETLEN VAGY LEJÁRT ÁLLAPOT. Nem mondjuk meg, melyik: egy
       * támadónak a kettő megkülönböztetése is információ.
       */
      return vissza('expired')
    }

    try {
      const account = await oauth.completeLink(userId, q.code)
      await audit(userId, 'discord.account.link', 'user', userId, null,
        // A Discord-azonosító nem titok, a token igen — az utóbbi ide sem kerül.
        { discordUserId: account.discordUserId, guilds: account.guilds })
      return vissza('ok')
    } catch (error) {
      const uzenet = String((error as Error)?.message ?? '')
      // A „már más fiókhoz van kötve" eset a felhasználónak érthető üzenet.
      return vissza(uzenet.includes('másik YUME-fiókhoz') ? 'taken' : 'failed')
    }
  })

  /** Az összekötés állapota — a felület ebből tudja, mit mutasson. */
  fastify.get('/oauth/link', { onRequest: fastify.authenticate }, async request => {
    const userId = (request.user as { sub: string }).sub
    const link = await oauth.linkOf(userId)
    if (!link) return { linked: false, configured: oauth.isConfigured() }

    const guilds = await query<{ guild_id: string, guild_name: string | null, owner: boolean, permissions: string, fetched_at: Date }>(
      `SELECT guild_id, guild_name, owner, permissions, fetched_at
         FROM discord_guild_members WHERE discord_user_id = $1 ORDER BY guild_name NULLS LAST`,
      [link.discordUserId])

    return {
      linked: true,
      configured: oauth.isConfigured(),
      username: link.username,
      linkedAt: link.linkedAt,
      /*
       * CSAK AZOK A GUILDEK, AMIKHEZ TÉNYLEG VAN JOGA. Egy teljes lista
       * megmondaná, mely szervereknek tagja — az a vezérlőpultnak nem kell,
       * és más felhasználók előtt sem tartozik ránk.
       */
      guilds: guilds
        .filter(g => can({ owner: g.owner, permissions: parsePermissions(g.permissions) }, 'view_stats'))
        .map(g => ({ id: g.guild_id, name: g.guild_name, owner: g.owner, fetchedAt: g.fetched_at }))
    }
  })

  /** Az összekötés bontása. */
  fastify.delete('/oauth/link', { onRequest: fastify.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub
    const volt = await oauth.unlink(userId)
    if (volt) await audit(userId, 'discord.account.unlink', 'user', userId, null, null)
    return await reply.code(volt ? 204 : 404).send()
  })

  // ---- a vezérlőpult nézetei ---------------------------------------------
  //
  // MI VAN VALÓS ADATTAL, ÉS MI NINCS — mert ezt nem elkenni kell, hanem
  // kimondani. A bot REST-en a következőket tudja lekérdezni privilegizált
  // intent NÉLKÜL: a guild közelítő létszámait, a csatornákat és a
  // szerepköröket. Ezek tehát valós adattal működnek.
  //
  // AMI GATEWAY NÉLKÜL NEM LÉTEZIK: üzenetforgalom, csatlakozás/kilépés
  // idősora, parancshasználat, jelenlét. Ezekhez folyamatos
  // WebSocket-kapcsolat kell, és a taglistához a fejlesztői portálon
  // engedélyezett `GUILD_MEMBERS` privilegizált intent. Amíg ezek nincsenek,
  // a felület AZT ÍRJA KI, hogy nincs adatforrás — nem nullákat mutat.

  /** A guild áttekintése: létszám, csatornák, szerepkörök, üzenetek. */
  fastify.get('/guilds/:guildId/overview', {
    onRequest: fastify.authenticate,
    schema: { params: GUILD_PARAMS }
  }, async (request, reply) => {
    const guildId = await gate(request, reply, 'view_stats')
    if (!guildId) return

    const [guild, csatornak, szerepek, uzenetek, kotott] = await Promise.all([
      fetchGuild(guildId),
      fetchChannels(guildId),
      fetchRoles(guildId),
      query<{ total: string, enabled: string, failing: string, posted: string }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE enabled)::text AS enabled,
                count(*) FILTER (WHERE failure_count > 0)::text AS failing,
                count(*) FILTER (WHERE message_id IS NOT NULL)::text AS posted
           FROM persistent_messages WHERE guild_id = $1`, [guildId]),
      queryOne<{ n: string }>(
        `SELECT count(DISTINCT l.user_id)::text AS n
           FROM discord_links l
           JOIN discord_guild_members m ON m.discord_user_id = l.discord_user_id
          WHERE m.guild_id = $1`, [guildId])
    ])

    return {
      configured: isConfigured(),
      guild: guild === null
        ? null
        : { name: guild.name, memberCount: guild.memberCount, onlineCount: guild.onlineCount },
      channels: csatornak === null ? null : csatornak.length,
      roles: szerepek === null ? null : szerepek.length,
      messages: uzenetek[0] ?? null,
      linkedAccounts: Number(kotott?.n ?? 0)
    }
  })

  /** A csatornák — valós adat, privilegizált intent nélkül is. */
  fastify.get('/guilds/:guildId/channels', {
    onRequest: fastify.authenticate,
    schema: { params: GUILD_PARAMS }
  }, async (request, reply) => {
    const guildId = await gate(request, reply, 'view_stats')
    if (!guildId) return
    const lista = await fetchChannels(guildId)
    /*
     * A NULL ÉS AZ ÜRES LISTA KÜLÖNBSÉGE. Az első azt jelenti, hogy nem
     * tudtuk lekérdezni (nincs token, vagy a bot nem tagja a szervernek); a
     * második azt, hogy tényleg nincs csatorna. Üres listát adni az elsőre
     * hazugság volna.
     */
    if (lista === null) {
      return { available: false, reason: isConfigured() ? 'a bot nem éri el ezt a szervert' : 'nincs bot token', data: [] }
    }
    return { available: true, reason: null, data: lista }
  })

  /** A szerepkörök — szintén valós adat. */
  fastify.get('/guilds/:guildId/roles', {
    onRequest: fastify.authenticate,
    schema: { params: GUILD_PARAMS }
  }, async (request, reply) => {
    const guildId = await gate(request, reply, 'view_stats')
    if (!guildId) return
    const lista = await fetchRoles(guildId)
    if (lista === null) {
      return { available: false, reason: isConfigured() ? 'a bot nem éri el ezt a szervert' : 'nincs bot token', data: [] }
    }
    return { available: true, reason: null, data: lista }
  })

  /**
   * A BOT EGÉSZSÉGE — és ami nincs, arról is beszámol.
   *
   * A `capabilities` mező NEM dísz: ez mondja meg a felületnek, melyik
   * nézetnek van egyáltalán adatforrása. Enélkül minden üres nézet
   * meghibásodásnak látszana.
   */
  fastify.get('/guilds/:guildId/health', {
    onRequest: fastify.authenticate,
    schema: { params: GUILD_PARAMS }
  }, async (request, reply) => {
    const guildId = await gate(request, reply, 'view_stats')
    if (!guildId) return

    const [szondak, esemenyek, hibasak, gw] = await Promise.all([
      query<{ service: string, status: string, latency_ms: string | null, detail: string | null, checked_at: Date }>(
        `SELECT service, status, latency_ms, left(detail, 200) AS detail, checked_at
           FROM service_status WHERE service LIKE 'discord%' ORDER BY service`),
      query<{ event: string, n: string }>(
        `SELECT e.event, count(*)::text AS n
           FROM persistent_message_events e
           JOIN persistent_messages m ON m.id = e.message_id
          WHERE m.guild_id = $1 AND e.at > now() - interval '24 hours'
          GROUP BY e.event ORDER BY count(*) DESC`, [guildId]),
      query<{ message_type: string, failure_count: number, last_error: string | null }>(
        `SELECT message_type, failure_count, left(last_error, 200) AS last_error
           FROM persistent_messages WHERE guild_id = $1 AND failure_count > 0
          ORDER BY failure_count DESC`, [guildId]),
      gatewayAllapot()
    ])

    /*
     * A GATEWAY ÉLŐSÉGE NEM A SAJÁT ÁLLÍTÁSÁBÓL JÖN. Egy lefagyott folyamat
     * `ready` állapotban hagyja a sort, és onnantól a felület örökké azt
     * hinné, hogy gyűjtünk. Az utolsó esemény ideje a valódi jel.
     */
    const gwElo = gatewayElo(gw)
    const tagIntent = (Number(gw?.intents ?? 0) & INTENTS.GUILD_MEMBERS) !== 0

    return {
      configured: isConfigured(),
      probes: szondak,
      events24h: esemenyek,
      failing: hibasak,
      /*
       * AMI MŰKÖDIK, ÉS AMI NEM — a felület ebből tudja, mit mutasson.
       * A gateway nélküli nézetek nem „üresek", hanem nincs adatforrásuk.
       */
      gateway: gw === undefined
        ? null
        : {
            status: gw.status,
            live: gwElo,
            lastReadyAt: gw.last_ready_at ?? null,
            lastEventAt: gw.last_event_at ?? null,
            reconnects: Number(gw.reconnects ?? 0),
            lastError: gw.last_error ?? null,
            memberIntent: tagIntent,
            wantedIntents: intentsFromEnv()
          },
      capabilities: {
        rest: isConfigured(),
        gateway: gwElo,
        /*
         * A TAGMOZGÁS KÉT DOLOGTÓL FÜGG: fusson a gateway, ÉS legyen
         * engedélyezve a privilegizált intent. A kettő közül bármelyik
         * hiányzik, az adat nem létezik — és ezt a felület kiírja, nem
         * nullát mutat.
         */
        memberAnalytics: gwElo && tagIntent,
        messageAnalytics: gwElo,
        commandAnalytics: false
      }
    }
  })

  /**
   * AKTIVITÁS — üzenetszám és taglétszám az időben.
   *
   * CSAK A GATEWAY ÁLTAL GYŰJTÖTT ADAT. Ami a bekapcsolás előtt történt, az
   * nem létezik: a Discord az eseményeket akkor küldi, amikor
   * megtörténnek, és visszamenőleg nem kérdezhetők le. A válasz ezért
   * megmondja, MIÓTA van adat — enélkül egy 30 napos nézet hibásnak
   * látszana.
   */
  fastify.get('/guilds/:guildId/activity', {
    onRequest: fastify.authenticate,
    schema: {
      params: GUILD_PARAMS,
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { days: { type: 'integer', minimum: 1, maximum: 90 } }
      }
    }
  }, async (request, reply) => {
    const guildId = await gate(request, reply, 'view_stats')
    if (!guildId) return
    const { days } = request.query as { days?: number }
    const ablak = days ?? 30

    const [napok, csatornak, tagok, fedes, gw] = await Promise.all([
      query(
        `SELECT day::text AS day,
                sum(messages)::bigint AS messages,
                sum(bot_messages)::bigint AS bot_messages
           FROM discord_message_stats_daily
          WHERE guild_id = $1 AND day >= current_date - $2::int
          GROUP BY day ORDER BY day`, [guildId, ablak]),
      query(
        `SELECT channel_id, sum(messages)::bigint AS messages, sum(bot_messages)::bigint AS bot_messages
           FROM discord_message_stats_daily
          WHERE guild_id = $1 AND day >= current_date - $2::int
          GROUP BY channel_id ORDER BY sum(messages) DESC LIMIT 25`, [guildId, ablak]),
      query(
        `SELECT day::text AS day, member_count, joins, leaves
           FROM discord_member_stats_daily
          WHERE guild_id = $1 AND day >= current_date - $2::int
          ORDER BY day`, [guildId, ablak]),
      queryOne<{ since: string | null }>(
        `SELECT min(day)::text AS since FROM discord_message_stats_daily WHERE guild_id = $1`, [guildId]),
      gatewayAllapot()
    ])

    return {
      window: { days: ablak },
      // MIÓTA VAN ADAT. Null = a gateway még egyetlen üzenetet sem látott
      // ebben a szerverben.
      since: fedes?.since ?? null,
      live: gatewayElo(gw),
      memberIntent: (Number(gw?.intents ?? 0) & INTENTS.GUILD_MEMBERS) !== 0,
      days: napok,
      channels: csatornak,
      members: tagok
    }
  })

  /**
   * A NAPLÓ — a MI oldalunkról, nem a Discordéról.
   *
   * A Discord saját audit logja külön jogosultságot igényel, és arról szól,
   * ki mit csinált A SZERVEREN. Ez arról szól, ki mit csinált ITT: ki hozott
   * létre, módosított, küldött újra tartós üzenetet. Ez a mi
   * felelősségünk, és ezt tudjuk hitelesen megmondani.
   */
  fastify.get('/guilds/:guildId/audit', {
    onRequest: fastify.authenticate,
    schema: {
      params: GUILD_PARAMS,
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } }
      }
    }
  }, async (request, reply) => {
    const guildId = await gate(request, reply, 'view_stats')
    if (!guildId) return
    const { limit } = request.query as { limit?: number }

    const sorok = await query(
      `SELECT a.action, a.subject_id, a.after, a.created_at,
              u.username AS actor
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.action LIKE 'discord.%' AND a.subject_id LIKE $1
        ORDER BY a.created_at DESC LIMIT $2`,
      [`discord:${guildId}:%`, limit ?? 50])
    return { data: sorok }
  })

  /**
   * ÉRTESÍTÉSEK — a webhookok kézbesítése.
   *
   * VALÓS ADAT, gateway nélkül is: ezt a YUME maga küldi, és maga is
   * naplózza. A `webhook_deliveries` tábla a forrás.
   */
  fastify.get('/guilds/:guildId/notifications', {
    onRequest: fastify.authenticate,
    schema: {
      params: GUILD_PARAMS,
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } }
      }
    }
  }, async (request, reply) => {
    const guildId = await gate(request, reply, 'view_stats')
    if (!guildId) return
    const { limit } = request.query as { limit?: number }

    const [osszesites, utolsok] = await Promise.all([
      query<{ event: string, total: string, failed: string }>(
        `SELECT event, count(*)::text AS total,
                count(*) FILTER (WHERE status_code IS NULL OR status_code >= 400)::text AS failed
           FROM webhook_deliveries
          WHERE created_at > now() - interval '7 days'
          GROUP BY event ORDER BY count(*) DESC`),
      query(
        // A `payload` NEM megy ki: tartalmazhat olyat, ami nem tartozik a
        // vezérlőpultra. A kézbesítés ténye és a hibája elég.
        `SELECT d.event, d.status_code, d.duration_ms, left(d.error, 200) AS error,
                d.created_at, w.name AS webhook
           FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
          ORDER BY d.created_at DESC LIMIT $1`,
        [limit ?? 25])
    ])
    return { summary: osszesites, recent: utolsok }
  })

  // ---- tartós üzenetek ----------------------------------------------------

  fastify.get('/guilds/:guildId/persistent-messages', {
    onRequest: fastify.authenticate,
    schema: { params: GUILD_PARAMS }
  }, async (request, reply) => {
    const guildId = await gate(request, reply, 'view_stats')
    if (!guildId) return
    return { data: (await listForGuild(guildId)).map(publicView) }
  })

  fastify.post('/guilds/:guildId/persistent-messages', {
    onRequest: fastify.authenticate,
    schema: {
      params: GUILD_PARAMS,
      body: {
        type: 'object',
        required: ['channelId', 'messageType'],
        additionalProperties: false,
        properties: {
          channelId: SNOWFLAKE,
          messageType: { type: 'string', enum: MESSAGE_TYPES },
          configuration: { type: 'object' },
          enabled: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const guildId = await gate(request, reply, 'manage_messages')
    if (!guildId) return
    const body = request.body as {
      channelId: string, messageType: string,
      configuration?: Record<string, unknown>, enabled?: boolean
    }

    /*
     * A DUPLIKÁCIÓT AZ ADATBÁZIS DÖNTI EL, nem egy előzetes lekérdezés. Két
     * egyidejű kérés a „megnézem, van-e már" mintával mindkettőnek azt
     * mondaná, hogy nincs — és két üzenet jönne létre. A részleges egyedi
     * index (guild + típus, ahol engedélyezett) ezt kizárja.
     */
    try {
      const row = await queryOne<PersistentMessage>(
        `INSERT INTO persistent_messages (guild_id, channel_id, message_type, configuration, enabled)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [guildId, body.channelId, body.messageType, body.configuration ?? {}, body.enabled ?? true])
      await audit((request.user as { sub: string }).sub, 'discord.persistent_message.create',
        'config', `discord:${guildId}:${body.messageType}`, null, { channelId: body.channelId })
      return await reply.code(201).send(publicView(row!))
    } catch (error) {
      if (String((error as { code?: string }).code) === '23505') {
        return await reply.code(409).send({
          type: 'about:blank', title: 'Conflict', status: 409,
          detail: 'ehhez a guildhez már van ilyen típusú aktív üzenet'
        })
      }
      throw error
    }
  })

  fastify.patch('/guilds/:guildId/persistent-messages/:id', {
    onRequest: fastify.authenticate,
    schema: {
      params: MESSAGE_PARAMS,
      body: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: {
          channelId: SNOWFLAKE,
          configuration: { type: 'object' },
          enabled: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const guildId = await gate(request, reply, 'manage_messages')
    if (!guildId) return
    const { id } = request.params as { id: string }
    const body = request.body as { channelId?: string, configuration?: unknown, enabled?: boolean }

    /*
     * A `guild_id` A `WHERE`-BEN VAN, nem csak a kapuban. Enélkül egy
     * érvényes azonosítóval egy MÁSIK guild üzenetét lehetne módosítani,
     * miközben a kapu a sajátunkra engedett be. Ez a legkönnyebben
     * elrontható pont az egész modulban.
     */
    const row = await queryOne<PersistentMessage>(
      `UPDATE persistent_messages
          SET channel_id    = COALESCE($3, channel_id),
              configuration = COALESCE($4::jsonb, configuration),
              enabled       = COALESCE($5, enabled),
              -- A csatorna cseréje ÚJ üzenetet igényel: a régi azonosító a
              -- régi csatornára mutat, és ott már nem módosítható.
              message_id    = CASE WHEN $3 IS NOT NULL AND $3 <> channel_id THEN NULL ELSE message_id END,
              updated_at    = now()
        WHERE id = $1 AND guild_id = $2
        RETURNING *`,
      [id, guildId, body.channelId ?? null,
        body.configuration === undefined ? null : JSON.stringify(body.configuration),
        body.enabled ?? null])
    if (!row) return await reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    await audit((request.user as { sub: string }).sub, 'discord.persistent_message.update',
      'config', `discord:${guildId}:${row.message_type}`, null, body as Record<string, unknown>)
    return publicView(row)
  })

  fastify.delete('/guilds/:guildId/persistent-messages/:id', {
    onRequest: fastify.authenticate,
    schema: { params: MESSAGE_PARAMS }
  }, async (request, reply) => {
    const guildId = await gate(request, reply, 'manage_messages')
    if (!guildId) return
    const { id } = request.params as { id: string }
    const row = await queryOne<PersistentMessage>(
      'DELETE FROM persistent_messages WHERE id = $1 AND guild_id = $2 RETURNING *', [id, guildId])
    if (!row) return await reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    await audit((request.user as { sub: string }).sub, 'discord.persistent_message.delete',
      'config', `discord:${guildId}:${row.message_type}`, null, null)
    // A DISCORD-ÜZENET MARAD. Egy nyilvántartás törlése nem jogosít fel arra,
    // hogy a szerver csatornájából eltüntessünk egy üzenetet — azt az
    // üzemeltető törli, ha akarja.
    return await reply.code(204).send()
  })

  /** Kézi szinkronizálás — a felület „frissítés most" gombja. */
  fastify.post('/guilds/:guildId/persistent-messages/:id/resync', {
    onRequest: fastify.authenticate,
    schema: { params: MESSAGE_PARAMS }
  }, async (request, reply) => {
    const guildId = await gate(request, reply, 'manage_messages')
    if (!guildId) return
    if (!isConfigured()) {
      return await reply.code(503).send({
        type: 'about:blank', title: 'Service Unavailable', status: 503,
        detail: 'nincs beállítva Discord bot token'
      })
    }
    const { id } = request.params as { id: string }
    const row = await findById(id)
    if (!row || row.guild_id !== guildId) {
      return await reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    }

    const payload = await renderMessage(row.message_type, { guildId, configuration: row.configuration })
    const result = await syncMessage(row, { client: createRestClient(), payload, force: true })
    await audit((request.user as { sub: string }).sub, 'discord.persistent_message.resync',
      'config', `discord:${guildId}:${row.message_type}`, null, { outcome: result.outcome })
    return result
  })

  /**
   * ÚJRA KIKÜLDÉS — a régi üzenet helyett egy új, a csatorna alján.
   *
   * Ez nem ugyanaz, mint a „Frissítés most": az módosítja, ami kint van. Ez
   * eldobja, és újat küld. Lásd `recreateMessage`.
   */
  fastify.post('/guilds/:guildId/persistent-messages/:id/recreate', {
    onRequest: fastify.authenticate,
    schema: { params: MESSAGE_PARAMS }
  }, async (request, reply) => {
    const guildId = await gate(request, reply, 'manage_messages')
    if (!guildId) return
    if (!isConfigured()) {
      return await reply.code(503).send({
        type: 'about:blank', title: 'Service Unavailable', status: 503,
        detail: 'nincs beállítva Discord bot token'
      })
    }
    const { id } = request.params as { id: string }
    const row = await findById(id)
    if (!row || row.guild_id !== guildId) {
      return await reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    }

    const payload = await renderMessage(row.message_type, { guildId, configuration: row.configuration })
    const result = await recreateMessage(row, { client: createRestClient(), payload })
    await audit((request.user as { sub: string }).sub, 'discord.persistent_message.recreate',
      'config', `discord:${guildId}:${row.message_type}`, null,
      { outcome: result.outcome, removedOld: result.removedOld })
    return result
  })

  /**
   * ELŐNÉZET — és ez NEM küldés.
   *
   * A 11.2. pont külön kimondja: „A preview ne állítsa azt, hogy az üzenet
   * már elküldésre került." Ezért ez a végpont a Discordot MEG SEM SZÓLÍTJA,
   * csak visszaadja, mi menne ki.
   */
  fastify.get('/guilds/:guildId/persistent-messages/:id/preview', {
    onRequest: fastify.authenticate,
    schema: { params: MESSAGE_PARAMS }
  }, async (request, reply) => {
    const guildId = await gate(request, reply, 'view_stats')
    if (!guildId) return
    const { id } = request.params as { id: string }
    const row = await findById(id)
    if (!row || row.guild_id !== guildId) {
      return await reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    }
    return {
      sent: false,
      payload: await renderMessage(row.message_type, { guildId, configuration: row.configuration })
    }
  })

  /** A frissítések előzménye — „mikor ment, mikor nem, és miért". */
  fastify.get('/guilds/:guildId/persistent-messages/:id/history', {
    onRequest: fastify.authenticate,
    schema: {
      params: MESSAGE_PARAMS,
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } }
      }
    }
  }, async (request, reply) => {
    const guildId = await gate(request, reply, 'view_stats')
    if (!guildId) return
    const { id } = request.params as { id: string }
    const { limit } = request.query as { limit?: number }
    const row = await findById(id)
    if (!row || row.guild_id !== guildId) {
      return await reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    }
    return {
      data: await query(
        `SELECT event, detail, duration_ms, at
           FROM persistent_message_events
          WHERE message_id = $1 ORDER BY at DESC LIMIT $2`,
        [id, limit ?? 50])
    }
  })

  /** A bot csatorna-jogosultságainak diagnosztikája. */
  fastify.get('/guilds/:guildId/channels/:channelId/diagnose', {
    onRequest: fastify.authenticate,
    schema: {
      params: {
        type: 'object', required: ['guildId', 'channelId'], additionalProperties: false,
        properties: { guildId: SNOWFLAKE, channelId: SNOWFLAKE }
      }
    }
  }, async (request, reply) => {
    const guildId = await gate(request, reply, 'manage_messages')
    if (!guildId) return
    const { channelId } = request.params as { channelId: string }
    return await diagnoseChannel(channelId)
  })
}

export default routes
