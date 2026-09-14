// Where the refresh token lives.
//
// It used to be handed back in the response body and kept in localStorage: a
// thirty-day credential readable by any script on the origin. It is an
// HttpOnly cookie now, which does not stop an injected script *using* the
// session while the page is open — the browser attaches the cookie to the
// page's own fetches — but does stop it copying the token out and keeping the
// account for a month from somewhere else. Losing persistence is most of the
// damage. YUME-AUDIT-0006.
//
// These read the source rather than driving a server, because the flow needs a
// database and this suite has none. What they pin is the set of decisions that
// are easy to undo by accident: the flags on the cookie, that logout clears
// it, that the client no longer writes the token down, and that a client
// loaded before the change still works against this server.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const authRoutes = readFileSync(new URL('../src/modules/auth/routes.ts', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')
const client = readFileSync(
  fileURLToPath(new URL('../../web/src/shared/api/yume.js', import.meta.url)), 'utf8')

describe('the refresh cookie', () => {
  it('is HttpOnly', () => {
    assert.match(authRoutes, /httpOnly:\s*true/,
      'without this the token is readable by script, which is the whole point')
  })

  it('is Secure outside development', () => {
    assert.match(authRoutes, /secure:\s*config\.isProd/)
  })

  it('is SameSite=Strict', () => {
    assert.match(authRoutes, /sameSite:\s*'strict'/)
  })

  it('is scoped to the routes that read it', () => {
    assert.match(authRoutes, /path:\s*'\/v1\/auth'/,
      'a cookie on / rides along with every catalogue image request')
  })

  it('is cleared when the session ends', () => {
    // Signing out has to take the credential away, not only the row it points
    // at. Three places: logout, logout-all, and a refresh that was refused.
    const cleared = authRoutes.match(/reply\.clearCookie\(REFRESH_COOKIE/g) ?? []
    assert.ok(cleared.length >= 3, `only ${cleared.length} clearCookie calls; expected logout, logout-all and the refused refresh`)
  })

  it('is served by a registered cookie plugin', () => {
    assert.match(app, /await app\.register\(cookie\)/)
  })
})

describe('the refresh route', () => {
  it('reads the cookie first and the body second', () => {
    assert.match(authRoutes, /request\.cookies\[REFRESH_COOKIE\]\s*\?\?\s*fromBody/,
      'the cookie is the credential; the body is the compatibility path')
  })

  it('no longer requires a body', () => {
    // A client loaded after the change sends nothing at all. Requiring
    // `refreshToken` would refuse exactly the callers this was built for.
    const route = authRoutes.slice(authRoutes.indexOf("fastify.post('/refresh'"))
    const schema = route.slice(0, route.indexOf('async (request, reply)'))
    assert.ok(!/required:\s*\['refreshToken'\]/.test(schema),
      'refreshToken is still required, so a cookie-only client gets a 400')
  })

  it('still accepts a body, so a deploy does not sign everybody out', () => {
    assert.match(authRoutes, /const fromBody = \(request\.body as/,
      'a client loaded before this change sends the token in the body and must keep working')
  })
})

describe('the client', () => {
  it('does not write the refresh token down', () => {
    const save = client.slice(client.indexOf('_saveTokens (tokens)'))
    const body = save.slice(0, save.indexOf('user ()'))
    assert.match(body, /const \{ refreshToken, \.\.\.keep \} = tokens/,
      'the token has to be dropped on the way in, including from an older server that still sends it')
    assert.match(body, /JSON\.stringify\(keep\)/)
    assert.ok(!/setItem\('yume-auth', JSON\.stringify\(tokens\)\)/.test(body),
      'the whole token object is being stored again')
  })

  it('refreshes without sending a token', () => {
    const refresh = client.slice(client.indexOf('async _refresh ()'))
    const body = refresh.slice(0, refresh.indexOf('async available ()'))
    assert.ok(!/refreshToken/.test(body), 'the client cannot read the cookie and must not try')
    assert.match(body, /credentials: 'include'/)
  })

  it('sends credentials on every call that establishes or ends a session', () => {
    for (const path of ['/v1/auth/register', '/v1/auth/login', '/v1/auth/logout']) {
      const call = client.slice(client.indexOf(path))
      assert.match(call.slice(0, 400), /credentials: 'include'/, `${path} does not carry the cookie`)
    }
  })

  it('still retries a 401 once for a signed-in caller', () => {
    // This used to key on holding a refresh token, which the client no longer
    // has. Keyed on the access token instead — otherwise an expired session
    // stops recovering and every signed-in reader gets a 401 it never retries.
    assert.match(client, /res\.status === 401 && retry && tokens\?\.accessToken/)
  })
})
