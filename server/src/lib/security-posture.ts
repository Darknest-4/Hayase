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

import { config } from '../config.ts'
import { query, queryOne } from '../db.ts'
import { settings } from './site-settings.ts'

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
    group: 'Secrets & transport',
    title: 'Signing secret is not the development placeholder',
    looksAt: 'JWT_SECRET',
    weight: 'critical',
    run: async () => {
      const secret = config.jwtSecret
      if (secret === DEV_JWT_SECRET) {
        return {
          verdict: 'fail',
          found: 'the signing secret is the shipped development placeholder — anybody can mint a token for any account',
          remedy: 'Generate one: openssl rand -base64 48, then restart'
        }
      }
      if (secret.length < 32) {
        return {
          verdict: 'warn',
          found: `the signing secret is ${secret.length} characters`,
          remedy: 'Use at least 32; openssl rand -base64 48 gives 64'
        }
      }
      // Never the value, never a prefix of it. The length is the finding.
      return { verdict: 'pass', found: `a ${secret.length}-character secret, not the placeholder` }
    }
  },
  {
    id: 'hsts',
    group: 'Secrets & transport',
    title: 'HSTS is sent',
    looksAt: 'ENABLE_HSTS, NODE_ENV',
    weight: 'high',
    run: async () => {
      if (!config.isProd) {
        return { verdict: 'skipped', found: 'not a production instance — HSTS over plain http would lock the browser out of it' }
      }
      if (process.env.ENABLE_HSTS === 'true') return { verdict: 'pass', found: 'ENABLE_HSTS=true' }
      return {
        verdict: 'warn',
        found: 'ENABLE_HSTS is not set',
        remedy: 'Set it once HTTPS terminates in front of the app, so a downgrade cannot be forced'
      }
    }
  },
  {
    id: 'cors',
    group: 'Secrets & transport',
    title: 'CORS is not open to every origin',
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
          return { verdict: 'skipped', found: 'development instance: every origin is allowed here and refused in production' }
        }
        return {
          verdict: 'fail',
          found: 'every origin is allowed — any site can make credentialed calls on a visitor’s behalf',
          remedy: 'Set CORS_ORIGINS to the origins that need it, or leave it unset for same-origin only'
        }
      }
      if (Array.isArray(origins) && origins.length) {
        return { verdict: 'pass', found: `${origins.length} allowed origin${origins.length === 1 ? '' : 's'}` }
      }
      return { verdict: 'pass', found: 'same-origin only' }
    }
  },

  // ---- who holds power ----
  {
    id: 'administrators',
    group: 'Accounts',
    title: 'Exactly the administrators you expect',
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
          found: 'no account holds the admin role — nobody can administer this instance',
          remedy: 'The first account to register is promoted; see routes/auth.ts'
        }
      }
      if (n > 5) {
        return {
          verdict: 'warn',
          found: `${n} accounts hold the admin role`,
          remedy: 'Every one of them can hand the instance to somebody else. Review them in Users.'
        }
      }
      return { verdict: 'pass', found: `${n} administrator${n === 1 ? '' : 's'}` }
    }
  },
  {
    id: 'privileged-without-password',
    group: 'Accounts',
    title: 'No privileged account without a password',
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
      if (!rows.length) return { verdict: 'pass', found: 'every privileged account has a password set' }
      return {
        verdict: 'warn',
        found: `${rows.length} privileged account${rows.length === 1 ? '' : 's'} cannot be signed in to (${rows.map(r => r.username).slice(0, 3).join(', ')})`,
        remedy: 'Usually a fixture or an external-sign-in account. Remove the role if it is neither.'
      }
    }
  },
  {
    id: 'privileged-sprawl',
    group: 'Accounts',
    title: 'The emergency controls are held by few',
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
          found: `${n} accounts can freeze the instance or hand out roles`,
          remedy: 'These two permissions are how an instance changes hands. Keep the set small.'
        }
      }
      return { verdict: 'pass', found: `${n} account${n === 1 ? '' : 's'} can freeze the instance or hand out roles` }
    }
  },

  // ---- outbound ----
  {
    id: 'webhook-signing',
    group: 'Outbound',
    title: 'Every webhook delivery is signed',
    looksAt: 'webhooks.secret',
    weight: 'high',
    run: async () => {
      const rows = await query<{ name: string }>(
        "SELECT name FROM webhooks WHERE enabled AND format <> 'discord' AND (secret IS NULL OR secret = '')")
      if (!rows.length) return { verdict: 'pass', found: 'every enabled generic webhook has a signing secret' }
      return {
        verdict: 'warn',
        found: `${rows.length} enabled webhook${rows.length === 1 ? '' : 's'} send unsigned (${rows.map(r => r.name).slice(0, 3).join(', ')})`,
        remedy: 'Without a secret the receiver cannot tell our delivery from anybody else’s POST'
      }
    }
  },
  {
    id: 'webhook-transport',
    group: 'Outbound',
    title: 'No webhook posts over plain http',
    looksAt: 'webhooks.url',
    weight: 'high',
    run: async () => {
      const rows = await query<{ name: string }>(
        "SELECT name FROM webhooks WHERE enabled AND url LIKE 'http://%'")
      if (!rows.length) return { verdict: 'pass', found: 'every enabled webhook posts over https' }
      return {
        verdict: 'fail',
        found: `${rows.length} enabled webhook${rows.length === 1 ? '' : 's'} post over plain http (${rows.map(r => r.name).slice(0, 3).join(', ')})`,
        remedy: 'The payload and its signature travel in the clear. Use https or disable the hook.'
      }
    }
  },

  // ---- the instance ----
  {
    id: 'private-instance',
    group: 'Exposure',
    title: 'Registration and access match intent',
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
          found: 'the instance is private but registration is open — anybody can still create an account and get in',
          remedy: 'Close registration too, or make the site public'
        }
      }
      return {
        verdict: 'pass',
        found: `${requiresLogin ? 'private' : 'public'}, registration ${registrationOpen ? 'open' : 'closed'}`
      }
    }
  },
  {
    id: 'emergency-controls',
    group: 'Exposure',
    title: 'No emergency control left engaged',
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
      if (!engaged.length) return { verdict: 'pass', found: 'nothing is being held back' }
      return {
        verdict: 'warn',
        found: `${engaged.join(', ')} — engaged deliberately, or left on after an incident?`,
        remedy: 'Release them in Security when the reason has passed'
      }
    }
  },

  // ---- signals ----
  {
    id: 'failed-logins',
    group: 'Signals',
    title: 'Failed sign-ins are at a normal rate',
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
          found: `${n} failed sign-ins from ${ips} address${ips === 1 ? '' : 'es'} in the last hour`,
          remedy: 'Rate limiting is already refusing them; read-only mode is available if it becomes worse'
        }
      }
      return { verdict: 'pass', found: `${n} in the last hour` }
    }
  },
  {
    id: 'open-errors',
    group: 'Signals',
    title: 'No unreviewed failure groups piling up',
    looksAt: 'error_groups where status = open',
    weight: 'normal',
    run: async () => {
      const row = await queryOne<{ n: number }>(
        "SELECT count(*)::int AS n FROM error_groups WHERE status = 'open'")
      const n = Number(row?.n ?? 0)
      if (n > 20) {
        return { verdict: 'warn', found: `${n} open groups`, remedy: 'Triage them in Errors — a long list stops being read' }
      }
      return { verdict: 'pass', found: `${n} open group${n === 1 ? '' : 's'}` }
    }
  },
  {
    id: 'dead-jobs',
    group: 'Signals',
    title: 'Background work is not silently dying',
    looksAt: 'jobs where attempts >= max_attempts',
    weight: 'normal',
    run: async () => {
      const row = await queryOne<{ n: number }>(
        'SELECT count(*)::int AS n FROM jobs WHERE attempts >= max_attempts AND done_at IS NULL')
      const n = Number(row?.n ?? 0)
      if (n > 10) {
        return { verdict: 'warn', found: `${n} jobs have exhausted their retries`, remedy: 'Check Infrastructure for which queue' }
      }
      return { verdict: 'pass', found: `${n} exhausted job${n === 1 ? '' : 's'}` }
    }
  },

  // ---- data ----
  {
    id: 'db-encoding',
    group: 'Data',
    title: 'The database can store the text it is given',
    looksAt: 'pg_database encoding and collation',
    weight: 'normal',
    run: async () => {
      const row = await queryOne<{ encoding: string, collate: string }>(
        `SELECT pg_encoding_to_char(encoding) AS encoding, datcollate AS collate
           FROM pg_database WHERE datname = current_database()`)
      if (row?.encoding === 'UTF8') return { verdict: 'pass', found: `${row.encoding}, collation ${row.collate}` }
      return {
        verdict: 'fail',
        found: `encoding is ${row?.encoding ?? 'unknown'} — accented text is stored and compared wrongly`,
        remedy: 'Recreate the database with ENCODING UTF8 and restore; see lib/db-encoding.ts'
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
        found: `the check could not run: ${(err as Error).message.slice(0, 200)}`,
        remedy: 'This is itself worth looking at — a posture nobody can measure is a posture nobody knows'
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
