// The bot's client for the Yume API.
//
// Read-only and unauthenticated for now, deliberately. Every endpoint used
// here is public — the catalogue, search, the schedule, health — so the bot
// needs no credential to answer `/search`, and a bot that holds no credential
// cannot leak one.
//
// Account-scoped commands (`/profile`, `/list`) need the account linking flow
// in docs/discord-bot.md §3 and are not implemented here; they would use a
// service token plus an act-as-user header, not a stored user token.

import { config } from './config.ts'

const timeout = (ms: number): AbortSignal => AbortSignal.timeout(ms)

async function get<T> (path: string): Promise<T | null> {
  try {
    const res = await fetch(config.apiUrl + path, { signal: timeout(8000), headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    return await res.json() as T
  } catch {
    // The API being down is a normal state for the bot: it is what `/status`
    // exists to report, not an exception to propagate.
    return null
  }
}

export interface AnimeCard {
  id: string
  anilist_id: number | null
  canonical_title: string
  format: string | null
  season_year: number | null
  episode_count: number | null
  average_score: number | null
  cover_key: string | null
}

export const yume = {
  async health (): Promise<{ ok: boolean, detail: Record<string, unknown> | null }> {
    const detail = await get<Record<string, unknown>>('/v1/health')
    return { ok: detail !== null, detail }
  },

  async ready (): Promise<Record<string, unknown> | null> {
    return get<Record<string, unknown>>('/v1/health/ready')
  },

  async search (query: string, limit = 5): Promise<AnimeCard[]> {
    const data = await get<{ data: AnimeCard[] }>(`/v1/anime/search?q=${encodeURIComponent(query)}&limit=${limit}`)
    return data?.data ?? []
  },

  async schedule (): Promise<Array<{ canonical_title: string, number: number, air_date: string }>> {
    const from = new Date().toISOString()
    const to = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
    const data = await get<{ data: Array<{ canonical_title: string, number: number, air_date: string }> }>(
      `/v1/anime/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
    return data?.data ?? []
  },

  async recent (limit = 5): Promise<AnimeCard[]> {
    const data = await get<{ data: AnimeCard[] }>(`/v1/anime/?sort=newest&limit=${limit}`)
    return data?.data ?? []
  },

  /** A link to a title on the site. Prefers the AniList id, which the router accepts. */
  link (card: AnimeCard, episode?: number): string {
    const id = card.anilist_id ?? card.id
    return episode ? `${config.siteUrl}/#/watch/${id}?ep=${episode}` : `${config.siteUrl}/#/anime/${id}`
  }
}
