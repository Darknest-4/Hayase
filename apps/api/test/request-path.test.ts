// The path every gate decides on must be the path the router matched.
//
// The private-instance gate, the read-only switch, the maintenance scopes and
// the edge layer all tested `request.url` against a prefix, while the router
// matches a decoded path. `/%761/anime` was served by the `/v1/anime` route and
// did not start with `/v1` — in production it returned the catalogue of a
// private instance to anybody. These tests hold `routingPath` to the router
// itself, so the two cannot drift apart again.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import Fastify from 'fastify'

import { isApiPath, routingPath } from '../src/infrastructure/http/request-path.ts'

describe('routingPath', () => {
  const cases: Array<[string, string]> = [
    ['/v1/anime', '/v1/anime'],
    ['/v1/anime?limit=1', '/v1/anime'],
    ['/%761/anime', '/v1/anime'],
    ['/%76%31/anime?x=%2F', '/v1/anime'],
    ['/graphq%6c', '/graphql'],
    ['/v1%2Fanime', '/v1%2Fanime'],            // an encoded slash stays encoded, as in the router
    ['/%2576', '/%2576'],                       // an encoded percent sign is not decoded twice
    ['http://example.com/v1/anime?x', '/v1/anime'], // absolute-form request target
    ['/v1/bad%zz', '/v1/bad%zz'],               // malformed: left as it is (the router answers 400)
    ['/v1/anime#frag', '/v1/anime']
  ]
  for (const [target, expected] of cases) {
    it(`${target} → ${expected}`, () => {
      assert.equal(routingPath(target), expected)
    })
  }

  it('recognises the API surface on the decoded path only', () => {
    assert.equal(isApiPath('/v1/anime'), true)
    assert.equal(isApiPath('/graphql'), true)
    assert.equal(isApiPath('/v1'), true)
    assert.equal(isApiPath('/v10/anime'), false)
    assert.equal(isApiPath('/graphiql'), false)
    assert.equal(isApiPath('/anime/x'), false)
  })
})

describe('routingPath agrees with the router', () => {
  it('whatever reaches a /v1 route is recognised as /v1', async () => {
    const app = Fastify()
    let seen = ''
    app.get('/v1/anime', async request => { seen = routingPath(request.url); return { ok: true } })
    app.post('/graphql', async request => { seen = routingPath(request.url); return { ok: true } })
    await app.ready()

    const targets = [
      '/v1/anime', '/%761/anime', '/%76%31/%61nime', '/v1/%61nime?x=1',
      '/%76%31/%61%6e%69%6d%65'
    ]
    for (const url of targets) {
      seen = ''
      const res = await app.inject({ method: 'GET', url })
      assert.equal(res.statusCode, 200, `${url} should reach the route`)
      assert.equal(seen, '/v1/anime', `${url} was routed to /v1/anime but seen as ${seen}`)
      assert.equal(isApiPath(seen), true)
    }

    seen = ''
    const graphql = await app.inject({ method: 'POST', url: '/graphq%6c', payload: {} })
    assert.equal(graphql.statusCode, 200)
    assert.equal(seen, '/graphql')
    await app.close()
  })
})
