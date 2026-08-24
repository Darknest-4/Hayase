// Resolving catalogue text into a language, and reporting which one it
// actually landed on.
//
// The `_lang` marker is the reason this module exists rather than a COALESCE
// in the query: a Hungarian viewer shown an unexplained English paragraph
// reads it as the site being broken, and the same paragraph labelled as
// untranslated reads as what it is. Every assertion about `_lang` below is
// guarding that, not a formatting detail.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { localiseAnime, localiseEpisode, pick, resolveSynopsis, resolveTitle } from '../src/lib/localise.ts'

describe('pick', () => {
  it('takes the first candidate that has something in it', () => {
    assert.deepEqual(pick([[null, 'hu'], ['x', 'en']]), { value: 'x', language: 'en' })
  })

  it('treats a blank string as absent', () => {
    // An empty translation row is not a translation, and serving it hands the
    // viewer a blank description instead of the English it could have had.
    assert.deepEqual(pick([['   ', 'hu'], ['real', 'en']]), { value: 'real', language: 'en' })
    assert.deepEqual(pick([['', 'hu'], ['real', 'en']]), { value: 'real', language: 'en' })
  })

  it('reports unknown when nothing is available', () => {
    assert.deepEqual(pick([[null, 'hu'], [undefined, 'en']]), { value: null, language: 'unknown' })
  })

  it('keeps a falsy non-string value, which is not the same as absent', () => {
    assert.deepEqual(pick<number>([[0, 'hu']]), { value: 0, language: 'hu' })
  })
})

describe('title resolution', () => {
  const row = {
    canonical_title: 'Shingeki no Kyojin',
    title_romaji: 'Shingeki no Kyojin',
    title_english: 'Attack on Titan',
    title_native: '進撃の巨人',
    title_hu: 'A titánok támadása'
  }

  it('serves each requested form', () => {
    assert.equal(resolveTitle(row, 'romaji').value, 'Shingeki no Kyojin')
    assert.equal(resolveTitle(row, 'english').value, 'Attack on Titan')
    assert.equal(resolveTitle(row, 'native').value, '進撃の巨人')
    assert.equal(resolveTitle(row, 'hungarian').value, 'A titánok támadása')
  })

  it('reports which form it served', () => {
    assert.equal(resolveTitle(row, 'hungarian').language, 'hu')
    assert.equal(resolveTitle(row, 'english').language, 'en')
    assert.equal(resolveTitle(row, 'native').language, 'native')
  })

  it('falls back to romaji when the requested form does not exist', () => {
    // Only three of 25,675 title rows are English and one is native, so this
    // is the common path, not the edge case.
    const sparse = { canonical_title: 'Some Show', title_romaji: 'Some Show' }
    const hungarian = resolveTitle(sparse, 'hungarian')
    assert.equal(hungarian.value, 'Some Show')
    assert.equal(hungarian.language, 'romaji', 'must not claim to be Hungarian')
  })

  it('falls back to the canonical title when there are no title rows at all', () => {
    assert.equal(resolveTitle({ canonical_title: 'Only This' }, 'english').value, 'Only This')
  })

  it('treats an unknown preference as romaji rather than failing', () => {
    assert.equal(resolveTitle(row, 'klingon').value, 'Shingeki no Kyojin')
  })
})

describe('synopsis resolution', () => {
  const row = { synopsis: 'English text', synopsis_hu: 'Magyar szöveg' }

  it('serves the Hungarian translation to a Hungarian viewer', () => {
    assert.deepEqual(resolveSynopsis(row, 'hu'), { value: 'Magyar szöveg', language: 'hu' })
  })

  it('serves English to an English viewer even when a translation exists', () => {
    assert.deepEqual(resolveSynopsis(row, 'en'), { value: 'English text', language: 'en' })
  })

  it('falls back to English and says so', () => {
    // 25,703 synopses are English, so this is what most requests hit.
    const result = resolveSynopsis({ synopsis: 'English text' }, 'hu')
    assert.equal(result.value, 'English text')
    assert.equal(result.language, 'en', 'the marker is what lets the UI be honest about this')
  })

  it('falls back to a Hungarian translation for an English viewer with no source text', () => {
    assert.deepEqual(resolveSynopsis({ synopsis_hu: 'Csak magyarul' }, 'en'), { value: 'Csak magyarul', language: 'hu' })
  })

  it('reports unknown when there is no text in any language', () => {
    assert.deepEqual(resolveSynopsis({}, 'hu'), { value: null, language: 'unknown' })
  })
})

describe('localiseAnime', () => {
  const row = {
    id: 'abc',
    canonical_title: 'Shingeki no Kyojin',
    title_romaji: 'Shingeki no Kyojin',
    title_english: 'Attack on Titan',
    title_hu: 'A titánok támadása',
    synopsis: 'English text',
    synopsis_hu: 'Magyar szöveg',
    popularity: 100
  }

  it('applies both axes independently', () => {
    // The case the four-axis design exists for: a Hungarian viewer who wants a
    // Hungarian description but romaji titles, which is how the community
    // refers to shows. One combined "language" switch could not express it.
    const out = localiseAnime(row, { language: 'hu', titles: 'romaji' })
    assert.equal(out.canonical_title, 'Shingeki no Kyojin')
    assert.equal(out.synopsis, 'Magyar szöveg')
    assert.deepEqual(out._lang, { title: 'romaji', synopsis: 'hu' })
  })

  it('strips the join columns from the payload', () => {
    // Leaving them in doubles the payload and invites clients to reimplement
    // the fallback and get it subtly different.
    const out = localiseAnime(row, { language: 'hu', titles: 'romaji' })
    for (const key of ['title_hu', 'synopsis_hu', 'title_romaji', 'title_english', 'title_native']) {
      assert.ok(!(key in out), `${key} leaked into the response`)
    }
  })

  it('keeps every other column untouched', () => {
    const out = localiseAnime(row, { language: 'hu', titles: 'romaji' })
    assert.equal(out.id, 'abc')
    assert.equal(out.popularity, 100)
  })

  it('does not mutate the row it was given', () => {
    // Callers hand the same row to more than one consumer.
    const original = { ...row }
    localiseAnime(row, { language: 'hu', titles: 'hungarian' })
    assert.deepEqual(row, original)
  })

  it('never leaves the title empty', () => {
    // A missing title renders a blank card, which looks like a broken record
    // rather than a missing translation.
    const out = localiseAnime({ canonical_title: 'Fallback' }, { language: 'hu', titles: 'hungarian' })
    assert.equal(out.canonical_title, 'Fallback')
  })
})

describe('localiseEpisode', () => {
  it('prefers the translated episode title', () => {
    const out = localiseEpisode(
      { number: 1, title: 'To You, in 2000 Years', title_hu: 'Neked, 2000 év múlva', synopsis: 'x' },
      'hu'
    )
    assert.equal(out.title, 'Neked, 2000 év múlva')
    assert.equal((out._lang as Record<string, string>).title, 'hu')
  })

  it('falls back to the original and marks it', () => {
    const out = localiseEpisode({ number: 1, title: 'Episode One' }, 'hu')
    assert.equal(out.title, 'Episode One')
    assert.equal((out._lang as Record<string, string>).title, 'en')
  })

  it('strips the join columns', () => {
    const out = localiseEpisode({ title: 'a', title_hu: 'b', synopsis_hu: 'c' }, 'hu')
    assert.ok(!('title_hu' in out))
    assert.ok(!('synopsis_hu' in out))
  })
})
