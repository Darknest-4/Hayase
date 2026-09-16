// /v1/admin/edge — az él olvasása és kezelése.
//
// HÁROM JOGOSULTSÁG, mert három különböző döntés:
//
//   edge.view    mi támad, és mit csinált az él. Ezt egy moderátornak is meg
//                lehet mutatni.
//   edge.ban     tiltás kiadása és feloldása. Egy hálózat kitiltása sok
//                embert érint, akik közül a legtöbb nem csinált semmit.
//   edge.rules   a súlyok és küszöbök átírása. Ez a legveszélyesebb: egy
//                elrontott küszöb vagy mindenkit kitilt, vagy senkit.
//
// A `security.manage` MEGMARAD a vészkapcsolóknál. Nem vonjuk össze: az
// „kapcsold ki az egész oldalt" jogosultság, ez pedig „állítsd a szűrőt".

import { audit } from '../audit/audit.ts'
import { ban, lift, invalidate } from './bans.ts'
import { DEFAULTS, edgeConfig } from './config.ts'
import { query, queryOne, transaction } from '../../infrastructure/database/index.ts'
import { RULES } from './waf.ts'
import { settings as siteSettings } from '../settings/site-settings.ts'

import type { FastifyPluginAsync } from 'fastify'

const REASON = { type: 'string', minLength: 3, maxLength: 500 } as const

const RANGES: Record<string, number> = { '24h': 1, '7d': 7, '30d': 30 }

