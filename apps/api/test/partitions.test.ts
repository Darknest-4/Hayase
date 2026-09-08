// Partitions: a migrated database must be writable today.
//
// The defect this covers shipped and reached CI. Every partitioned table is
// created by a migration that also creates its first partitions as literal
// months, the newest of which was 2026-08. On 2026-09-01 that stopped covering
// `now()`, and the first INSERT into audit_logs failed with
//
//   no partition of relation "audit_logs" found for row
//
// Registration writes an audit row inside its transaction, so a freshly
// deployed instance answered 500 to the first account anybody tried to create
// — from a schema that had just been applied without an error.
//
// The assertions are deliberately about the calendar rather than about a
// count: "the current month has a partition" is still true next year, whereas
// "there are three partitions" would pass on a database nobody could write to.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const REASON = process.env.DATABASE_URL ? false : 'no DATABASE_URL'

describe('event table partitions', { skip: REASON }, () => {
  let pool, ensurePartitions, PARTITIONED, partitionName, monthStart

  before(async () => {
    const [db, partitions] = await Promise.all([
      import('../src/infrastructure/database/index.ts'),
      import('../src/infrastructure/migrations/partitions.ts')
    ])
    pool = db.pool
    ;({ ensurePartitions, PARTITIONED, partitionName, monthStart } = partitions)
    await ensurePartitions()
  })

  after(async () => { await pool?.end() })

  const exists = async (name: string): Promise<boolean> =>
    ((await pool.query('SELECT 1 FROM pg_class WHERE relname = $1', [name])).rowCount ?? 0) > 0

  it('covers this month and the next two for every partitioned table', async () => {
    for (const { table } of PARTITIONED) {
      if (!await exists(table)) continue // the migration creating it has not run
      for (const offset of [0, 1, 2]) {
        const name = partitionName(table, monthStart(offset))
        assert.ok(await exists(name), `${name} is missing — ${table} cannot take a row`)
      }
    }
  })

  // The specific failure. Registration, every admin action and every
  // moderation decision write an audit row, so this one insert is what made a
  // whole instance unusable.
  it('accepts an audit row dated now', async () => {
    const { rows } = await pool.query(
      `INSERT INTO audit_logs (action, subject_type, subject_id)
       VALUES ('test.partition', 'test', 'partition-regression')
       RETURNING id, created_at`
    )
    assert.equal(rows.length, 1)
    await pool.query('DELETE FROM audit_logs WHERE id = $1 AND created_at = $2', [rows[0].id, rows[0].created_at])
  })

  // Called on every boot and every hour, so creating what already exists has
  // to be free rather than an error.
  it('is idempotent', async () => {
    assert.deepEqual(await ensurePartitions(), [], 'a second call created something')
  })

  it('names partitions by the month they hold', () => {
    assert.equal(partitionName('audit_logs', new Date(Date.UTC(2027, 0, 1))), 'audit_logs_2027_01')
    assert.equal(partitionName('page_views', new Date(Date.UTC(2026, 9, 1))), 'page_views_2026_10')
  })
})
