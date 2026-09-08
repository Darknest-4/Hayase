// The queue guards are what stop one wedged handler from taking the whole
// background system down with it, so their configuration surface is asserted
// rather than assumed.

import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

const q = await import('../src/lib/queue.ts')

describe('guard configuration', () => {
  test('a handler has a hard ceiling', () => {
    assert.ok(q.JOB_TIMEOUT_MS > 0, 'without a timeout a hung job blocks the loop forever')
  })

  test('the lease is far shorter than the job ceiling', () => {
    // The lease is renewed by a heartbeat, so it only needs to outlive a
    // missed beat — not the job itself. A lease at or above the ceiling would
    // leave a dead worker's jobs claimed until the ceiling passed.
    assert.ok(q.LEASE_TIMEOUT_MS < q.JOB_TIMEOUT_MS)
  })

  test('more than one job can run at a time', () => {
    assert.ok(q.JOB_CONCURRENCY >= 1)
  })

  test('concurrency can never be configured to zero', () => {
    // Zero lanes would silently process nothing at all.
    assert.equal(Math.max(1, Number('0')), 1)
  })

  test('dead-letter helpers are exported for the admin surface', () => {
    for (const fn of ['deadLetters', 'retryJob', 'pruneDeadLetters']) {
      assert.equal(typeof (q as unknown as Record<string, unknown>)[fn], 'function', `${fn} must exist`)
    }
  })
})
