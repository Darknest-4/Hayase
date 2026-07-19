// Minimal, dependency-free migration runner: applies db/migrations/*.sql in
// filename order, tracking applied files in schema_migrations.
// Usage: DATABASE_URL=… node --experimental-strip-types src/lib/migrate.ts

import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { pool } from '../db.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')

async function migrate (): Promise<void> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')

  const applied = new Set(
    (await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(row => row.filename)
  )

  const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort()

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

  await pool.end()
  console.log('migrations up to date')
}

migrate().catch(err => {
  console.error(err)
  process.exit(1)
})
