// /v1/admin/backups — a mentés kezelése a panelről.
//
// A nehézség nem a felület, hanem a hely. A mentőkonténerben van `pg_dump`,
// `pg_restore` és a kötet; az API-ban egyik sincs — és nem is kell legyen: egy
// webalkalmazásnak nem dolga adatbázist ejteni.
//
// Ezért ez a modul nem *csinál* semmit. Sort ír a `backup_requests` táblába, és
// a mentőkonténer ciklusa veszi fel. Nincs új port, nincs socket, nincs
// megosztott titok. A válasz ugyanezen a csatornán jön vissza: állapot és a
// futás naplójának a vége.
//
// Külön jogosultság (`backup.manage`), nem a `security.manage` alá bújtatva: a
// visszaállítás más döntés, mint egy vészkapcsoló átbillentése, és lehet
// valaki, akire az egyiket rábízod, a másikat nem.

import { query, queryOne, transaction } from '../../infrastructure/database/index.ts'
import { settings as siteSettings } from '../settings/site-settings.ts'

import type { FastifyPluginAsync } from 'fastify'

/** Egy mentés neve. Nem szabad szöveg: ez egy fájlnév egy shell-szkriptben. */
const FILENAME = { type: 'string', pattern: '^yume-[0-9TZ]+\\.dump$', maxLength: 80 } as const
const REASON = { type: 'string', minLength: 3, maxLength: 500 } as const

async function pending (): Promise<{ id: string, kind: string } | undefined> {
  return await queryOne<{ id: string, kind: string }>(
    "SELECT id::text, kind FROM backup_requests WHERE status IN ('pending', 'running') LIMIT 1")
}

