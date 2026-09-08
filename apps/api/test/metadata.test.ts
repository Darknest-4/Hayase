// Conflict resolution is the rule that keeps operator edits alive across
// importer runs, so every precedence branch is asserted here. resolveFields
// is pure, so none of this needs a database.

import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import { resolveFields, normaliseTitle, rankOf, MANAGED_FIELDS } from '../src/lib/metadata.ts'

const AT = new Date('2026-08-21T12:00:00.000Z')

describe('provider precedence', () => {
  test('an empty field is filled by any provider', () => {
    const r = resolveFields({ synopsis: null }, { synopsis: 'from the seed' }, 'aod', AT)
    assert.equal(r.apply.synopsis, 'from the seed')
    assert.equal(r.sources.synopsis?.provider, 'aod')
  })

  test('a higher-ranked provider overwrites a lower-ranked one', () => {
    const current = { synopsis: 'seed text', metadata_sources: { synopsis: { provider: 'aod', at: '2026-01-01' } } }
    const r = resolveFields(current, { synopsis: 'anilist text' }, 'anilist', AT)
    assert.equal(r.apply.synopsis, 'anilist text')
  })

  test('a lower-ranked provider cannot overwrite a higher-ranked one', () => {
    const current = { synopsis: 'anilist text', metadata_sources: { synopsis: { provider: 'anilist', at: '2026-01-01' } } }
    const r = resolveFields(current, { synopsis: 'stale seed text' }, 'aod', AT)
    assert.deepEqual(r.apply, {})
    assert.equal(r.skipped.synopsis, 'lower-precedence')
  })

  test('a provider may refresh its own field', () => {
    const current = { synopsis: 'old', metadata_sources: { synopsis: { provider: 'anilist', at: '2026-01-01' } } }
    const r = resolveFields(current, { synopsis: 'new' }, 'anilist', AT)
    assert.equal(r.apply.synopsis, 'new')
  })

  test('an unknown provider ranks below every known one', () => {
    assert.equal(rankOf('who-is-this'), 0)
    const current = { synopsis: 'seed', metadata_sources: { synopsis: { provider: 'aod', at: '2026-01-01' } } }
    assert.equal(resolveFields(current, { synopsis: 'x' }, 'who-is-this', AT).skipped.synopsis, 'lower-precedence')
  })
})

describe('human locks', () => {
  test('an automatic source never touches a locked field', () => {
    const current = { synopsis: 'hand written', locked_fields: ['synopsis'] }
    const r = resolveFields(current, { synopsis: 'anilist text' }, 'anilist', AT)
    assert.deepEqual(r.apply, {})
    assert.equal(r.skipped.synopsis, 'locked')
  })

  test('a lock on one field does not block the others', () => {
    const current = { synopsis: 'hand written', popularity: 10, locked_fields: ['synopsis'] }
    const r = resolveFields(current, { synopsis: 'nope', popularity: 500 }, 'anilist', AT)
    assert.deepEqual(Object.keys(r.apply), ['popularity'])
  })

  test('a human edit overrides its own lock', () => {
    const current = { synopsis: 'first pass', locked_fields: ['synopsis'] }
    const r = resolveFields(current, { synopsis: 'second pass' }, 'manual', AT)
    assert.equal(r.apply.synopsis, 'second pass')
  })
})

describe('value handling', () => {
  test('a missing incoming value never erases a stored one', () => {
    const current = { synopsis: 'kept' }
    for (const empty of [null, undefined, '', '   ']) {
      const r = resolveFields(current, { synopsis: empty }, 'anilist', AT)
      assert.deepEqual(r.apply, {}, `empty value ${JSON.stringify(empty)} must not be written`)
      assert.equal(r.skipped.synopsis, 'empty')
    }
  })

  test('an unchanged value is not rewritten but still gains provenance', () => {
    const r = resolveFields({ synopsis: 'same' }, { synopsis: 'same' }, 'anilist', AT)
    assert.deepEqual(r.apply, {})
    assert.equal(r.skipped.synopsis, 'unchanged')
    assert.equal(r.sources.synopsis?.provider, 'anilist')
  })

  test('volatile statistics take the freshest reading regardless of precedence', () => {
    const current = {
      popularity: 100,
      average_score: 70,
      metadata_sources: { popularity: { provider: 'anilist', at: '2026-01-01' }, average_score: { provider: 'anilist', at: '2026-01-01' } }
    }
    const r = resolveFields(current, { popularity: 250, average_score: 82 }, 'mal', AT)
    assert.equal(r.apply.popularity, 250)
    assert.equal(r.apply.average_score, 82)
  })

  test('dates compare across Date objects and ISO strings', () => {
    const r = resolveFields({ start_date: new Date('2013-04-07T00:00:00Z') }, { start_date: '2013-04-07' }, 'anilist', AT)
    assert.equal(r.skipped.start_date, 'unchanged')
  })

  test('unmanaged fields are ignored entirely', () => {
    const r = resolveFields({}, { visibility: 'hidden' } as Record<string, unknown>, 'anilist', AT)
    assert.deepEqual(r.apply, {})
    assert.ok(!(MANAGED_FIELDS as readonly string[]).includes('visibility'))
  })
})

describe('title normalisation', () => {
  test('season markers and roman numerals collapse to one key', () => {
    assert.equal(normaliseTitle('Fate/Zero 2nd Season'), normaliseTitle('Fate Zero Season II'))
  })

  test('punctuation, accents and articles are folded away', () => {
    assert.equal(normaliseTitle('Gintama°'), 'gintama')
    assert.equal(normaliseTitle('The Promised Neverland!'), 'promised neverland')
  })

  test('genuinely different titles keep different keys', () => {
    assert.notEqual(normaliseTitle('One Piece'), normaliseTitle('One Punch Man'))
  })
})
