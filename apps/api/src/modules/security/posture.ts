// The instance's security posture, computed rather than asserted.
//
// The brief this came from asked for a page showing "Security Score: 94/100".
// A number like that is worth exactly as much as the checks behind it, and a
// score with no checks behind it is the most confident lie a dashboard can
// tell — an operator reads 94 and stops looking.
//
// So every entry here inspects something real and reports what it found. The
// score is not a judgement, it is arithmetic: passing checks over applicable
// checks. A check that cannot apply to this deployment (HSTS on a
// non-production instance) is `skipped` and leaves the denominator alone
// rather than quietly costing points.
//
// Three rules each check follows:
//
//   * it names what it looked at, so a reader can go and look at the same
//     thing rather than trusting the verdict;
//   * it carries the value it found, not just a colour;
//   * it fails loudly rather than silently passing. A check that throws is
//     reported as `unknown`, because "we could not tell" and "it is fine" are
//     different answers and only one of them is honest.

import { config } from '../../config.ts'
import * as turnstile from '../auth/turnstile.ts'
import { query, queryOne } from '../../infrastructure/database/index.ts'
import { loadTestConfigured } from '../../middleware/load-test.ts'
import { settings } from '../settings/site-settings.ts'

export type Verdict = 'pass' | 'warn' | 'fail' | 'skipped' | 'unknown'

export interface Check {
  id: string
  group: string
  title: string
  /** What was inspected — a table, a setting, a config value. */
  looksAt: string
  verdict: Verdict
  /** The value actually found, in a sentence. */
  found: string
  /** What to do when this is not passing. Absent when it is. */
  remedy?: string
}

/** Weight by blast radius: a failing `critical` is not one point among many. */
const WEIGHT: Record<string, number> = { critical: 3, high: 2, normal: 1 }

interface Definition {
  id: string
  group: string
  title: string
  looksAt: string
  weight: keyof typeof WEIGHT
  run: () => Promise<Omit<Check, 'id' | 'group' | 'title' | 'looksAt'>>
}

const DEV_JWT_SECRET = 'dev-only-jwt-secret'

