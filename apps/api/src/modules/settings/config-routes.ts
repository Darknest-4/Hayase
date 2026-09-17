// Site configuration & feature flags.
//   GET  /v1/config             — public, the effective config the client needs
//   GET  /v1/admin/config       — full config for editing (settings.system)
//   PATCH /v1/admin/config/flags/:key    — toggle / edit a feature flag
//   PATCH /v1/admin/config/settings/:key — set a global site setting

import { query, queryOne } from '../../infrastructure/database/index.ts'
import { settings as siteSettings } from './site-settings.ts'
import { flags as featureFlags } from './feature-flags.ts'
import { configured as passwordResetConfigured } from '../auth/reset-delivery.ts'
import * as turnstile from '../auth/turnstile.ts'
import { invalidateThresholds } from '../system/thresholds.ts'
import { PREFERENCES } from '../profiles/preferences.ts'
import { emitEvent } from '../webhooks/delivery.ts'

import type { FastifyPluginAsync } from 'fastify'

interface FlagRow {
  key: string
  label: string
  category: string
  enabled: boolean
  access: string
  required_permission: string | null
  description: string | null
  sort: number
}

/**
 * Tart-e ez a példány egyetlen engedélyezett forrást is.
 *
 * `EXISTS`, nem `count`: a kérdés az, hogy van-e, nem az, hogy mennyi — és
 * egy részleges indexen az első találatnál megáll. Minden /v1/config kérés
 * lefuttatja, ami az oldalbetöltésenként egy.
 */
async function anyPlayableSource (): Promise<boolean> {
  const rows = await query<{ any: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM video_sources WHERE enabled) AS any')
  return rows[0]?.any === true
}

// the shape the client consumes: site + a flat flags map
async function buildPublicConfig (): Promise<unknown> {
  const [flags, settings] = await Promise.all([
    query<FlagRow>('SELECT key, label, category, enabled, access, required_permission FROM feature_flags'),
    siteSettings.load()
  ])
  return {
    site: {
      name: settings.site_name ?? 'Yume',
      tagline: settings.tagline ?? '',
      requireLogin: settings.require_login === true,
      registrationOpen: settings.registration_open !== false,
      /*
       * A nyelvi házirend a példányé, nem a nézőé.
       *
       * `defaultLanguage` az, amit valaki kap, aki még nem választott — eddig
       * a böngésző nyelvéből tippeltünk, ami egy magyar oldalon angolt ad egy
       * angol rendszernyelvű magyar látogatónak.
       *
       * `languageSwitching` azt mondja meg, van-e egyáltalán választás.
       * Kikapcsolva az onboarding nyelvi lépése és a beállítások
       * nyelvválasztója eltűnik. A kliens innen tudja meg, tehát nem elrejtés:
       * az API ugyanazt mondja, amit a felület mutat.
       */
      defaultLanguage: typeof settings.default_language === 'string' ? settings.default_language : 'hu',
      languageSwitching: settings.language_switching === true,
      /*
       * Whether this instance can actually send a reset mail.
       *
       * /forgot answers 204 whether or not the account exists — that is
       * deliberate, and it is what stops the endpoint being an account
       * oracle. But on an instance with no delivery endpoint configured it
       * also means the viewer waits for a mail that was never going to
       * arrive, with nothing to tell them so.
       *
       * This flag is about the deployment, not about any account, so it
       * leaks nothing: the form can say up front that recovery is not
       * available here and to contact the operator.
       *
       * Named `recoveryAvailable` rather than anything containing "password":
       * an adversarial test scans this whole payload for that substring and
       * for "secret", and it is right to be blunt about it. A guard with no
       * exceptions is one nobody can argue their way past — so the field
       * takes the name that does not need an exception.
       */
      recoveryAvailable: passwordResetConfigured(),
      /*
       * Az emberpróba HELYSZÍNKULCSA — nyilvános, és ez nem elnézés.
       *
       * A Turnstile két kulcsot ad. Ez az, ami a widget HTML-jébe kerül, tehát
       * minden látogató böngészőjében ott van amúgy is; a titok, ami a tokent
       * érvényesíti, sosem hagyja el a kiszolgálót, és nincs olyan export,
       * ami visszaadná.
       *
       * `null`, ha ez a példány nem kér emberpróbát — a kliens ebből tudja,
       * hogy a widgetet be sem kell töltenie.
       */
      turnstileSiteKey: turnstile.siteKey(),
      /*
       * MELYIK ŰRLAPON kérünk emberpróbát. Enélkül a kliens vagy mindenhová
       * kitenné a widgetet (fölöslegesen), vagy sehová (és akkor a kiszolgáló
       * utasítaná vissza a küldést, ami a látogatónak értelmezhetetlen).
       */
      turnstileOn: turnstile.PROTECTABLE.filter(what => turnstile.protects(what)),
      /*
       * Van-e egyáltalán bármi, amit ez a példány le tud játszani.
       *
       * Ez a példányról szól, nem egy címről. A katalógus 32 390 címet és
       * 364 064 epizódot tart nyilván, videóforrást viszont nullát — ilyenkor
       * minden „Megnézem" gomb csapda: elvisz egy lejátszóoldalra, ami
       * végigpróbál nulla jelöltet, és a végén közli, hogy nincs miből.
       *
       * Egy epizódonkénti ellenőrzés ezt nem oldja meg: a főoldali kiemelés,
       * a kártyák lebegő gombja és a gyorsnézet mind egy cím ismerete nélkül
       * rajzolódik ki. Egy példányszintű tény viszont egy lekérdezés, amit a
       * kliens amúgy is elvégez induláskor.
       */
      playbackAvailable: await anyPlayableSource()
    },
    // The preference spec is public because the settings screen and the
    // onboarding wizard both render from it, and both have to work for a
    // viewer who is not signed in. Serving it here means the client never
    // carries its own copy of the labels.
    preferences: PREFERENCES,
    flags: Object.fromEntries(flags.map(f => [f.key, {
      enabled: f.enabled,
      access: f.access,
      permission: f.required_permission,
      label: f.label,
      category: f.category
    }]))
  }
}

