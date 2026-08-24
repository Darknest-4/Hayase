// Minimal, dependency-free migration runner: applies db/migrations/*.sql in
// filename order, tracking applied files in schema_migrations.
// Usage: DATABASE_URL=… node --experimental-strip-types src/lib/migrate.ts

import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { pool } from '../db.ts'
import { check as checkEncoding } from './db-encoding.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')

/** Arbitrary constant identifying this runner's advisory lock. */
const MIGRATION_LOCK_KEY = 8_274_119

async function migrate (): Promise<void> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')

  const applied = new Set(
    (await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(row => row.filename)
  )

  // Encoding is checked here because this is the last moment it is free to
  // fix. `applied.size === 0` means the schema is about to be created, so
  // there is no data to migrate and recreating the database is a one-liner;
  // once rows exist, the same defect costs a dump and restore, and refusing
  // to start would be worse than the defect itself. See lib/db-encoding.ts.
  const encodingVerdict = await checkEncoding(
    async (sql, params) => (await pool.query(sql, params as unknown[])).rows,
    applied.size === 0
  )
  if (encodingVerdict.level === 'fatal') {
    await pool.end()
    process.exit(1)
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