const DEFINITIONS: Definition[] = [
  // ---- secrets and transport ----
  {
    id: 'jwt-secret',
    group: 'Titkok és átvitel',
    title: 'Az aláíró titok nem a fejlesztői helykitöltő',
    looksAt: 'JWT_SECRET',
    weight: 'critical',
    run: async () => {
      const secret = config.jwtSecret
      if (secret === DEV_JWT_SECRET) {
        return {
          verdict: 'fail',
          found: 'az aláíró titok a szállított fejlesztői helykitöltő — bárki tud tokent gyártani bármelyik fiókhoz',
          remedy: 'Generálj egyet: openssl rand -base64 48, aztán indítsd újra'
        }
      }
      if (secret.length < 32) {
        return {
          verdict: 'warn',
          found: `az aláíró titok ${secret.length} karakter`,
          remedy: 'Legalább 32 karakter kell; az openssl rand -base64 48 hatvannégyet ad'
        }
      }
      // Never the value, never a prefix of it. The length is the finding.
      return { verdict: 'pass', found: `${secret.length} karakteres titok, nem a helykitöltő` }
    }
  },
  {
    id: 'hsts',
    group: 'Titkok és átvitel',
    title: 'HSTS-fejléc megy ki',
    looksAt: 'ENABLE_HSTS, NODE_ENV',
    weight: 'high',
    run: async () => {
      if (!config.isProd) {
        return { verdict: 'skipped', found: 'nem éles példány — sima http-n a HSTS kizárná belőle a böngészőt' }
      }
      if (process.env.ENABLE_HSTS === 'true') return { verdict: 'pass', found: 'ENABLE_HSTS=true' }
      return {
        verdict: 'warn',
        found: 'az ENABLE_HSTS nincs beállítva',
        remedy: 'Kapcsold be, amint HTTPS végződik az alkalmazás előtt — így nem lehet visszaléptetni http-re'
      }
    }
  },
  {
    id: 'cors',
    group: 'Titkok és átvitel',
    title: 'A CORS nem enged minden forrást',
    looksAt: 'CORS_ORIGINS',
    weight: 'high',
    run: async () => {
      const origins = config.corsOrigins
      if (origins === true) {
        // config.ts already refuses a wildcard in production — an unset or `*`
        // CORS_ORIGINS resolves to same-origin there — so `true` can only be a
        // development instance. Reporting that as a failure would be a false
        // alarm, and a security page that cries wolf is worse than none.
        if (!config.isProd) {
          return { verdict: 'skipped', found: 'fejlesztői példány: itt minden forrás engedett, élesben el lesz utasítva' }
        }
        return {
          verdict: 'fail',
          found: 'minden forrás engedett — bármelyik oldal hívhat a látogató nevében, a sütijeivel',
          remedy: 'Állítsd a CORS_ORIGINS-t azokra a forrásokra, amiknek kell, vagy hagyd üresen az azonos forráshoz'
        }
      }
      if (Array.isArray(origins) && origins.length) {
        return { verdict: 'pass', found: `${origins.length} engedett forrás` }
      }
      return { verdict: 'pass', found: 'csak azonos forrás' }
    }
  },

  // ---- who holds power ----
  {
    id: 'public-url',
    group: 'Titkok és átvitel',
    title: 'A nyilvános cím be van állítva, nem a kérésből jön',
    looksAt: 'PUBLIC_URL',
    weight: 'normal',
    run: async () => {
      // Without it, robots.txt, the sitemap and every canonical link are built
      // from the Host header — which the *client* chooses. A crawler following
      // a link with a forged Host is then told the canonical home of these
      // pages is somebody else's domain, and hands them the ranking.
      //
      // Only checked in production: in development the host is whatever the
      // developer typed, and flagging that would be noise.
      if (!config.isProd) {
        return { verdict: 'skipped', found: 'fejlesztői példány: ezt semmi nem indexeli' }
      }
      const value = process.env.PUBLIC_URL?.trim()
      if (!value) {
        return {
          verdict: 'warn',
          found: 'nincs beállítva — a kanonikus és sitemap-címek a hívó Host fejlécéből épülnek',
          remedy: 'Állítsd a PUBLIC_URL-t az oldal címére, például https://yume.example.com'
        }
      }
      if (!/^https:\/\//i.test(value)) {
        return {
          verdict: 'warn',
          found: `sima http-címre van állítva (${value})`,
          remedy: 'A https címet használd, különben a keresők a nem biztonságosat indexelik'
        }
      }
      return { verdict: 'pass', found: `erre van állítva: ${value}` }
    }
  },
  {
    id: 'administrators',
    group: 'Fiókok',
    title: 'Pontosan azok az adminisztrátorok, akikre számítasz',
    looksAt: 'user_roles joined to roles',
    weight: 'high',
    run: async () => {
      const row = await queryOne<{ n: number }>(
        `SELECT count(*)::int AS n FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
          WHERE r.slug = 'admin'`)
      const n = Number(row?.n ?? 0)
      if (n === 0) {
        return {
          verdict: 'fail',
          found: 'egyetlen fióknak sincs admin szerepköre — senki nem tudja üzemeltetni ezt a példányt',
          remedy: 'Az elsőként regisztrált fiók kapja meg; lásd routes/auth.ts'
        }
      }
      if (n > 5) {
        return {
          verdict: 'warn',
          found: `${n} fióknak van admin szerepköre`,
          remedy: 'Bármelyikük átadhatja a példányt másnak. Nézd át őket a Felhasználók között.'
        }
      }
      return { verdict: 'pass', found: `${n} adminisztrátor` }
    }
  },
  {
    id: 'privileged-without-password',
    group: 'Fiókok',
    title: 'Nincs jelszó nélküli kiemelt fiók',
    looksAt: 'users.password_hash for holders of admin or security.manage',
    weight: 'high',
    run: async () => {
      const rows = await query<{ username: string }>(
        `SELECT DISTINCT u.username
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN roles r ON r.id = ur.role_id
          WHERE u.password_hash IS NULL
            AND u.deleted_at IS NULL
            AND r.slug IN ('admin', 'moderator')`)
      if (!rows.length) return { verdict: 'pass', found: 'minden kiemelt fióknak van jelszava' }
      return {
        verdict: 'warn',
        found: `${rows.length} kiemelt fiókba nem lehet belépni (${rows.map(r => r.username).slice(0, 3).join(', ')})`,
        remedy: 'Általában teszt- vagy külső belépéses fiók. Ha egyik sem, vedd el tőle a szerepkört.'
      }
    }
  },
  {
    id: 'privileged-sprawl',
    group: 'Fiókok',
    title: 'A vészkapcsolók kevesek kezében vannak',
    looksAt: 'holders of security.manage and role.assign',
    weight: 'normal',
    run: async () => {
      const row = await queryOne<{ n: number }>(
        `SELECT count(DISTINCT ur.user_id)::int AS n
           FROM user_roles ur
           JOIN role_permissions rp ON rp.role_id = ur.role_id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE p.slug IN ('security.manage', 'role.assign')`)
      const n = Number(row?.n ?? 0)
      if (n > 5) {
        return {
          verdict: 'warn',
          found: `${n} fiók be tudja fagyasztani a példányt vagy szerepkört osztani`,
          remedy: 'Ez a két jogosultság az, amivel egy példány gazdát cserél. Tartsd szűken a kört.'
        }
      }
      return { verdict: 'pass', found: `${n} fiók tudja befagyasztani a példányt vagy szerepkört osztani` }
    }
  },

  // ---- outbound ----
  {
    id: 'webhook-signing',
    group: 'Kimenő',
    title: 'Minden webhook-kézbesítés alá van írva',
    looksAt: 'webhooks.secret',
    weight: 'high',
    run: async () => {
      const rows = await query<{ name: string }>(
        "SELECT name FROM webhooks WHERE enabled AND format <> 'discord' AND (secret IS NULL OR secret = '')")
      if (!rows.length) return { verdict: 'pass', found: 'minden bekapcsolt általános webhookhoz tartozik aláíró titok' }
      return {
        verdict: 'warn',
        found: `${rows.length} bekapcsolt webhook aláírás nélkül küld (${rows.map(r => r.name).slice(0, 3).join(', ')})`,
        remedy: 'Titok nélkül a fogadó nem tudja megkülönböztetni a mi kézbesítésünket bárki más POST-jától'
      }
    }
  },
  {
    id: 'webhook-transport',
    group: 'Kimenő',
    title: 'Egy webhook sem küld sima http-n',
    looksAt: 'webhooks.url',
    weight: 'high',
    run: async () => {
      const rows = await query<{ name: string }>(
        "SELECT name FROM webhooks WHERE enabled AND url LIKE 'http://%'")
      if (!rows.length) return { verdict: 'pass', found: 'minden bekapcsolt webhook https-en küld' }
      return {
        verdict: 'fail',
        found: `${rows.length} bekapcsolt webhook sima http-n küld (${rows.map(r => r.name).slice(0, 3).join(', ')})`,
        remedy: 'A csomag és az aláírása titkosítatlanul utazik. Válts https-re, vagy kapcsold ki a webhookot.'
      }
    }
  },

  // ---- the instance ----
  {
    id: 'private-instance',
    group: 'Kitettség',
    title: 'A regisztráció és a hozzáférés a szándékot követi',
    looksAt: 'site_settings.require_login and registration_open',
    weight: 'normal',
    run: async () => {
      const [requiresLogin, registrationOpen] = await Promise.all([
        settings.requiresLogin(),
        settings.registrationOpen()
      ])
      // Not a judgement about which is right — both are legitimate — but a
      // private instance that still accepts new accounts is usually somebody
      // having set one switch and forgotten the other.
      if (requiresLogin && registrationOpen) {
        return {
          verdict: 'warn',
          found: 'a példány privát, de a regisztráció nyitva — bárki csinálhat fiókot, és bejuthat',
          remedy: 'Zárd be a regisztrációt is, vagy tedd nyilvánossá az oldalt'
        }
      }
      return {
        verdict: 'pass',
        found: `${requiresLogin ? 'privát' : 'nyilvános'}, a regisztráció ${registrationOpen ? 'nyitva' : 'zárva'}`
      }
    }
  },
  {
    id: 'turnstile',
    group: 'Kitettség',
    title: 'A hitelesítési űrlapokon van emberpróba',
    looksAt: 'TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY',
    weight: 'normal',
    run: async () => {
      /*
       * FIGYELMEZTETÉS, NEM BUKÁS. Egy emberpróba nélküli példány nem hibás:
       * egy zárt regisztrációjú, néhány fős telepítésen nincs is mit védeni,
       * és a sebességkorlát meg a drága jelszóhasítás akkor is áll.
       *
       * Az ellenőrzés attól hasznos, hogy megmondja, MI AZ ÁLLAPOT — és hogy
       * a félig beállított eset (egy kulcs megvan, a másik nem) ne maradjon
       * észrevétlen. Az pont úgy néz ki, mint a működő, csak nem véd semmit.
       */
      const site = Boolean(process.env.TURNSTILE_SITE_KEY?.trim())
      const secret = Boolean(process.env.TURNSTILE_SECRET_KEY?.trim())

      if (site !== secret) {
        return {
          verdict: 'fail',
          found: `csak a ${site ? 'helyszín kulcsa' : 'titok'} van beállítva — az emberpróba így NEM fut le`,
          remedy: 'Add meg mindkettőt a Turnstile felületéről, vagy vedd ki a meglévőt is'
        }
      }
      if (!site) {
        return {
          verdict: 'warn',
          found: 'nincs emberpróba — a regisztrációt és a belépést csak a sebességkorlát védi',
          remedy: 'Cloudflare → Turnstile → Add site, majd TURNSTILE_SITE_KEY és TURNSTILE_SECRET_KEY'
        }
      }

      const protects = turnstile.PROTECTABLE.filter(what => turnstile.protects(what))
      const hosts = turnstile.allowedHostnames()
      if (hosts.length === 0) {
        return {
          verdict: 'warn',
          found: 'az emberpróba fut, de gazdanév-ellenőrzés nélkül — egy máshol szerzett token is elmenne',
          remedy: 'Állítsd be a PUBLIC_URL-t, vagy sorold fel a neveket a TURNSTILE_HOSTNAMES-ben'
        }
      }
      return { verdict: 'pass', found: `${protects.join(', ')} — elfogadott gazdanevek: ${hosts.join(', ')}` }
    }
  },
  {
    id: 'load-test-exemption',
    group: 'Kitettség',
    title: 'Nincs bekapcsolva felejtett terhelésmérő kivétel',
    looksAt: 'LOAD_TEST_KEY, LOAD_TEST_IPS',
    weight: 'normal',
    run: async () => {
      if (!loadTestConfigured()) {
        return { verdict: 'pass', found: 'nincs beállítva — a sebességkorlát mindenkire érvényes' }
      }
      // Nem „fail": egy mérés közben ennek pontosan így kell kinéznie. De
      // látszania kell, mert utána nem kell, és semmi nem hibázik tőle.
      return {
        verdict: 'warn',
        found: `beállítva — ${config.loadTestIps.join(', ')} a kulccsal együtt mentesül a sebességkorlát alól`,
        remedy: 'Ha a mérés lezárult, vedd ki a LOAD_TEST_KEY-t a környezetből és indítsd újra az appot'
      }
    }
  },
  {
    id: 'emergency-controls',
    group: 'Kitettség',
    title: 'Nincs bekapcsolva felejtett vészkapcsoló',
    looksAt: 'site_settings.read_only, external_sync_enabled, webhooks_enabled',
    weight: 'normal',
    run: async () => {
      const [readOnly, sync, hooks] = await Promise.all([
        settings.readOnly(),
        settings.externalSyncEnabled(),
        settings.webhooksEnabled()
      ])
      const engaged = [
        readOnly ? 'read-only mode' : null,
        sync ? null : 'external sync off',
        hooks ? null : 'outbound webhooks off'
      ].filter(Boolean)
      if (!engaged.length) return { verdict: 'pass', found: 'semmi nincs visszatartva' }
      return {
        verdict: 'warn',
        found: `${engaged.join(', ')} — szándékosan van bekapcsolva, vagy egy incidens után maradt így?`,
        remedy: 'Oldd fel őket a Biztonság alatt, ha az ok elmúlt'
      }
    }
  },

  // ---- signals ----
  {
    id: 'failed-logins',
    group: 'Jelzések',
    title: 'A sikertelen belépések száma normális',
    looksAt: "security_logs where event = 'login_failed', last hour",
    weight: 'normal',
    run: async () => {
      const row = await queryOne<{ n: number, ips: number }>(
        `SELECT count(*)::int AS n, count(DISTINCT ip)::int AS ips
           FROM security_logs
          WHERE event = 'login_failed' AND created_at > now() - interval '1 hour'`)
      const n = Number(row?.n ?? 0)
      const ips = Number(row?.ips ?? 0)
      if (n > 100) {
        return {
          verdict: 'warn',
          found: `${n} sikertelen belépés ${ips} címről az elmúlt órában`,
          remedy: 'A sebességkorlát már elutasítja őket; ha romlik, ott a csak olvasható mód'
        }
      }
      return { verdict: 'pass', found: `${n} az elmúlt órában` }
    }
  },
  {
    id: 'open-errors',
    group: 'Jelzések',
    title: 'Nem gyűlnek átnézetlen hibacsoportok',
    looksAt: 'error_groups where status = open',
    weight: 'normal',
    run: async () => {
      const row = await queryOne<{ n: number }>(
        "SELECT count(*)::int AS n FROM error_groups WHERE status = 'open'")
      const n = Number(row?.n ?? 0)
      if (n > 20) {
        return { verdict: 'warn', found: `${n} nyitott csoport`, remedy: 'Nézd át őket a Hibák alatt — egy hosszú listát senki nem olvas' }
      }
      return { verdict: 'pass', found: `${n} nyitott csoport` }
    }
  },
  {
    id: 'dead-jobs',
    group: 'Jelzések',
    title: 'A háttérmunka nem hal el némán',
    looksAt: 'jobs where attempts >= max_attempts',
    weight: 'normal',
    run: async () => {
      const row = await queryOne<{ n: number }>(
        'SELECT count(*)::int AS n FROM jobs WHERE attempts >= max_attempts AND done_at IS NULL')
      const n = Number(row?.n ?? 0)
      if (n > 10) {
        return { verdict: 'warn', found: `${n} feladat elhasználta az újrapróbálkozásait`, remedy: 'Nézd meg az Infrastruktúránál, melyik sorról van szó' }
      }
      return { verdict: 'pass', found: `${n} kimerült feladat` }
    }
  },

  // ---- data ----
  {
    id: 'db-encoding',
    group: 'Adat',
    title: 'Az adatbázis el tudja tárolni a kapott szöveget',
    looksAt: 'pg_database encoding and collation',
    weight: 'normal',
    run: async () => {
      const row = await queryOne<{ encoding: string, collate: string }>(
        `SELECT pg_encoding_to_char(encoding) AS encoding, datcollate AS collate
           FROM pg_database WHERE datname = current_database()`)
      if (row?.encoding === 'UTF8') return { verdict: 'pass', found: `${row.encoding}, rendezés: ${row.collate}` }
      return {
        verdict: 'fail',
        found: `a kódolás ${row?.encoding ?? 'ismeretlen'} — az ékezetes szöveg rosszul tárolódik és hasonlítódik`,
        remedy: 'Hozd létre újra az adatbázist ENCODING UTF8-cal, és állítsd vissza; lásd lib/db-encoding.ts'
      }
    }
  }
]