const routes: FastifyPluginAsync = async fastify => {
  fastify.addHook('onRequest', fastify.requirePermission('backup.manage', { hide: true }))

  /** Mi van a lemezen, mi fut, és mi történt legutóbb. */
  fastify.get('/', async () => {
    const [backups, requests, loaded] = await Promise.all([
      query(`SELECT filename, bytes::text, taken_at, verified, verify_detail
               FROM backups ORDER BY taken_at DESC LIMIT 60`),
      query(`SELECT r.id::text, r.kind, r.filename, r.status, r.reason, r.created_at,
                    r.started_at, r.finished_at, r.log, u.username AS requested_by
               FROM backup_requests r
               LEFT JOIN users u ON u.id = r.requested_by
              ORDER BY r.id DESC LIMIT 10`),
      siteSettings.load()
    ])

    return {
      backups,
      requests,
      schedule: {
        // Hiánya bekapcsolt állapot: egy példány, amin senki nem járt a
        // panelen, ugyanúgy ment, mint eddig.
        enabled: loaded.backup_schedule_enabled !== false,
        hourUtc: Number(process.env.BACKUP_AT_HOUR ?? 3),
        keepDays: Number(process.env.BACKUP_KEEP_DAYS ?? 14)
      },
      // A panel ebből tudja, hogy a mentések elhagyják-e a gépet. Nem
      // állítható innen: egy parancs, ami idegen gépre másol, a telepítésé.
      offsite: Boolean(process.env.BACKUP_SYNC_CMD),
      // Csak olvasható mód — a visszaállítás előfeltétele.
      readOnly: loaded.read_only === true,
      busy: await pending() ?? null
    }
  })

  /** Az éjszakai mentés ki- és bekapcsolása. */
  fastify.patch('/schedule', {
    schema: {
      body: {
        type: 'object',
        required: ['enabled', 'reason'],
        additionalProperties: false,
        properties: { enabled: { type: 'boolean' }, reason: REASON }
      }
    }
  }, async request => {
    const { enabled, reason } = request.body as { enabled: boolean, reason: string }
    const before = (await siteSettings.load()).backup_schedule_enabled !== false

    await transaction(async client => {
      await client.query(
        `INSERT INTO site_settings (key, value, updated_by) VALUES ('backup_schedule_enabled', $1::jsonb, $2)
         ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now(), updated_by = $2`,
        [JSON.stringify(enabled), request.user.sub]
      )
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after)
         VALUES ($1, 'config.setting', 'config', 'backup_schedule_enabled', $2, $3)`,
        [request.user.sub, { enabled: before }, { enabled, reason }]
      )
    })
    siteSettings.invalidate()
    return { enabled }
  })

  /**
   * Egy kérés a mentőkonténernek.
   *
   * Egyszerre egy: a táblán részleges egyedi index van, tehát két egyidejű
   * kérés közül a második elhasal, nem mindkettő elindul. Itt előbb
   * megkérdezzük, hogy a válasz érthető legyen — de a garancia az index.
   */
  const request_ = async (
    kind: 'backup' | 'verify' | 'restore',
    filename: string | null,
    reason: string,
    userId: string
  ): Promise<{ id: string }> => {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO backup_requests (kind, filename, reason, requested_by)
       VALUES ($1, $2, $3, $4) RETURNING id::text`,
      [kind, filename, reason, userId]
    )
    await query(
      `INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after)
       VALUES ($1, 'backup.request', 'config', $2, '{}'::jsonb, $3)`,
      [userId, `backup:${kind}`, { kind, filename, reason }]
    )
    return row!
  }

  /** Készíts egy mentést most. */
  fastify.post('/', {
    schema: {
      body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: REASON } }
    }
  }, async (request, reply) => {
    const busy = await pending()
    if (busy) return await reply.code(409).send({
      type: 'about:blank', title: 'Conflict', status: 409,
      detail: `Egy ${busy.kind} kérés már fut vagy sorban áll.`
    })
    const { reason } = request.body as { reason: string }
    return await request_('backup', null, reason, request.user.sub)
  })

  /**
   * Jó-e ez a mentés?
   *
   * Visszaállítás egy eldobható adatbázisba, aztán a tartalom megszámolása.
   * Ez a biztonságos válasz a kérdésre: megmondja, anélkül hogy bármit
   * kockáztatna.
   */
  fastify.post('/verify', {
    schema: {
      body: {
        type: 'object', required: ['filename', 'reason'], additionalProperties: false,
        properties: { filename: FILENAME, reason: REASON }
      }
    }
  }, async (request, reply) => {
    const { filename, reason } = request.body as { filename: string, reason: string }
    const exists = await queryOne('SELECT 1 FROM backups WHERE filename = $1', [filename])
    if (!exists) return await reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const busy = await pending()
    if (busy) return await reply.code(409).send({
      type: 'about:blank', title: 'Conflict', status: 409, detail: `Egy ${busy.kind} kérés már fut.`
    })
    return await request_('verify', filename, reason, request.user.sub)
  })

  /**
   * Az éles adatbázis felülírása.
   *
   * Két feltétel, és egyik sem formalitás:
   *
   *   * a példánynak csak olvasható módban kell lennie. Egy visszaállítás
   *     közben érkező írás vagy elvész, vagy egy félig visszaállított
   *     adatbázisba megy — és a kettő közül nem lehet utólag megmondani,
   *     melyik történt;
   *   * a fájlnevet be kell gépelni. Egy legördülőből kiválasztott
   *     visszaállítás az a visszaállítás, ami véletlenül történik.
   */
  fastify.post('/restore', {
    schema: {
      body: {
        type: 'object', required: ['filename', 'confirm', 'reason'], additionalProperties: false,
        properties: { filename: FILENAME, confirm: { type: 'string', maxLength: 80 }, reason: REASON }
      }
    }
  }, async (request, reply) => {
    const { filename, confirm, reason } = request.body as { filename: string, confirm: string, reason: string }

    if (confirm !== filename) {
      return await reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400,
        detail: 'A megerősítésnek pontosan a fájlnévnek kell lennie.'
      })
    }
    if (!await siteSettings.readOnly()) {
      return await reply.code(409).send({
        type: 'about:blank', title: 'Conflict', status: 409,
        detail: 'Előbb kapcsold be a csak olvasható módot a Biztonság alatt: visszaállítás közben érkező írás elvész.'
      })
    }
    const exists = await queryOne('SELECT 1 FROM backups WHERE filename = $1', [filename])
    if (!exists) return await reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const busy = await pending()
    if (busy) return await reply.code(409).send({
      type: 'about:blank', title: 'Conflict', status: 409, detail: `Egy ${busy.kind} kérés már fut.`
    })
    return await request_('restore', filename, reason, request.user.sub)
  })
}

export default routes
