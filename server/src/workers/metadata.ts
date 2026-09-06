// Metadata synchronisation runs: the AniList enrichment, driven from the
// administration panel instead of from a shell.
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
// Both enrichment passes were reachable only through `scripts/import-anilist.ts`
// — an operator with SSH ran it, watched it print, and that was the whole
// interface. Nothing recorded that a run had happened, so "is the catalogue
// current?" had no answer short of counting rows by hand, and a failure in the
// middle of a half-hour pass was a line in a terminal nobody kept.
//
// The pass itself is unchanged. This wraps it in a row that says what was
// asked for, how far it got, and what it changed.
//
// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------
// AniList publishes a rate limit and the passes are paced to stay under it.
// The single-active-run index in migration 0028 is what makes that pacing
// mean something: two runs at once would double the request rate. Cancelling
// is cooperative and lands at a batch boundary — a run is a long sequence of
// paced requests, not something to abandon mid-transaction.

import { query, queryOne } from '../db.ts'
import { enrichFromAniList } from './anilist.ts'
import { enrichDeepFromAniList } from './anilist-deep.ts'

/**
 * The two passes, reached through an object rather than called directly.
 *
 * Both talk to AniList over the network, so a test that drove the handler
 * would either hit a live third party — rate-limited, and not ours to hammer
 * — or test nothing. Going through this object lets a test substitute a pass
 * that reports progress and returns counts, which is what the handler's own
 * logic is about: recording progress, honouring a cancel, and finishing
 * exactly once.
 */
export const passes = {
  basic: enrichFromAniList,
  deep: enrichDeepFromAniList
}

import type { Job } from '../lib/queue.ts'