export interface Posture {
  checks: Check[]
  summary: {
    pass: number
    warn: number
    fail: number
    skipped: number
    unknown: number
    /**
     * Passing weight over applicable weight, as a percentage.
     *
     * Arithmetic, not a judgement. A skipped check leaves the denominator
     * alone; an `unknown` counts against, because not being able to tell is
     * not the same as being fine.
     */
    score: number | null
  }
  generatedAt: string
}

export async function posture (): Promise<Posture> {
  const checks: Check[] = []
  let earned = 0
  let possible = 0

  for (const def of DEFINITIONS) {
    let result: Omit<Check, 'id' | 'group' | 'title' | 'looksAt'>
    try {
      result = await def.run()
    } catch (err) {
      // A check that throws is not a check that passed.
      result = {
        verdict: 'unknown',
        found: `az ellenőrzés nem tudott lefutni: ${(err as Error).message.slice(0, 200)}`,
        remedy: 'Ez önmagában is megnézendő — amit senki nem tud megmérni, azt senki nem is ismeri'
      }
    }
    checks.push({ id: def.id, group: def.group, title: def.title, looksAt: def.looksAt, ...result })

    if (result.verdict === 'skipped') continue
    const weight = WEIGHT[def.weight] ?? 1
    possible += weight
    if (result.verdict === 'pass') earned += weight
    else if (result.verdict === 'warn') earned += weight / 2
  }

  const count = (v: Verdict): number => checks.filter(c => c.verdict === v).length
  return {
    checks,
    summary: {
      pass: count('pass'),
      warn: count('warn'),
      fail: count('fail'),
      skipped: count('skipped'),
      unknown: count('unknown'),
      score: possible ? Math.round((earned / possible) * 100) : null
    },
    generatedAt: new Date().toISOString()
  }
}
