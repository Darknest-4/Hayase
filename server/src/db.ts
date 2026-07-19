// Postgres access. One pool per process; typed helper for parameterised
// queries. Services build SQL here — routes never touch the pool directly.

import pg from 'pg'

import { config } from './config.ts'

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000
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
