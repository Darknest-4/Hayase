// Több fül, egy munkamenet: a frissítés nem jelentkeztethet ki senkit.
//
// A hozzáférési token a localStorage-ban van — minden fül ugyanazt látja —, a
// frissítő token pedig HttpOnly süti, amely minden frissítéskor FOROG. Amíg a
// frissítés fülenként futott, több egyszerre betöltődő fül (böngésző-
// újraindítás, visszaállított munkamenet) ugyanazzal a sütivel frissített.
// Valódi böngészőben mérve, négy füllel: hét frissítés, ebből öt
// `refresh_rotated`, és a végén üres localStorage — a felület kijelentkezett,
// miközben a munkamenet élt.
//
// Itt a kiszolgálót egy kis szimuláció játssza: forgatja a sütit, a türelmi
// időn belüli ismétlésre `refresh_rotated`-del felel, és csak az utoljára
// kiadott hozzáférési tokent fogadja el. A „fülek" a kliensmodul külön
// példányai, közös localStorage-dzsal — ahogy egy böngészőben.

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import { install } from './support/browser.mjs'

install()

let tabs = 0
/** Egy új fül: a kliensmodul saját példánya (saját `_refreshing`), közös tárral. */
const openTab = async () => (await import(`../src/shared/api/yume.js?tab=${++tabs}`)).YumeAPI

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })
const later = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A kiszolgáló, ahogy a frissítő végpont viselkedik (auth/routes.ts): az élő
 * süti forog, a türelmi időn belül újra felmutatott régi `refresh_rotated`,
 * minden más 401. A süti a VÁLASZ megérkezésekor cserélődik a böngészőben.
 */
function server ({ jar = 'c0' } = {}) {
  const state = { jar, live: new Set([jar]), rotated: new Set(), access: new Set(), refreshes: [], issued: 0 }
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(String(url)).pathname
    if (path === '/v1/auth/refresh') {
      const cookie = state.jar // a küldéskor tartott süti megy el
      await later(5)
      if (state.live.has(cookie)) {
        state.live.delete(cookie)
        state.rotated.add(cookie)
        const n = ++state.issued
        state.jar = 'c' + n
        state.live.add(state.jar)
        state.access.add('a' + n)
        state.refreshes.push(200)
        return reply(200, { accessToken: 'a' + n, expiresAt: '2099-01-01T00:00:00Z' })
      }
      if (state.rotated.has(cookie)) {
        state.refreshes.push('rotated')
        return reply(401, { status: 401, detail: 'rotated', code: 'refresh_rotated' })
      }
      state.refreshes.push(401)
      return reply(401, { status: 401, detail: 'Invalid refresh token' })
    }
    if (path === '/slow') await later(60)
    const token = options.headers?.Authorization?.replace(/^Bearer /, '')
    return state.access.has(token) ? reply(200, { ok: true }) : reply(401, { status: 401, detail: 'expired' })
  }
  return state
}

/** Web Locks: egy név, egy sor — a böngésző `navigator.locks.request`-je. */
function webLocks () {
  let tail = Promise.resolve()
  return {
    request (name, fn) {
      const run = tail.then(() => fn())
      tail = run.catch(() => {})
      return run
    }
  }
}

const stored = () => JSON.parse(globalThis.localStorage.getItem('yume-auth') ?? 'null')?.accessToken ?? null
const expired = () => globalThis.localStorage.setItem('yume-auth', JSON.stringify({ accessToken: 'a0' }))

describe('refreshing a session shared by several tabs', () => {
  beforeEach(() => {
    globalThis.localStorage.clear()
    delete globalThis.navigator.locks
  })

  it('refreshes once between four tabs that load together, and keeps everyone signed in', async () => {
    globalThis.navigator.locks = webLocks()
    const state = server()
    expired()
    const all = await Promise.all(Array.from({ length: 4 }, openTab))
    const results = await Promise.all(all.flatMap(api => [api._request('/v1/me/a'), api._request('/v1/me/b')]))
    assert.deepEqual(state.refreshes, [200], 'one refresh for the whole browser')
    assert.ok(results.every(r => r?.ok), 'every request, in every tab, went through')
    assert.equal(stored(), 'a1')
  })

  it('without Web Locks, the tab that loses the race does not sign the others out', async () => {
    // A régi út: a kiszolgáló türelmi ideje és egy újrapróbálás. Négy fülnél a
    // második kör is ütközik — az addig az utolsó vesztes a közös tárat
    // ürítette, azt a tokent is, amelyet egy másik fül épp most kapott.
    const state = server()
    expired()
    const all = await Promise.all(Array.from({ length: 4 }, openTab))
    const results = await Promise.all(all.map(api => api._request('/v1/me/library').catch(e => e)))
    assert.ok(state.refreshes.includes('rotated'), 'the race did happen')
    assert.ok(stored(), 'the shared token must survive the race')
    assert.ok(results.every(r => r?.ok), `every tab recovered: ${JSON.stringify(results.map(r => r?.ok ?? r?.message))}`)
  })

  it('does not refresh again for a request that was sent before the token changed', async () => {
    globalThis.navigator.locks = webLocks()
    const state = server()
    expired()
    const api = await openTab()
    // Mindkettő a régi tokennel megy el; a lassú 401-e a frissítés UTÁN ér vissza.
    const [fast, slow] = await Promise.all([api._request('/fast'), api._request('/slow')])
    assert.ok(fast.ok && slow.ok)
    assert.deepEqual(state.refreshes, [200], 'the late 401 must retry with the new token, not rotate again')
  })

  it('still signs out when the server really refuses the session', async () => {
    globalThis.navigator.locks = webLocks()
    const state = server({ jar: 'revoked' })
    state.live.clear()
    expired()
    const api = await openTab()
    await assert.rejects(() => api._request('/v1/me/library'))
    assert.deepEqual(state.refreshes, [401])
    assert.equal(stored(), null, 'a refused refresh leaves nobody signed in')
  })
})