export interface MetadataRun {
  id: string
  kind: 'basic' | 'deep'
  scope: 'missing' | 'all'
  max_items: number | null
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  processed: number
  total: number
  updated_rows: number
  counts: Record<string, number>
  error: string | null
  started_by: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

/**
 * How often progress reaches the database.
 *
 * The basic pass reports every 50 titles, which on a full catalogue is a write
 * every couple of seconds for half an hour. The panel polls; it does not need
 * finer than this, and the run's own progress must not become the reason the
 * pool is busy.
 */
const PROGRESS_INTERVAL_MS = 2_000

/** The run that is queued or running, if there is one. */
export async function activeRun (): Promise<MetadataRun | undefined> {
  return await queryOne<MetadataRun>(
    "SELECT * FROM metadata_runs WHERE status IN ('queued', 'running') LIMIT 1"
  ) ?? undefined
}

/**
 * Claim the one run slot.
 *
 * Throws `RunInProgress` when another run holds it. Both callers go through
 * here — the administration panel and the command-line script — because a
 * guarantee that only one of the two respects is not a guarantee: two paced
 * passes at once is exactly the request rate AniList publishes a limit for.
 */
export class RunInProgress extends Error {
  constructor () { super('A metadata run is already in progress') }
}

export async function startRun (opts: {
  kind: 'basic' | 'deep'
  scope: 'missing' | 'all'
  limit?: number | null
  startedBy?: string | null
}): Promise<MetadataRun> {
  try {
    const row = await queryOne<MetadataRun>(
      `INSERT INTO metadata_runs (kind, scope, max_items, started_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [opts.kind, opts.scope, opts.limit ?? null, opts.startedBy ?? null]
    )
    if (!row) throw new RunInProgress()
    return row
  } catch (err) {
    // The partial unique index is what actually enforces one at a time; a
    // check-then-insert would still lose a race between two operators.
    if ((err as { code?: string }).code === '23505') throw new RunInProgress()
    throw err
  }
}

/** Ask a run to stop. It ends at the next batch boundary. */
export async function requestCancel (id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE metadata_runs SET status = 'cancelled', finished_at = CASE WHEN status = 'queued' THEN now() END
      WHERE id = $1 AND status IN ('queued', 'running')
      RETURNING id`,
    [id]
  )
  return Boolean(row)
}

/**
 * Run one enrichment pass, keeping its row current as it goes.
 *
 * The status is only moved to 'done'/'failed' from 'running' — a cancel that
 * lands while the last batch is in flight has already written 'cancelled', and
 * the finishing write must not quietly undo it.
 */
export async function handleMetadataJob (job: Job): Promise<void> {
  const runId = String(job.payload.runId ?? '')
  const run = await queryOne<MetadataRun>('SELECT * FROM metadata_runs WHERE id = $1', [runId])
  if (!run) return // the row was deleted; nothing to do and nothing to report
  if (run.status !== 'queued') return // already claimed, or cancelled before it started

  await query("UPDATE metadata_runs SET status = 'running', started_at = now() WHERE id = $1", [runId])

  let lastWrite = 0
  const record = async (processed: number, total: number, counts: Record<string, number>): Promise<void> => {
    if (Date.now() - lastWrite < PROGRESS_INTERVAL_MS && processed < total) return
    lastWrite = Date.now()
    await query(
      `UPDATE metadata_runs SET processed = $2, total = $3, updated_rows = $4, counts = $5::jsonb
        WHERE id = $1`,
      [runId, processed, total, counts.updated ?? 0, JSON.stringify(counts)]
    )
  }

  // Read from the row rather than from a local flag: the cancel arrives on a
  // different connection, in a different process from the one that is running.
  const shouldStop = async (): Promise<boolean> => {
    const row = await queryOne<{ status: string }>('SELECT status FROM metadata_runs WHERE id = $1', [runId])
    return row?.status !== 'running'
  }

  const onlyMissing = run.scope === 'missing'
  const limit = run.max_items ?? undefined

  try {
    if (run.kind === 'deep') {
      const result = await passes.deep({
        onlyMissing,
        ...(limit ? { limit } : {}),
        shouldStop,
        onProgress: async (done, total, counts) => await record(done, total, { ...counts })
      })
      await finish(runId, {
        characters: result.characters,
        voices: result.voices,
        staff: result.staff,
        relations: result.relations,
        recommendations: result.recommendations,
        failed: result.failed,
        rowFailures: result.rowFailures
      }, result.processed)
    } else {
      const result = await passes.basic({
        onlyMissing,
        ...(limit ? { limit } : {}),
        shouldStop,
        onProgress: async (done, total, updated) => await record(done, total, { updated })
      })
      await finish(runId, {
        updated: result.updated,
        failed: result.failed,
        rowFailures: result.rowFailures,
        conflicts: result.conflicts
      }, result.processed)
    }
  } catch (err) {
    // The message, not the stack: this string is shown to an operator in the
    // panel, and a stack there is noise they cannot act on. The stack is in
    // the worker's own error log.
    await query(
      `UPDATE metadata_runs SET status = 'failed', error = $2, finished_at = now()
        WHERE id = $1 AND status = 'running'`,
      [runId, (err as Error).message.slice(0, 500)]
    )
    throw err
  }
}

async function finish (runId: string, counts: Record<string, number>, processed: number): Promise<void> {
  await query(
    `UPDATE metadata_runs
        SET status = 'done', counts = $2::jsonb, updated_rows = $3, processed = $4, finished_at = now()
      WHERE id = $1 AND status = 'running'`,
    [runId, JSON.stringify(counts), counts.updated ?? 0, processed]
  )
  // A cancelled run still has to stop being "running": the pass returned
  // because it was asked to, and the row already says cancelled — but its
  // finished_at is not set until here.
  await query(
    "UPDATE metadata_runs SET finished_at = now(), processed = $2 WHERE id = $1 AND status = 'cancelled' AND finished_at IS NULL",
    [runId, processed]
  )
}

/**
 * Coverage: how much of the catalogue actually has each kind of metadata.
 *
 * One pass over `anime` plus three existence checks. It is an administration
 * query, not a health check — nothing on a hot path calls it.
 */
export async function coverage (): Promise<Record<string, number>> {
  const row = await queryOne<Record<string, string>>(
    `SELECT count(*)                                                          AS total,
            count(*) FILTER (WHERE m.anilist_id IS NOT NULL)                  AS mapped,
            count(*) FILTER (WHERE a.synopsis IS NOT NULL)                    AS with_synopsis,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM anime_images i WHERE i.anime_id = a.id AND i.kind = 'cover')) AS with_cover,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM anime_characters c WHERE c.anime_id = a.id)) AS with_cast,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM anime_relations r WHERE r.anime_id = a.id))  AS with_relations
       FROM anime a
       LEFT JOIN anime_mappings m ON m.anime_id = a.id`
  )
  const conflicts = await queryOne<{ n: string }>(
    'SELECT count(*) AS n FROM mapping_conflicts WHERE resolved_at IS NULL'
  )
  return {
    total: Number(row?.total ?? 0),
    mapped: Number(row?.mapped ?? 0),
    withSynopsis: Number(row?.with_synopsis ?? 0),
    withCover: Number(row?.with_cover ?? 0),
    withCast: Number(row?.with_cast ?? 0),
    withRelations: Number(row?.with_relations ?? 0),
    openConflicts: Number(conflicts?.n ?? 0)
  }
}