const routes: FastifyPluginAsync = async fastify => {
  // ---- áttekintés -------------------------------------------------------

  /**
   * Mi történt az élen.
   *
   * Az ÖSSZESÍTŐBŐL olvas, nem a nyers döntéstáblából: egy támadás alatt
   * percenként több ezer sor keletkezik, és a panel nem olvashatja végig
   * minden frissítésnél. A friss ablak (24 óra) az egyetlen, ami nyersen megy,
   * és ott az ablak tartja kicsin a halmazt.
   */
  fastify.get('/', {
    onRequest: fastify.requirePermission('edge.view'),
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { range: { enum: Object.keys(RANGES) } }
      }
    }
  }, async request => {
    const days = RANGES[(request.query as { range?: string }).range ?? '24h'] ?? 1
    const config = await edgeConfig()

    const [totals, byAction, topIps, topRules, recentDecisions, bans] = await Promise.all([
      queryOne(
        `SELECT count(*)::int AS decisions,
                count(*) FILTER (WHERE action = 'block')::int AS blocked,
                count(*) FILTER (WHERE action = 'throttle')::int AS throttled,
                count(*) FILTER (WHERE action = 'challenge')::int AS challenged,
                count(*) FILTER (WHERE action = 'monitor')::int AS monitored,
                count(DISTINCT ip)::int AS addresses
           FROM edge_decisions WHERE at > now() - ($1 || ' days')::interval`,
        [days]),
      query(
        `SELECT action, count(*)::int AS hits
           FROM edge_decisions WHERE at > now() - ($1 || ' days')::interval
          GROUP BY action ORDER BY hits DESC`,
        [days]),
      // „Top támadó IP-k". A cím mellé odatesszük, amit tudunk róla — egy
      // puszta cím nem elég ahhoz, hogy valaki tiltson.
      query(
        // `host(ip)` és nem `ip::text`: az utóbbi a maszkot is kiírja
        // (`127.0.0.1/32`), és egy operátor egy címet vár, nem egy hálózatot.
        `SELECT host(d.ip) AS ip, count(*)::int AS hits,
                count(*) FILTER (WHERE d.action = 'block')::int AS blocks,
                max(d.score)::int AS worst_score,
                max(d.at) AS last_seen,
                i.provider, i.country, i.is_hosting, i.is_vpn, i.is_tor, i.reputation
           FROM edge_decisions d
           LEFT JOIN ip_intel i ON i.ip = d.ip
          WHERE d.at > now() - ($1 || ' days')::interval AND d.ip IS NOT NULL
          GROUP BY d.ip, i.provider, i.country, i.is_hosting, i.is_vpn, i.is_tor, i.reputation
          ORDER BY hits DESC LIMIT 20`,
        [days]),
      query(
        `SELECT rule, count(*)::int AS hits
           FROM edge_decisions
          WHERE at > now() - ($1 || ' days')::interval AND rule IS NOT NULL
          GROUP BY rule ORDER BY hits DESC LIMIT 20`,
        [days]),
      query(
        `SELECT at, host(ip) AS ip, route, method, action, score, signals, rule
           FROM edge_decisions
          WHERE at > now() - ($1 || ' days')::interval
          ORDER BY at DESC LIMIT 50`,
        [days]),
      query(
        `SELECT id::text, kind, subject, reason, source, automatic, risk_score,
                created_at, expires_at
           FROM edge_bans
          WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now())
          ORDER BY created_at DESC LIMIT 50`)
    ])

    return {
      config: {
        enabled: config.enabled,
        dryRun: config.dryRun,
        thresholds: config.thresholds,
        weights: config.weights,
        failClosed: config.failClosed
      },
      totals,
      byAction,
      topIps,
      topRules,
      recent: recentDecisions,
      bans
    }
  })

  /** A WAF szabálylistája, a beállított állapotukkal. */
  fastify.get('/rules', {
    onRequest: fastify.requirePermission('edge.view')
  }, async () => {
    const stored = (await siteSettings.load()).edge as { disabledRules?: string[] } | undefined
    const disabled = new Set(stored?.disabledRules ?? [])
    return {
      rules: RULES.map(rule => ({
        id: rule.id,
        title: rule.title,
        severity: rule.severity,
        score: rule.score,
        where: rule.where,
        except: rule.except ?? [],
        enabled: rule.enabled && !disabled.has(rule.id)
      }))
    }
  })

  // ---- tiltások ---------------------------------------------------------

  /**
   * Tiltás kiadása.
   *
   * Indoklás kötelező. Egy tiltás, aminek nincs indoklása, hat hónap múlva
   * megmagyarázhatatlan: senki nem tudja, feloldható-e.
   */
  fastify.post('/bans', {
    onRequest: fastify.requirePermission('edge.ban', { hide: true }),
    schema: {
      body: {
        type: 'object',
        required: ['kind', 'subject', 'reason'],
        additionalProperties: false,
        properties: {
          kind: { enum: ['ip', 'network', 'user', 'session', 'api_key'] },
          subject: { type: 'string', minLength: 1, maxLength: 200 },
          reason: REASON,
          /** Másodperc. Hiánya véglegeset jelent, és ezt a felület kimondja. */
          seconds: { type: 'integer', minimum: 60, maximum: 365 * 86_400 }
        }
      }
    }
  }, async (request, reply) => {
    const body = request.body as { kind: 'ip' | 'network' | 'user' | 'session' | 'api_key', subject: string, reason: string, seconds?: number }

    /*
     * A hálózati tiltás külön gondolat.
     *
     * Egy /16 hatvanötezer címet fed le. A legtöbbjük mögött olyan ember van,
     * aki nem csinált semmit — egy mobilszolgáltató NAT-ja, egy egyetemi
     * hálózat. Ezért van felső határ a maszkon, és ezért mondja meg a hiba,
     * hogy mi a baj.
     */
    if (body.kind === 'network') {
      const prefix = Number(body.subject.split('/')[1])
      const isV6 = body.subject.includes(':')
      const floor = isV6 ? 48 : 20
      if (!Number.isFinite(prefix) || prefix < floor) {
        return await reply.code(400).send({
          type: 'about:blank', title: 'Bad Request', status: 400,
          detail: `Ekkora hálózatot nem tiltunk ki egy lépésben. A legtágabb elfogadott maszk /${floor} — ` +
            'egy ennél nagyobb tartomány mögött több tízezer ember van, akik közül a legtöbb nem csinált semmit.'
        })
      }
    }

    const created = await ban({
      kind: body.kind,
      subject: body.subject,
      reason: body.reason,
      source: 'manual',
      ...(body.seconds === undefined ? {} : { seconds: body.seconds }),
      automatic: false,
      createdBy: request.user.sub
    })

    if (!created) {
      return await reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400,
        detail: 'A tiltás nem jött létre. Ellenőrizd az alany alakját — IP-nél cím, hálózatnál CIDR.'
      })
    }

    await audit(request.user.sub, 'edge.ban', 'config', `${body.kind}:${body.subject}`, null, {
      reason: body.reason, seconds: body.seconds ?? null
    })
    return created
  })

  /** Feloldás. A sor marad: az előzmény attól előzmény, hogy nem tűnik el. */
  fastify.delete('/bans/:id', {
    onRequest: fastify.requirePermission('edge.ban', { hide: true }),
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: REASON } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { reason } = request.body as { reason: string }

    if (!await lift(id, request.user.sub, reason)) {
      return await reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    }
    await audit(request.user.sub, 'edge.unban', 'config', id, null, { reason })
    return { lifted: true }
  })

  // ---- szabályok --------------------------------------------------------

  /**
   * A súlyok, küszöbök és kapcsolók átírása.
   *
   * Indoklás kötelező, és a változás naplózódik. Ez az a felület, amivel egy
   * elgépelés mindenkit kitilthat — a napló az, amiből utólag kiderül, ki
   * mikor mit állított.
   */
  fastify.patch('/config', {
    onRequest: fastify.requirePermission('edge.rules', { hide: true }),
    schema: {
      body: {
        type: 'object',
        required: ['reason'],
        additionalProperties: false,
        properties: {
          reason: REASON,
          enabled: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          weights: {
            type: 'object',
            additionalProperties: { type: 'integer', minimum: 0, maximum: 100 }
          },
          thresholds: {
            type: 'object',
            additionalProperties: false,
            properties: {
              monitor: { type: 'integer', minimum: 1, maximum: 1000 },
              challenge: { type: 'integer', minimum: 1, maximum: 1000 },
              throttle: { type: 'integer', minimum: 1, maximum: 1000 },
              block: { type: 'integer', minimum: 1, maximum: 1000 }
            }
          },
          disabledRules: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 40 } }
        }
      }
    }
  }, async (request, reply) => {
    const body = request.body as Record<string, unknown>
    const { reason } = body as { reason: string }

    const before = await edgeConfig()
    const stored = ((await siteSettings.load()).edge ?? {}) as Record<string, unknown>

    const next: Record<string, unknown> = { ...stored }
    for (const key of ['enabled', 'dryRun', 'weights', 'thresholds', 'disabledRules']) {
      if (body[key] !== undefined) next[key] = body[key]
    }

    /*
     * A küszöbök sorrendje.
     *
     * Ha a blokkolás küszöbe a megfigyelésé alá csúszik, a rendszer azelőtt
     * tilt, hogy figyelne — és ezt egyetlen elgépelt szám is előidézi. Nem
     * javítjuk ki csendben: megmondjuk, mi a baj.
     */
    const t = { ...before.thresholds, ...(next.thresholds as Record<string, number> | undefined) }
    if (!(t.monitor <= t.challenge && t.challenge <= t.throttle && t.throttle <= t.block)) {
      return await reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400,
        detail: `A küszöböknek növekvő sorrendben kell állniuk: megfigyelés (${t.monitor}) ≤ ` +
          `ellenőrzés (${t.challenge}) ≤ lassítás (${t.throttle}) ≤ tiltás (${t.block}).`
      })
    }

    await transaction(async client => {
      await client.query(
        `INSERT INTO site_settings (key, value, updated_by) VALUES ('edge', $1::jsonb, $2)
         ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now(), updated_by = $2`,
        [JSON.stringify(next), request.user.sub]
      )
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after)
         VALUES ($1, 'edge.config', 'config', 'edge', $2::jsonb, $3::jsonb)`,
        [request.user.sub,
          JSON.stringify({ enabled: before.enabled, dryRun: before.dryRun, thresholds: before.thresholds }),
          JSON.stringify({ ...next, reason })]
      )
    })

    siteSettings.invalidate()
    invalidate()
    return await edgeConfig()
  })

  /** Amit a beállítás alapértéknek tekint — a panel ezt mutatja mellé. */
  fastify.get('/defaults', {
    onRequest: fastify.requirePermission('edge.view')
  }, async () => DEFAULTS)

  // ---- egy cím -----------------------------------------------------------

  /** Minden, amit egy címről tudunk. Ez az, amiből egy tiltás eldönthető. */
  fastify.get('/ip/:ip', {
    onRequest: fastify.requirePermission('edge.view'),
    schema: {
      params: { type: 'object', required: ['ip'], properties: { ip: { type: 'string', maxLength: 45 } } }
    }
  }, async (request, reply) => {
    const { ip } = request.params as { ip: string }

    // Paraméteres lekérdezés, `::inet` casttal: egy hibás cím 400-at kap, nem
    // egy 500-as adatbázishibát.
    let intel
    try {
      intel = await queryOne('SELECT * FROM ip_intel WHERE ip = $1::inet', [ip])
    } catch {
      return await reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400, detail: 'Ez nem érvényes IP-cím.'
      })
    }

    const [decisions, events, bans] = await Promise.all([
      query(
        `SELECT at, route, method, action, score, rule FROM edge_decisions
          WHERE ip = $1::inet ORDER BY at DESC LIMIT 50`, [ip]),
      query(
        `SELECT created_at, event, severity, route FROM security_logs
          WHERE ip = $1::inet ORDER BY created_at DESC LIMIT 50`, [ip]),
      query(
        `SELECT id::text, kind, subject, reason, source, automatic, created_at, expires_at, lifted_at
           FROM edge_bans
          WHERE (kind = 'ip' AND subject = $1)
             OR (kind = 'network' AND subject_inet >>= $1::inet)
          ORDER BY created_at DESC LIMIT 20`, [ip])
    ])

    return { ip, intel, decisions, events, bans }
  })
}

export default routes
