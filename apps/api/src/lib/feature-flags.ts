// Feature flags: the kill switches an administrator can throw.
//
// Why this file exists: `feature_flags` was read in exactly one place —
// routes/config.ts, which projects the table to the client — and enforced
// nowhere else. The client gates its routes on the projection, so turning a
// feature off removed its page and left its API wide open. Comments could
// still be posted, watch-together rooms could still be created; only the
// buttons went away.
//
// That is the same defect `require_login` and `registration_open` had before
// lib/site-settings.ts, and it is fixed the same way, deliberately: one cached
// reader, invalidated on write rather than merely expiring, so "Saved" in the
// admin panel means the next request already sees it. The TTL is the backstop
// for the case invalidation cannot cover — a second app instance with its own
// cache.
//
// A disabled feature answers 404, not 403. An instance that has turned
// comments off does not have comments, and saying "forbidden" would describe a
// permission problem the caller could do something about.

import { query } from '../db.ts'

const TTL_MS = 30_000

interface Flag {
  key: string
  enabled: boolean
  access: string
  required_permission: string | null
}

let cache: Map<string, Flag> | null = null
let readAt = 0

export const flags = {
  /** Drop the cache. Called by the write path so a change lands immediately. */
  invalidate (): void {
    cache = null
    readAt = 0
  },

  async load (): Promise<Map<string, Flag>> {
    if (cache && Date.now() - readAt < TTL_MS) return cache
    const rows = await query<Flag>(
      'SELECT key, enabled, access, required_permission FROM feature_flags')
    cache = new Map(rows.map(row => [row.key, row]))
    readAt = Date.now()
    return cache
  },

  /**
   * Is this feature switched on?
   *
   * A missing row means yes. The table is a list of things somebody chose to
   * make switchable; a key nobody has configured is not a feature somebody
   * turned off, and defaulting to "off" would disable a feature on every
   * instance that has not run the seed.
   */
  async enabled (key: string): Promise<boolean> {
    return (await flags.load()).get(key)?.enabled !== false
  }
}