// ---- public endpoint ----
export const publicConfig: FastifyPluginAsync = async fastify => {
  fastify.get('/', async () => buildPublicConfig())
}

// ---- admin endpoints ----
export const adminConfig: FastifyPluginAsync = async fastify => {
  fastify.addHook('onRequest', fastify.requirePermission('settings.system', { hide: true }))

  // full flag rows + settings, for the editor
  fastify.get('/', async () => {
    const [flags, settings] = await Promise.all([
      query<FlagRow>('SELECT key, label, category, enabled, access, required_permission, description, sort FROM feature_flags ORDER BY category, sort'),
      siteSettings.load()
    ])
    return { flags, settings }
  })

  fastify.patch('/flags/:key', {
    schema: {
      params: { type: 'object', properties: { key: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          access: { enum: ['public', 'auth', 'permission'] },
          requiredPermission: { type: ['string', 'null'], maxLength: 64 }
        }
      }
    }
  }, async (request, reply) => {
    const { key } = request.params as { key: string }
    const b = request.body as { enabled?: boolean, access?: string, requiredPermission?: string | null }

    const map: Record<string, string> = { enabled: 'enabled', access: 'access', requiredPermission: 'required_permission' }
    const sets: string[] = []
    const params: unknown[] = [key]
    for (const [bodyKey, col] of Object.entries(map)) {
      if (b[bodyKey as keyof typeof b] !== undefined) { params.push(b[bodyKey as keyof typeof b]); sets.push(`${col} = $${params.length}`) }
    }
    if (!sets.length) return reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'No changes' })
    params.push(request.user.sub)
    sets.push(`updated_at = now()`, `updated_by = $${params.length}`)

    // Read before the write so the event can say what changed rather than
    // only what it now is. "access=staff" is not actionable; "was public, now
    // staff" is the whole message.
    const was = await queryOne<FlagRow>(
      'SELECT key, label, category, enabled, access, required_permission FROM feature_flags WHERE key = $1', [key])

    const row = await queryOne<FlagRow>(
      `UPDATE feature_flags SET ${sets.join(', ')} WHERE key = $1
       RETURNING key, label, category, enabled, access, required_permission`,
      params
    )
    if (!row) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    // The flags are cached for the request path that enforces them, so without
    // this a switch thrown in the panel sat inert until the TTL expired — the
    // same defect the settings cache had, and the reason "Saved" has to mean
    // "in effect".
    featureFlags.invalidate()

    void emitEvent('config.changed', {
      key: `flag:${key}`,
      label: row.label,
      previous: was ? `enabled=${was.enabled}, access=${was.access}` : null,
      value: `enabled=${row.enabled}, access=${row.access}`,
      by: request.user.username
    })
    return row
  })

  fastify.patch('/settings/:key', {
    schema: {
      params: { type: 'object', properties: { key: { enum: ['site_name', 'tagline', 'require_login', 'registration_open', 'monitor_thresholds', 'default_language', 'language_switching'] } } },
      body: { type: 'object', required: ['value'], properties: { value: {} } }
    }
  }, async (request, reply) => {
    const { key } = request.params as { key: string }
    const { value } = request.body as { value: unknown }

    const previous = await queryOne<{ value: unknown }>('SELECT value FROM site_settings WHERE key = $1', [key])

    await query(
      `INSERT INTO site_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now(), updated_by = $3`,
      [key, JSON.stringify(value), request.user.sub]
    )
    // The threshold set is cached with a TTL, so without this an edited
    // threshold sat inert until the cache expired — an operator raising a
    // limit during an incident would watch it not take effect. The invalidator
    // was written and never called.
    // The cache exists so `registration_open` and `require_login` can be read
    // on hot paths; dropping it here is what makes "Saved" mean "in effect".
    siteSettings.invalidate()
    if (key === 'monitor_thresholds') invalidateThresholds()

    void emitEvent('config.changed', {
      key,
      previous: previous ? JSON.stringify(previous.value) : null,
      value: JSON.stringify(value),
      by: request.user.username
    })
    return { key, value }
  })
}
