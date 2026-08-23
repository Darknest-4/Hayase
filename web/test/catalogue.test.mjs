// Catalogue resolver tests.
//
// This layer decides whether our own database or an external provider answers
// a request for an anime, and it is the only place that knows both
// vocabularies. Two things have to hold, and neither is visible by reading the
// detail page:
//
//   * the mapping must produce the AniList shape the whole UI is written
//     against, from a catalogue row that names everything differently;
//   * precedence must be catalogue-first with a fallback, not the reverse —
//     which is what it was, so a title whose every field sat in our database
//     still failed to load when AniList was down.
//
// Loaded against a stub window, like the streaming engine tests: no browser,
// no server, no network.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it, before, beforeEach } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Objects built inside the vm get that realm's Object.prototype, and
 * assert.deepEqual compares prototypes — so a structurally identical result
 * fails as "not reference-equal". Round-tripping brings the value back into
 * this realm. Everything the resolver produces is JSON-safe, so nothing is
 * lost in the trip.
 */
const plain = value => JSON.parse(JSON.stringify(value))

/** A catalogue row shaped exactly as GET /v1/anime/:id returns it. */
const ROW = {
  id: '11111111-2222-4333-8444-555555555555',
  canonical_title: 'Sousou no Frieren',
  format: 'TV',
  status: 'FINISHED',
  season: 'FALL',
  season_year: 2023,
  start_date: '2023-09-29',
  end_date: '2024-03-22',
  episode_count: 28,
  episode_duration: 24,
  average_score: 91,
  is_adult: false,
  synopsis: 'An elf mage outlives her party.',
  country: 'JP',
  source_material: 'MANGA',
  next_airing_at: null,
  next_airing_ep: null,
  titles: { romaji: 'Sousou no Frieren', english: 'Frieren: Beyond Journey’s End', native: '葬送のフリーレン' },
  synonyms: ['Frieren at the Funeral'],
  genres: ['Adventure', 'Drama', 'Fantasy'],
  tags: [{ name: 'Elf', rank: 90 }, { name: 'Magic', rank: 80 }],
  companies: [{ name: 'Madhouse', role: 'studio', isMain: true }, { name: 'Aniplex', role: 'producer', isMain: false }],
  images: [
    { kind: 'cover', key: 'https://cdn.example/cover.jpg', color: '#3a6ea5' },
    { kind: 'banner', key: 'https://cdn.example/banner.jpg', color: null }
  ],
  mappings: { anilist_id: 154587, mal_id: 52991, anidb_id: 17383 },
  metadata_sources: { synopsis: 'anilist', canonical_title: 'manual' }
}

let Catalogue
let calls

/** Stubs for the two things the resolver talks to. */
function load ({ catalogueMedia, catalogueEpisodes, catalogueRelations, apiMedia, apiEpisodes } = {}) {
  calls = { catalogue: 0, anilist: 0, aniZip: 0 }
  const window = {}
  const context = {
    window,
    console,
    YumeAPI: {
      async catalogueMedia (id) { calls.catalogue++; return catalogueMedia ? catalogueMedia(id) : null },
      async catalogueEpisodes (id) { return catalogueEpisodes ? catalogueEpisodes(id) : null },
      async catalogueRelations (id) { return catalogueRelations ? catalogueRelations(id) : null }
    },
    API: {
      async media (id) { calls.anilist++; return apiMedia ? apiMedia(id) : { id, _fromAniList: true } },
      async episodes (media) { calls.aniZip++; return apiEpisodes ? apiEpisodes(media) : [{ episode: 1, _fromAniZip: true }] }
    }
  }
  context.globalThis = context
  runInNewContext(readFileSync(join(here, '../js/catalogue.js'), 'utf8'), context)
  return window.Catalogue
}

before(() => { Catalogue = load() })
beforeEach(() => { Catalogue = load() })

describe('identity', () => {
  it('tells a Yume uuid from an AniList id', () => {
    assert.equal(Catalogue.isYumeId(ROW.id), true)
    assert.equal(Catalogue.isYumeId('154587'), false)
    assert.equal(Catalogue.isYumeId(154587), false)
    assert.equal(Catalogue.isYumeId(''), false)
  })
})

