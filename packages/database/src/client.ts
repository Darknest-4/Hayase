// The Postgres client: a pool, and the three helpers everything else uses.
//
// This package holds the *mechanism* and nothing else. It reads no
// environment, imports no application config and knows no table names — the
// application creates the pool from its own configuration and re-exports the
// helpers at a stable address (apps/api/src/infrastructure/database).
//
// The separation is the point. It is what lets an architecture rule say
// "nothing under modules/*/domain may import a database client" and have that
// rule mean something, and it is what keeps the connection settings — pool
// size, statement timeout, connection timeout — in one reviewable place
// instead of being rediscovered next to whichever query first needed them.

import pg from 'pg'

export interface PoolOptions {
  connectionString: string
  /** Maximum connections. Ten was too few to absorb a burst. */
  max: number
  /**
   * How long a caller waits for a free connection.
   *
   * Bounded on purpose: under saturation a fast 503 is far more useful than a
   * request that hangs, and an unbounded wait turns one slow query into an
   * outage that looks like a network problem.
   */
  connectionTimeoutMillis: number
  /**
   * Server-side ceiling on any single statement, in milliseconds. 0 disables
   * it. Without it one runaway query holds its connection indefinitely, and
   * enough of those stall the whole API.
   */
  statementTimeoutMillis: number
  idleTimeoutMillis?: number
}

export function createPool (options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    statement_timeout: options.statementTimeoutMillis || undefined
  })

  /*
   * A TÉTLEN KAPCSOLATOK HIBÁI — enélkül egy adatbázis-újraindítás megöli a
   * folyamatot.
   *
   * A `pg` készlete `error` eseményt bocsát ki, ha egy ÉPPEN NEM HASZNÁLT
   * kapcsolaton hálózati vagy kiszolgálóoldali hiba történik. Az ilyen esemény
   * nem tartozik egyetlen `await`-hez sem, tehát nincs, aki elkapja: ha nincs
   * figyelő, a Node `EventEmitter`-e kivételt dob, és a folyamat kilép.
   *
   * MÉRVE, EGY HANGOLÁSI ÚJRAINDÍTÁSKOR: a Postgres `terminating connection
   * due to administrator command`-ot küldött a tétlen kapcsolatokra, és
   * EZ MEGÖLTE MIND AZ API-T, MIND A WORKERT — `throw er; // Unhandled
   * 'error' event`, majd újraindulás. A `restart: unless-stopped` visszahozta
   * őket, de addig a futó kérések elhasaltak, és minden tervezett
   * adatbázis-karbantartás így végződött volna.
   *
   * A helyes viselkedés nem a kilépés: a készlet eldobja a rossz kapcsolatot,
   * és a következő kérés újat nyit. Ez a figyelő pontosan ennyit tesz —
   * feljegyzi, és hagyja dolgozni a készletet.
   */
  pool.on('error', error => {
    console.error('adatbázis-készlet hibája egy tétlen kapcsolaton:', (error as Error).message)
  })

  return pool
}

/** What a caller needs to run SQL. Anything holding one of these can reach the database. */
export interface Db {
  query: <Row extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) => Promise<Row[]>
  queryOne: <Row extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) => Promise<Row | undefined>
  transaction: <T>(fn: (client: pg.PoolClient) => Promise<T>) => Promise<T>
}

/**
 * Bind the helpers to a pool.
 *
 * `transaction` rolls back on throw and always releases. The rollback is
 * itself guarded: if the connection died mid-transaction the ROLLBACK throws
 * too, and letting that escape would replace the real error — the one that
 * says what actually went wrong — with a connection error.
 */
export function helpers (pool: pg.Pool): Db {
  const query = async <Row extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string, params: unknown[] = []
  ): Promise<Row[]> => (await pool.query<Row>(text, params)).rows

  const queryOne = async <Row extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string, params: unknown[] = []
  ): Promise<Row | undefined> => (await query<Row>(text, params))[0]

  const transaction = async <T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // The connection is already gone, which is why the work failed. The
        // original error is the one worth reporting.
      }
      throw err
    } finally {
      client.release()
    }
  }

  return { query, queryOne, transaction }
}
