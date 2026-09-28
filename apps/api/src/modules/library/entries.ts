// Library entries: the one place a title is put on, or taken off, a list.
//
// Shared by the REST routes and the GraphQL mutations. The two used to carry
// their own copies with their own validation — REST refused a score above 10,
// GraphQL stored whatever it was sent — and neither checked that the title
// was visible, so a hidden title could be added by id and then read back,
// title and cover, through the library listing.

import { query, queryOne } from '../../infrastructure/database/index.ts'

export const LIBRARY_STATUSES = ['WATCHING', 'PLANNING', 'COMPLETED', 'PAUSED', 'DROPPED', 'REWATCHING'] as const
export type LibraryStatus = typeof LIBRARY_STATUSES[number]

export interface EntryChange {
  status?: string | undefined
  progress?: number | undefined
  score?: number | undefined
  notes?: string | undefined
}

export interface EntryRow {
  anime_id: string
  status: string
  progress: number
  score: string | null
  rewatches: number
  notes: string | null
  updated_at: string
  [column: string]: unknown
}

/** Why a change was refused. `null` from `validate` means it is acceptable. */
export function validate (change: EntryChange): string | null {
  if (change.status !== undefined && !(LIBRARY_STATUSES as readonly string[]).includes(change.status)) {
    return 'Unknown library status'
  }
  if (change.progress !== undefined && (!Number.isInteger(change.progress) || change.progress < 0 || change.progress > 100_000)) {
    return 'Progress must be a whole number of episodes, zero or more'
  }
  if (change.score !== undefined && (!Number.isFinite(change.score) || change.score < 0 || change.score > 10)) {
    return 'Score must be between 0 and 10'
  }
  if (change.notes !== undefined && change.notes.length > 2000) return 'Notes are limited to 2000 characters'
  return null
}

/**
 * Put a title on the profile's list, or change how it sits there.
 *
 * `undefined` when the title does not exist or is hidden — the caller answers
 * 404 either way, because "hidden" must look exactly like "not there".
 * Reaching the last episode without saying otherwise completes the entry.
 */
export async function saveEntry (profileId: string, animeId: string, change: EntryChange): Promise<EntryRow | undefined> {
  const anime = await queryOne<{ episode_count: number | null }>(
    "SELECT episode_count FROM anime WHERE id = $1 AND visibility <> 'hidden'", [animeId])
  if (!anime) return undefined

  let status = change.status
  if (status === undefined && change.progress !== undefined && anime.episode_count && change.progress >= anime.episode_count) {
    status = 'COMPLETED'
  }

  return await queryOne<EntryRow>(
    `INSERT INTO library_entries (profile_id, anime_id, status, progress, score, notes)
     VALUES ($1, $2, coalesce($3, 'PLANNING')::library_status, coalesce($4, 0), $5, $6)
     ON CONFLICT (profile_id, anime_id) DO UPDATE SET
       status = coalesce($3::library_status, library_entries.status),
       progress = coalesce($4, library_entries.progress),
       score = coalesce($5, library_entries.score),
       notes = coalesce($6, library_entries.notes)
     RETURNING *`,
    [profileId, animeId, status ?? null, change.progress ?? null, change.score ?? null, change.notes ?? null]
  )
}

export async function removeEntry (profileId: string, animeId: string): Promise<void> {
  await query('DELETE FROM library_entries WHERE profile_id = $1 AND anime_id = $2', [profileId, animeId])
}

/** Favourite a title. `false` when it does not exist or is hidden. */
export async function addFavorite (profileId: string, animeId: string): Promise<boolean> {
  const rows = await query(
    `INSERT INTO favorites (profile_id, subject_type, subject_id)
     SELECT $1, 'anime', a.id FROM anime a WHERE a.id = $2 AND a.visibility <> 'hidden'
     ON CONFLICT DO NOTHING
     RETURNING 1`,
    [profileId, animeId]
  )
  if (rows.length) return true
  // Nothing inserted: either it was already a favourite, or the title is not there.
  return Boolean(await queryOne("SELECT 1 FROM anime WHERE id = $1 AND visibility <> 'hidden'", [animeId]))
}
