// Minimal, dependency-free migration runner: applies db/migrations/*.sql in
// filename order, tracking applied files in schema_migrations.
// Usage: DATABASE_URL=… node --experimental-strip-types src/lib/migrate.ts

import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { pool } from '../db.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')

/** Arbitrary constant identifying this runner's advisory lock. */
const MIGRATION_LOCK_KEY = 8_274_119

async function migrate (): Promise<void> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')

  const applied = new Set(
    (await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(row => row.filename)
  )

  // A database created as SQL_ASCII silently turns every character limit into
  // a byte limit: length('á') is 2, so a 4000-character body check rejects
  // Hungarian or Japanese text at roughly half the documented length, with an
  // error that points at the constraint rather than the cause. Postgres cannot
  // change this after initdb, so it has to be caught before data exists.
  const encoding = await pool.query<{ encoding: string }>("SELECT current_setting('server_encoding') AS encoding")
  const serverEncoding = encoding.rows[0]?.encoding
  if (serverEncoding !== 'UTF8') {
    console.warn(
      `WARNING: database encoding is ${serverEncoding}, not UTF8.\n` +
      '  length() will count bytes instead of characters, so text limits apply at a fraction\n' +
      '  of their documented size for non-ASCII content. This cannot be changed in place —\n' +
      '  recreate the database with: CREATE DATABASE yume ENCODING \'UTF8\' TEMPLATE template0;'
    )
  }

  const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort()

  // Serialise across processes.
  //
  // The container migrates on start, so two app replicas coming up together
  // would each read the same pending list and try to apply it. A session-level
  // advisory lock makes the second one wait and then find nothing to do.
  // The key is an arbitrary constant, unique to this migration runner.
  const lockClient = await pool.connect()
  await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])

  // Another process may have applied migrations while we waited for the lock,
  // so the applied set is re-read rather than trusted from before it.
  const fresh = await lockClient.query<{ filename: string }>('SELECT filename FROM schema_migrations')
  for (const row of fresh.rows) applied.add(row.filename)

  try {
  for (const file of files) {
    if (applied.has(file)) continue
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file])
      await client.query('COMMIT')
      console.log(`applied ${file}`)
    } catch (err) {
      await client.query('ROLLBACK')
      console.error(`FAILED ${file}`)
      throw err
    } finally {
      client.release()
    }
  }
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
    lockClient.release()
  }

  await pool.end()
  console.log('migrations up to date')
}

migrate().catch(err => {
  console.error(err)
  process.exit(1)
})
