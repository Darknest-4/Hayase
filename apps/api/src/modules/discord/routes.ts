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
import { createRestClient, diagnoseChannel, isConfigured } from './rest-client.ts'
import { findById, listForGuild, syncMessage, type PersistentMessage } from './persistent-messages.ts'
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
