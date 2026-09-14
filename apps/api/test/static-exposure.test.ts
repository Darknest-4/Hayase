// What can an anonymous browser download from this origin?
//
// `web/` is the document root and it holds more than the browser runs:
// apps/web/test/ lives inside it, so nineteen test files — including the
// end-to-end ones, which spell out the admin permission model and the
// security invariants they check — were downloadable from the deployment.
// `COPY web/` put them in the image too, so this was true in production and
// not only in a dev run.
//
// Two things this file is careful about:
//
//   * A refused path must not answer 403. The SPA fallback returns index.html
//     for every address with no file behind it, so a probe cannot tell a
//     directory that exists and is refused from one that was never there. The
//     assertions therefore compare *bodies*, not status codes — a 200 that is
//     index.html is a refusal.
//
//   * This is not an attempt to hide the client's own code, and no test here
//     pretends otherwise. The browser has to download and execute js/ and
//     css/ for the site to work; anything served from them is readable by
//     anybody who loads the page, and no server configuration changes that.
//     What is testable is that nothing *else* is served.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'

process.env.JWT_SECRET ??= 'static-exposure-secret-long-enough-0123456789'

describe('what the web root serves', () => {
  let app: FastifyInstance
  let spa = ''

  before(async () => {
    const { buildApp } = await import('../src/app.ts')
    app = await buildApp()
    await app.ready()
    const index = await app.inject({ url: '/index.html' })
    assert.equal(index.statusCode, 200, 'precondition: the client is being served at all')
    spa = index.body
    assert.ok(spa.length > 500, 'precondition: index.html has content')
  })

  after(async () => { await app?.close() })

  /** Did this path hand back a file of its own, rather than the SPA shell? */
  const served = async (url: string): Promise<boolean> => {
    const res = await app.inject({ url })
    return res.statusCode === 200 && res.body !== spa
  }

  test('serves the client the page actually loads', async () => {
    // The allowlist has to be an allowlist of the right things, or the rest of
    // this file passes by serving nothing at all.
    //
    // index.html is checked separately: it *is* the fallback body, so
    // "returned something other than the shell" cannot be the question for it.
    assert.equal((await app.inject({ url: '/' })).body, spa, 'the root does not serve the page')
    for (const url of [
      '/src/app/router.js', '/src/shared/api/yume.js', '/src/shared/i18n/hu.js',
      '/src/shared/i18n/copy.js', '/css/style.css'
    ]) {
      assert.ok(await served(url), `${url} is not being served`)
    }
  })

  test('does not serve the test suite', async () => {
    for (const url of [
      '/test/api-surface.test.mjs',
      '/test/route-gate.test.mjs',
      '/test/css-order.test.mjs',
      '/test/e2e/admin-layout.test.mjs',
      '/test/e2e/responsive.test.mjs',
      '/test/e2e/smoke.test.mjs'
    ]) {
      assert.equal(await served(url), false, `${url} is downloadable`)
    }
  })

  test('a refused path is indistinguishable from one that never existed', async () => {
    // Both answer with the page. A 403 on /test/ would confirm the directory
    // is there, which is the one thing refusing it was meant to avoid.
    const refused = await app.inject({ url: '/test/e2e/admin-layout.test.mjs' })
    const absent = await app.inject({ url: '/there-is-nothing-here-at-all' })
    assert.equal(refused.statusCode, absent.statusCode)
    assert.equal(refused.body, absent.body)
  })

  test('does not list directories', async () => {
    // Never a listing. What comes back instead now depends on whether the path
    // is inside the client's own asset tree:
    //
    //   /src/ /css/ /assets/   a file request for something that is not there,
    //                          so 404 — see the SPA fallback in app.ts and
    //                          YUME-AUDIT-0003. Answering the page with a 200
    //                          is what let a missing module look healthy while
    //                          the browser refused to execute it.
    //   /test/                 not part of the client at all; it falls through
    //                          to the fallback like any other unknown path and
    //                          gets the application.
    for (const url of ['/src/', '/css/', '/assets/']) {
      const res = await app.inject({ url })
      assert.equal(res.statusCode, 404, `${url} should be a miss, not the page`)
      assert.ok(!res.body.includes('<!doctype html'), `${url} returned the page`)
      assert.ok(!/index\.html|\.js<|<a href/i.test(res.body), `${url} looks like a listing`)
    }
    const outside = await app.inject({ url: '/test/' })
    assert.equal(outside.body, spa, '/test/ should fall through to the application')
  })

  test('a missing client module is a 404, not the page with a 200', async () => {
    // The check that was missing when the site went blank. A module that stops
    // resolving was served as index.html with a 200; the browser refuses to
    // run HTML as a module, so the page died while every check an operator
    // makes said the site was healthy. YUME-AUDIT-0003.
    for (const url of ['/src/app/does-not-exist.js', '/css/gone.css', '/assets/missing.svg']) {
      const res = await app.inject({ url })
      assert.equal(res.statusCode, 404, `${url} should not be served as the page`)
      assert.ok(!String(res.headers['content-type'] ?? '').includes('text/html'),
        `${url} came back as HTML, which is what the browser cannot execute`)
    }
  })

  test('a route the client owns still gets the application', async () => {
    // The other half: the fallback exists so deep links work, and narrowing it
    // must not take that away.
    // Not /anime/:id — that one has its own route, answers 404 with the page
    // on a miss by design (see seo/routes.ts), and reads the database, which
    // this suite does not have.
    for (const url of ['/admin/audit', '/whatever/somebody/typed', '/list']) {
      const res = await app.inject({ url })
      assert.equal(res.statusCode, 200, `${url} should still open the application`)
      assert.ok(res.body.includes('<!doctype html'), `${url} did not return the page`)
    }
  })

  test('does not escape the web root', async () => {
    for (const url of [
      '/../apps/api/src/config.ts',
      '/../.env',
      '/..%2fserver%2fsrc%2fconfig.ts',
      '/%2e%2e/%2e%2e/.env',
      '/src/../../apps/api/src/config.ts',
      '/src/%2e%2e/%2e%2e/apps/api/src/config.ts'
    ]) {
      assert.equal(await served(url), false, `${url} escaped the document root`)
    }
  })

  test('does not serve dotfiles or repository metadata', async () => {
    for (const url of ['/.env', '/.git/config', '/.git/HEAD', '/.gitignore', '/.dockerignore']) {
      assert.equal(await served(url), false, `${url} is downloadable`)
    }
  })

  test('does not serve anything a future directory under web/ might add', async () => {
    // The point of an allowlist rather than an exclude list: a path nobody has
    // thought about is refused by default. If this ever needs to change, it
    // changes in CLIENT_DIRS with the reason written down.
    for (const url of ['/scripts/deploy.sh', '/backup/dump.sql', '/notes/todo.md', '/private/keys.json']) {
      assert.equal(await served(url), false, `${url} would be served`)
    }
  })
})
