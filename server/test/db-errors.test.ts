// Unique-constraint handling.
//
// Audit 13 found the same mistake in four places — registration, the like
// toggle and the watch-together room code — each letting a
// 23505 escape as a 500 naming the constraint. Four instances of one mistake
// across two audits is a pattern, so the handling became a shared helper.
// These pin its behaviour, including the parts that must NOT be swallowed.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const {
  PG, isUniqueViolation, isForeignKeyViolation, violatedConstraint,
  onUniqueViolation, retryOnCollision
} = await import('../src/lib/db-errors.ts')

/** What node-postgres actually throws: an Error carrying code and constraint. */
const pgError = (code: string, constraint?: string): Error => {
  const error = new Error('duplicate key value violates unique constraint') as Error & { code: string, constraint?: string }
  error.code = code
  if (constraint) error.constraint = constraint
  return error
}

describe('classification', () => {
  it('recognises a unique violation', () => {
    assert.equal(isUniqueViolation(pgError(PG.UNIQUE_VIOLATION)), true)
  })

  it('does not mistake other failures for one', () => {
    // The whole risk of a helper like this is that it swallows the errors it
    // was not written for.
    for (const other of [
      pgError(PG.FOREIGN_KEY_VIOLATION),
      pgError(PG.CHECK_VIOLATION),
      pgError(PG.NOT_NULL_VIOLATION),
      pgError('42P01'), // undefined table
      new Error('a plain error'),
      undefined,
      null,
      'a string'
    ]) {
      assert.equal(isUniqueViolation(other), false, String(other))
    }
  })

  it('narrows to one named index when asked', () => {
    const error = pgError(PG.UNIQUE_VIOLATION, 'users_email_key')
    assert.equal(isUniqueViolation(error, 'users_email_key'), true)
    assert.equal(isUniqueViolation(error, 'users_username_key'), false)
    assert.equal(violatedConstraint(error), 'users_email_key')
  })

  it('recognises a foreign key violation separately', () => {
    assert.equal(isForeignKeyViolation(pgError(PG.FOREIGN_KEY_VIOLATION)), true)
    assert.equal(isForeignKeyViolation(pgError(PG.UNIQUE_VIOLATION)), false)
  })
})

describe('onUniqueViolation', () => {
  it('returns the write when it succeeds', async () => {
    assert.equal(await onUniqueViolation(async () => 'written', () => 'fallback'), 'written')
  })

  it('returns the fallback on a collision, and names the constraint', async () => {
    const result = await onUniqueViolation(
      async () => { throw pgError(PG.UNIQUE_VIOLATION, 'watch_together_rooms_code_key') },
      constraint => `conflict on ${constraint}`
    )
    assert.equal(result, 'conflict on watch_together_rooms_code_key')
  })

  it('rethrows anything that is not a unique violation', async () => {
    // Hiding a foreign-key or connection failure here would be the same
    // mistake in a new costume.
    await assert.rejects(
      onUniqueViolation(
        async () => { throw pgError(PG.FOREIGN_KEY_VIOLATION, 'comments_author_id_fkey') },
        () => 'should not be reached'
      )
    )
  })

  it('rethrows a collision on a different index than the one named', async () => {
    await assert.rejects(
      onUniqueViolation(
        async () => { throw pgError(PG.UNIQUE_VIOLATION, 'users_email_key') },
        () => 'should not be reached',
        'users_username_key'
      )
    )
  })
})

describe('retryOnCollision', () => {
  it('retries a self-generated key until it lands', async () => {
    // The room-code case: a collision is a fact about the draw, never about
    // the caller, so retrying is the honest response.
    let attempts = 0
    const result = await retryOnCollision(async () => {
      attempts++
      if (attempts < 3) throw pgError(PG.UNIQUE_VIOLATION, 'watch_together_rooms_code_key')
      return 'landed'
    })
    assert.equal(result, 'landed')
    assert.equal(attempts, 3)
  })

  it('gives up loudly rather than spinning on a stuck generator', async () => {
    let attempts = 0
    await assert.rejects(retryOnCollision(async () => {
      attempts++
      throw pgError(PG.UNIQUE_VIOLATION)
    }, 4))
    assert.equal(attempts, 4, 'exactly the allowed number of attempts')
  })

  it('does not retry anything that is not a collision', async () => {
    let attempts = 0
    await assert.rejects(retryOnCollision(async () => {
      attempts++
      throw new Error('connection terminated')
    }))
    assert.equal(attempts, 1, 'a non-collision must fail on the first try')
  })
})
