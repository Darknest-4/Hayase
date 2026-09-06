// Site settings: the handful of key/value rows an administrator can change.
//
// Read on paths that run on every request — registration, the login gate — so
// they are cached rather than fetched each time. The cache is invalidated on
// write instead of merely expiring, so "Saved" in the admin panel means the
// next request already sees it. The TTL is the backstop for the case the
// invalidation cannot cover: a second app instance, which writes to the same
// database but holds its own cache.
//
// Why this file exists at all: `registration_open` and `require_login` were
// stored, echoed back to the client, and enforced *nowhere*. An administrator
// closing registration got a "Saved" toast and an instance that kept accepting
// registrations. A setting that does not change behaviour is worse than a
// missing one — it is a control that lies about what it did.
//
// The readers are grouped on one exported object rather than being loose
// named exports. Every caller reaches them through it at call time, which is
// what lets a test replace one for the length of a test without writing to
// `site_settings` — a shared table, in a suite whose files run in parallel
// against one database, where flipping `require_login` for a second would
// hand unrelated suites a 401.

import { query } from '../db.ts'

const TTL_MS = 30_000

let cache: Record<string, unknown> | null = null
let readAt = 0

export const settings = {
  /** Drop the cache. Called by the write path so a change lands immediately. */
  invalidate (): void {
    cache = null
    readAt = 0
  },

  async load (): Promise<Record<string, unknown>> {
    if (cache && Date.now() - readAt < TTL_MS) return cache
    const rows = await query<{ key: string, value: unknown }>('SELECT key, value FROM site_settings')
    cache = Object.fromEntries(rows.map(row => [row.key, row.value]))
    readAt = Date.now()
    return cache
  },

  /**
   * May anybody still create an account here?
   *
   * Absent means yes. An instance that has never been configured should behave
   * like a normal public one, and only an explicit `false` closes the door —
   * otherwise a missing row would lock a fresh deployment out of its own first
   * account.
   */
  async registrationOpen (): Promise<boolean> {
    return (await settings.load()).registration_open !== false
  },

  /**
   * Is this a private instance?
   *
   * The inverse default, and for the same reason read the other way: absent
   * means public. Turning a site private is a deliberate act, and a missing
   * row must not do it by accident.
   */
  async requiresLogin (): Promise<boolean> {
    return (await settings.load()).require_login === true
  },

  /** The site's name, for anywhere the server renders it. */
  async siteName (): Promise<string> {
    const value = (await settings.load()).site_name
    return typeof value === 'string' && value.trim() ? value.trim() : 'Yume'
  }
}