describe('mapping a catalogue row to the AniList shape', () => {
  it('maps every field the UI reads', () => {
    const media = Catalogue.toMedia(ROW)
    assert.equal(media.title.userPreferred, 'Sousou no Frieren')
    assert.equal(media.title.english, 'Frieren: Beyond Journey’s End')
    assert.equal(media.title.native, '葬送のフリーレン')
    assert.deepEqual(plain(media.synonyms), ['Frieren at the Funeral'])
    assert.equal(media.episodes, 28)
    assert.equal(media.duration, 24)
    assert.equal(media.averageScore, 91)
    assert.equal(media.description, 'An elf mage outlives her party.')
    assert.deepEqual(plain(media.genres), ['Adventure', 'Drama', 'Fantasy'])
    assert.equal(media.coverImage.large, 'https://cdn.example/cover.jpg')
    assert.equal(media.coverImage.color, '#3a6ea5')
    assert.equal(media.bannerImage, 'https://cdn.example/banner.jpg')
  })

  it('passes the enums through untranslated', () => {
    // anime_format, anime_status and anime_season were defined with AniList's
    // own values, so a translation table here would be a bug waiting to drift.
    const media = Catalogue.toMedia(ROW)
    assert.equal(media.format, 'TV')
    assert.equal(media.status, 'FINISHED')
    assert.equal(media.season, 'FALL')
    assert.equal(media.seasonYear, 2023)
  })

  it('turns a date into AniList’s fuzzy date', () => {
    const media = Catalogue.toMedia(ROW)
    assert.deepEqual(plain(media.startDate), { year: 2023, month: 9, day: 29 })
    assert.deepEqual(plain(media.endDate), { year: 2024, month: 3, day: 22 })
  })

  it('gives a missing date the shape callers expect rather than null', () => {
    const media = Catalogue.toMedia({ ...ROW, start_date: null, end_date: null })
    assert.deepEqual(plain(media.startDate), { year: null, month: null, day: null })
  })

  it('keeps the provider ids separate from the navigation id', () => {
    const media = Catalogue.toMedia(ROW)
    assert.equal(media.id, 154587, 'navigates by the AniList id when there is one')
    assert.equal(media.yumeId, ROW.id)
    assert.equal(media.anilistId, 154587)
    assert.equal(media.idMal, 52991)
  })

  it('falls back to the catalogue uuid when there is no mapping', () => {
    // The library, favourites, resume points and the #/watch route all key off
    // media.id. A null there breaks every one of them silently, so a
    // catalogue-only title keys off its own id instead.
    const media = Catalogue.toMedia({ ...ROW, mappings: {} })
    assert.equal(media.id, ROW.id)
    assert.equal(media.anilistId, null, 'and the provider link is omitted, not faked')
    assert.equal(media.idMal, null)
  })

  it('lists only studios among the companies', () => {
    const media = Catalogue.toMedia(ROW)
    assert.deepEqual(plain(media.studios.nodes.map(n => n.name)), ['Madhouse'])
  })

  it('survives a sparse row without throwing', () => {
    // A stub row created by /v1/anime/resolve has almost nothing filled in.
    const media = Catalogue.toMedia({ id: ROW.id, canonical_title: 'Stub' })
    assert.equal(media.title.userPreferred, 'Stub')
    assert.deepEqual(plain(media.genres), [])
    assert.deepEqual(plain(media.synonyms), [])
    assert.deepEqual(plain(media.studios.nodes), [])
    assert.equal(media.coverImage.large, '')
    assert.equal(media.id, ROW.id)
  })

  it('returns null for no row at all', () => {
    assert.equal(Catalogue.toMedia(null), null)
    assert.equal(Catalogue.toMedia(undefined), null)
  })
})

