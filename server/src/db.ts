// Postgres access. One pool per process; typed helper for parameterised
// queries. Services build SQL here — routes never touch the pool directly.

import pg from 'pg'

import { config } from './config.ts'

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  idleTimeoutMillis: 30_000,
  // Wait a bounded time for a free connection instead of queueing forever:
  // under saturation a fast 503 is far more useful than a request that hangs.
  connectionTimeoutMillis: config.dbConnectionTimeoutMs,
  // Server-side ceiling on any single statement. Without it one runaway query
  // holds its connection indefinitely, and enough of those stall the API.
  statement_timeout: config.dbStatementTimeoutMs || undefined
})

export async function query<Row extends pg.QueryResultRow = pg.QueryResultRow> (
  text: string,
  params: unknown[] = []
): Promise<Row[]> {
  const result = await pool.query<Row>(text, params)
  return result.rows
}

export async function queryOne<Row extends pg.QueryResultRow = pg.QueryResultRow> (
  text: string,
  params: unknown[] = []
): Promise<Row | undefined> {
  const rows = await query<Row>(text, params)
  return rows[0]
}

/** Run fn inside a transaction; rolls back on throw. */
export async function transaction<T> (fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
