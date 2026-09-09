// Which id does the client hold, and which route may be asked about it?
//
// Two id spaces meet in this application: AniList's numbers and our own uuids.
// `Catalogue.toCard` hands out whichever one it has — `anilist_id ?? id` — so
// a title we imported without an AniList mapping arrives at the UI wearing a
// uuid in the field everything else treats as an AniList id.
//
// Sending that to `/v1/anime/by-anilist/:id` is a 400, and the `create` path
// then posted the same uuid as `anilistId` and 400'd again. The visible
// consequence was small and permanent: on every catalogue-only title the
// comment section under the detail panel stayed a spinner. Found by clicking
// the trailer button on the home page in a real browser; it is checked here
// because nothing else in the suite could see it.

import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'

import { install } from './support/browser.mjs'

install()
const { YumeAPI } = await import('../src/shared/api/yume.js')

const UUID = '000d445e-485a-4d56-a3aa-9c3546d631ae'

describe('YumeAPI.yumeAnimeId', () => {
  let asked

  beforeEach(() => {
    asked = []
    YumeAPI._resolveCache = {}
    // Any request at all is a failure for the uuid cases, so record and refuse.
    YumeAPI._request = async path => { asked.push(path); throw new Error('unexpected request: ' + path) }
  })

  it('answers from yumeId without asking anything', async () => {
    const id = await YumeAPI.yumeAnimeId({ id: 21, yumeId: UUID })
    assert.equal(id, UUID)
    assert.deepEqual(asked, [])
  })

  it('treats a uuid in the id field as our own id', async () => {
    // This is the shape toCard produces for a title with no AniList mapping.
    const id = await YumeAPI.yumeAnimeId({ id: UUID })
    assert.equal(id, UUID)
    assert.deepEqual(asked, [])
  })

  it('never sends a uuid to the create path either', async () => {
    const id = await YumeAPI.yumeAnimeId({ id: UUID }, { create: true })
    assert.equal(id, UUID)
    assert.deepEqual(asked, [])
  })

  it('refuses an id that is neither, rather than requesting a bad path', async () => {
    assert.equal(await YumeAPI.yumeAnimeId({ id: undefined }), null)
    assert.equal(await YumeAPI.yumeAnimeId({}), null)
    assert.deepEqual(asked, [])
  })

  it('still resolves a real AniList id through the lookup', async () => {
    YumeAPI._request = async path => { asked.push(path); return { id: UUID } }
    assert.equal(await YumeAPI.yumeAnimeId({ id: 21 }), UUID)
    assert.deepEqual(asked, ['/v1/anime/by-anilist/21'])
    // and caches it
    assert.equal(await YumeAPI.yumeAnimeId({ id: 21 }), UUID)
    assert.equal(asked.length, 1)
  })
})
