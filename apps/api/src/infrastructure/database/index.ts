// Where this application meets Postgres.
//
// One pool per process, created from this app's configuration and bound to the
// helpers in @yume/database. Everything in apps/api that needs the database
// imports it from here — not from the package, and not by building its own
// pool — so there is exactly one address to grep for, one place the pool
// settings live, and one import an architecture rule has to watch.
//
// The helpers are re-exported as plain functions rather than as a `db` object
// because that is how the ~77 call sites already read (`query(...)`,
// `queryOne(...)`), and changing the shape of every one of them would have
// buried the actual change of this pass in noise.

import { createPool, helpers } from '@yume/database'

import { config } from '../../config.ts'

export const pool = createPool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  connectionTimeoutMillis: config.dbConnectionTimeoutMs,
  statementTimeoutMillis: config.dbStatementTimeoutMs
})

const db = helpers(pool)

export const query = db.query
export const queryOne = db.queryOne
export const transaction = db.transaction

/** The bound helpers, for a repository that takes them as a constructor argument. */
export { db }