describe('precedence', () => {
  it('answers from the catalogue without calling AniList', async () => {
    Catalogue = load({ catalogueMedia: () => ROW })
    const media = await Catalogue.media(154587)
    assert.equal(media._fromCatalogue, true)
    assert.equal(calls.anilist, 0, 'AniList must not be consulted when we have the record')
  })

  it('falls back to AniList when the catalogue misses', async () => {
    Catalogue = load({ catalogueMedia: () => null })
    const media = await Catalogue.media(154587)
    assert.equal(media._fromAniList, true)
    assert.equal(calls.anilist, 1)
  })

  it('falls back when the backend is unreachable, not just when it is empty', async () => {
    // YumeAPI returns null for both; the client has to stay usable standalone.
    Catalogue = load({ catalogueMedia: () => null })
    assert.ok(await Catalogue.media(154587))
  })

  it('does not ask AniList about a Yume uuid', async () => {
    // AniList has never heard of our identifiers; asking would be a guaranteed
    // miss and a wasted round trip.
    Catalogue = load({ catalogueMedia: () => null })
    assert.equal(await Catalogue.media(ROW.id), null)
    assert.equal(calls.anilist, 0)
  })

  it('attaches relations when the catalogue has them', async () => {
    Catalogue = load({
      catalogueMedia: () => ROW,
      catalogueRelations: () => [
        { relation: 'SEQUEL', id: '99999999-2222-4333-8444-555555555555', anilist_id: 999, canonical_title: 'Season 2', status: 'RELEASING', format: 'TV', cover_key: 'https://cdn.example/s2.jpg' },
        { relation: 'SIDE_STORY', id: '88888888-2222-4333-8444-555555555555', anilist_id: null, canonical_title: 'Catalogue only', status: 'FINISHED', format: 'OVA', cover_key: null }
      ]
    })
    const media = await Catalogue.media(154587)
    assert.equal(media.relations.edges.length, 2)
    assert.equal(media.relations.edges[0].relationType, 'SEQUEL')
    assert.equal(media.relations.edges[0].node.id, 999)
    // The unmapped relation still gets a usable link target.
    assert.equal(media.relations.edges[1].node.id, '88888888-2222-4333-8444-555555555555')
    assert.equal(media.relations.edges[1].node.anilistId, null)
  })

  it('keeps a stable relations shape when there are none', async () => {
    Catalogue = load({ catalogueMedia: () => ROW, catalogueRelations: () => [] })
    const media = await Catalogue.media(154587)
    assert.deepEqual(plain(media.relations), { edges: [] })
  })
})

describe('episodes', () => {
  const EPISODE_ROWS = [
    { number: 1, title: 'The Journey’s End', synopsis: 'A party returns.', thumbnail_key: 'https://cdn.example/1.jpg', air_date: '2023-09-29', duration: 24, is_filler: false },
    { number: 2, title: 'It Didn’t Have to Be Magic', synopsis: null, thumbnail_key: null, air_date: '2023-09-29', duration: 24, is_filler: true }
  ]

  it('serves catalogue episodes without touching ani.zip', async () => {
    Catalogue = load({ catalogueEpisodes: () => EPISODE_ROWS })
    const list = await Catalogue.episodes({ yumeId: ROW.id, id: 154587 })
    assert.equal(list.length, 2)
    assert.equal(list[0].episode, 1)
    assert.equal(list[0].title, 'The Journey’s End')
    assert.equal(list[0].image, 'https://cdn.example/1.jpg')
    assert.equal(list[1].filler, true)
    assert.equal(calls.aniZip, 0)
  })

  it('falls back when the catalogue holds no episode rows', async () => {
    // An empty episodes table for a series that has aired is a gap in our
    // import, not a statement that the series has no episodes. Returning []
    // would show the user an empty tab instead of the truth.
    Catalogue = load({ catalogueEpisodes: () => [] })
    const list = await Catalogue.episodes({ yumeId: ROW.id, id: 154587 })
    assert.equal(list[0]._fromAniZip, true)
  })

  it('returns an empty list rather than throwing with nothing to ask', async () => {
    Catalogue = load({ catalogueEpisodes: () => [] })
    assert.deepEqual(plain(await Catalogue.episodes({ yumeId: ROW.id, id: null })), [])
    assert.equal(calls.aniZip, 0)
  })
})
