// Who gets the token attached, and when.
//
// `auth: true` used to be the only thing that put an Authorization header on a
// request, so every read — the catalogue, the community feed, the forum, the
// chat rooms, the development log — went out anonymously. On a public instance
// that is invisible. On a private one the server refuses everything under /v1
// without a live token, so a signed-in viewer holding a perfectly good token
// was told to sign in, on page after page, with their own account name at the
// top of the screen.
//
// The rule now: send the token whenever there is one. `auth` keeps its other
// job, which is to fail early with a sentence a person can act on rather than
// send a request that cannot succeed.

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import { install } from './support/browser.mjs'

install()
const { YumeAPI } = await import('../src/shared/api/yume.js')

const TOKENS = { accessToken: 'access-1', refreshToken: 'refresh-1' }

/** Record what fetch was called with, and answer with whatever the test wants. */
function stubFetch (responses) {
  const calls = []
  const queue = [...responses]
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: options?.headers ?? {}, method: options?.method ?? 'GET' })
    const next = queue.shift() ?? { status: 200, body: {} }
    return {
      ok: next.status < 400,
      status: next.status,
      json: async () => next.body ?? {}
    }
  }
  return calls
}

const signedIn = () => { globalThis.localStorage.setItem('yume-auth', JSON.stringify(TOKENS)) }
const signedOut = () => { globalThis.localStorage.removeItem('yume-auth') }

describe('the Authorization header', () => {
  beforeEach(() => { globalThis.localStorage.clear() })

  it('goes on a plain read when the viewer is signed in', async () => {
    signedIn()
    const calls = stubFetch([{ status: 200, body: { data: [] } }])
    await YumeAPI._request('/v1/changelog')
    assert.equal(calls[0].headers.Authorization, 'Bearer access-1')
  })

  it('is absent when there is no token, and the read still goes out', async () => {
    signedOut()
    const calls = stubFetch([{ status: 200, body: { data: [] } }])
    await YumeAPI._request('/v1/changelog')
    assert.equal(calls.length, 1, 'a signed-out read must still be attempted')
    assert.equal(calls[0].headers.Authorization, undefined)
  })

  it('still refuses to send an auth-only call without a token', async () => {
    signedOut()
    const calls = stubFetch([])
    await assert.rejects(() => YumeAPI._request('/v1/me/library', { auth: true }), /Sign in/)
    assert.equal(calls.length, 0, 'nothing should have been sent')
  })

  it('refreshes and retries a read whose token had expired', async () => {
    // Keyed on having sent a token rather than on `auth`, or a stale token
    // would turn a public read into a 401 nothing tried to recover from.
    signedIn()
    const calls = stubFetch([
      { status: 401, body: {} },                                              // the read
      { status: 200, body: { accessToken: 'access-2', refreshToken: 'r2' } }, // the refresh
      { status: 200, body: { data: [1] } }                                    // the retry
    ])
    const out = await YumeAPI._request('/v1/forum')
    assert.deepEqual(out, { data: [1] })
    assert.equal(calls.length, 3)
    assert.match(calls[1].url, /\/v1\/auth\/refresh$/)
    assert.equal(calls[2].headers.Authorization, 'Bearer access-2', 'the retry must use the fresh token')
  })

  it('falls back to an anonymous read when the refresh is rejected', async () => {
    // A public instance answers a signed-out read perfectly well, so a dead
    // session must not turn browsing into an error page.
    signedIn()
    const calls = stubFetch([
      { status: 401, body: {} },              // the read
      { status: 401, body: {} },              // the refresh, rejected
      { status: 200, body: { data: [2] } }    // the retry, now anonymous
    ])
    const out = await YumeAPI._request('/v1/forum')
    assert.deepEqual(out, { data: [2] })
    assert.equal(calls[2].headers.Authorization, undefined, 'the retry should carry no dead token')
  })

  it('does not retry for ever', async () => {
    signedIn()
    const calls = stubFetch([{ status: 401, body: {} }, { status: 401, body: {} }, { status: 401, body: {} }, { status: 401, body: {} }])
    await assert.rejects(() => YumeAPI._request('/v1/forum'))
    assert.ok(calls.length <= 3, `gave up after ${calls.length} requests`)
  })
})
