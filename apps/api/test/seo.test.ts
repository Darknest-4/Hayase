// The SEO layer, and mostly the escaping in it.
//
// Everything this feature emits is built from text an importer wrote: titles
// and synopses arrive from AniList and MAL, and they are interpolated into
// three different contexts — HTML text, a double-quoted attribute, and the
// body of a <script type="application/ld+json"> block. Each has its own way of
// being escaped wrongly, and the consequence of getting any of them wrong is
// the same: a catalogue row becomes script execution on every visitor's
// browser. So the first half of this file is a set of injection attempts.
//
// The second half is about what must NOT be published: hidden and adult
// entries, and — when the operator has made this a private instance — the
// catalogue at all. A sitemap is the most efficient possible way to hand a
// crawler a list of things it was not supposed to see.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, mock, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'seo-secret-long-enough-0123456789'

/** A title that ends the <script> block, the attribute, and the tag. */
const HOSTILE = '</script><img src=x onerror=alert(1)>"\'&<b>'

describe('SEO', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  const animeIds: string[] = []

  /** Insert a catalogue row and return its id. */
  const makeAnime = async (over: Record<string, unknown> = {}): Promise<string> => {
    const row = {
      canonical_title: 'SEO ' + randomUUID().slice(0, 8),
      format: 'TV',
      status: 'FINISHED',
      visibility: 'public',
      is_adult: false,
      synopsis: 'A perfectly ordinary synopsis.',
      episode_count: 12,
      popularity: 1,
      ...over
    }
    const { rows } = await pool.query(
      `INSERT INTO anime (canonical_title, format, status, visibility, is_adult,
                          synopsis, episode_count, popularity)
       VALUES ($1, $2::anime_format, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [row.canonical_title, row.format, row.status, row.visibility, row.is_adult,
        row.synopsis, row.episode_count, row.popularity])
    const id = String(rows[0].id)
    animeIds.push(id)
    return id
  }

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([
      import('../src/app.ts'),
      import('../src/infrastructure/database/index.ts')
    ])
    pool = db.pool
    app = await buildApp()
    await app.ready()
  })

  after(async () => {
    try {
      if (animeIds.length) await pool.query('DELETE FROM anime WHERE id = ANY($1::uuid[])', [animeIds])
      await app?.close()
    } finally {
      await pool?.end()
    }
  })

  // ------------------------------------------------------------ the escaping

  test('a hostile title cannot break out of the head', async () => {
    const id = await makeAnime({ canonical_title: HOSTILE, synopsis: HOSTILE })
    const res = await app.inject({ url: `/anime/${id}` })
    assert.equal(res.statusCode, 200)
    const body = res.body

    // No raw tag anywhere. The hostile text still contains the characters
    // "onerror=alert(1)" once it is inside the JSON-LD, which is inert — a
    // JSON string with no `<` in it cannot start an element — so the assertion
    // is about the angle brackets, which are what actually opens a tag.
    assert.ok(!body.includes('<img'), 'an image tag reached the document')
    assert.ok(!/<\/script>\s*<img/.test(body), 'the JSON-LD block was closed early')

    // Exactly one JSON-LD block, and it round-trips: the title came back as a
    // string rather than having become part of the document.
    const blocks = body.match(/<script type="application\/ld\+json">/g) ?? []
    assert.equal(blocks.length, 1, `${blocks.length} JSON-LD blocks`)
    const json = body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1]
    assert.ok(json)
    assert.equal(JSON.parse(json).name, HOSTILE, 'the title did not survive as a string')

    // In the attribute contexts it is escaped rather than dropped — a route
    // that simply threw the title away would pass every assertion above.
    const ogTitle = body.match(/<meta property="og:title" content="([^"]*)"/)?.[1]
    assert.ok(ogTitle, 'og:title is missing, or its quoting was broken')
    assert.ok(ogTitle.includes('&lt;/script&gt;'), ogTitle)
    assert.ok(ogTitle.includes('&quot;') && ogTitle.includes('&amp;'), ogTitle)
  })

  test('the JSON-LD block stays parseable with a hostile synopsis in it', async () => {
    const id = await makeAnime({ canonical_title: 'Parse me', synopsis: HOSTILE })
    const body = (await app.inject({ url: `/anime/${id}` })).body
    const match = body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)
    assert.ok(match, 'no JSON-LD block was emitted')
    const data = JSON.parse(match[1] as string)
    assert.equal(data['@context'], 'https://schema.org')
    assert.equal(data.name, 'Parse me')
  })

  test('the description is the synopsis, without its markup', async () => {
    const id = await makeAnime({
      synopsis: 'A boy meets a <i>girl</i>.<br><br>Then things happen for a very long time indeed.'
    })
    const body = (await app.inject({ url: `/anime/${id}` })).body
    const description = body.match(/<meta name="description" content="([^"]*)"/)?.[1]
    assert.ok(description)
    assert.ok(description.startsWith('A boy meets a girl.'), description)
    assert.ok(!description.includes('<i>'), 'markup survived into the description')
    assert.ok(description.length <= 160, `description is ${description.length} characters`)
  })

  // ------------------------------------------------------------ what it says

  test('names the anime rather than the site', async () => {
    const id = await makeAnime({ canonical_title: 'Kimi no Na wa' })
    const body = (await app.inject({ url: `/anime/${id}` })).body
    assert.match(body, /<title>Kimi no Na wa — Yume<\/title>/)
    assert.match(body, /<meta property="og:title" content="Kimi no Na wa — Yume"/)
    assert.match(body, new RegExp(`<link rel="canonical" href="[^"]*/anime/${id}"`))
    assert.match(body, /<meta name="twitter:card"/)
  })

  test('the page is still the app, not a stub', async () => {
    // The whole point is that a browser landing on this URL gets Yume. A
    // server-rendered summary page that the client then has to replace would
    // be a second frontend to keep in step with the first.
    const id = await makeAnime()
    const body = (await app.inject({ url: `/anime/${id}` })).body
    assert.match(body, /<script src="\/js\/app\.js">/)
    assert.match(body, /id="page"/)
  })

  test('publishes no rating it does not have', async () => {
    // An aggregateRating with no ratings behind it is a rich-result penalty
    // waiting to happen, and it is a lie about the catalogue besides.
    const id = await makeAnime()
    await pool.query('UPDATE anime SET average_score = NULL, ratings_count = 0 WHERE id = $1', [id])
    const body = (await app.inject({ url: `/anime/${id}` })).body
    assert.ok(!body.includes('aggregateRating'), 'a rating was invented')
  })

  test('an unknown id answers 404, with the app and no index', async () => {
    const res = await app.inject({ url: `/anime/${randomUUID()}` })
    assert.equal(res.statusCode, 404)
    assert.match(res.body, /id="page"/, 'a 404 should still render the app')
    assert.equal(res.headers['x-robots-tag'], 'noindex')
    assert.match(res.body, /<meta name="robots" content="noindex/)
  })

  test('a malformed id is a miss, not a database error', async () => {
    const res = await app.inject({ url: '/anime/not-an-id' })
    assert.equal(res.statusCode, 404)
    assert.match(res.body, /id="page"/)
  })

  // ------------------------------------------------- what it refuses to index

  test('a hidden anime is not indexable and not in the sitemap', async () => {
    const id = await makeAnime({ visibility: 'hidden' })
    const res = await app.inject({ url: `/anime/${id}` })
    assert.equal(res.statusCode, 404, 'a hidden entry answered as if it existed')
    const sitemap = await app.inject({ url: '/sitemap.xml' })
    assert.ok(!sitemap.body.includes(id), 'a hidden entry is listed in the sitemap')
  })

  test('an unlisted anime is reachable by link but marked noindex', async () => {
    // That is what unlisted means: a direct link works, an index does not get it.
    const id = await makeAnime({ visibility: 'unlisted' })
    const res = await app.inject({ url: `/anime/${id}` })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['x-robots-tag'], 'noindex')
    const sitemap = await app.inject({ url: '/sitemap.xml' })
    assert.ok(!sitemap.body.includes(id))
  })

  test('an adult anime is not offered to an index', async () => {
    const id = await makeAnime({ is_adult: true })
    const res = await app.inject({ url: `/anime/${id}` })
    assert.equal(res.headers['x-robots-tag'], 'noindex')
    const sitemap = await app.inject({ url: '/sitemap.xml' })
    assert.ok(!sitemap.body.includes(id), 'an adult entry is listed in the sitemap')
  })

  test('the sitemap lists a public entry, and is well formed', async () => {
    const id = await makeAnime({ popularity: 2_000_000 })
    const res = await app.inject({ url: '/sitemap.xml' })
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['content-type']), /xml/)
    assert.match(res.body, /^<\?xml version="1\.0" encoding="UTF-8"\?>/)
    assert.match(res.body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/)
    assert.ok(res.body.trimEnd().endsWith('</urlset>'))
    assert.ok(res.body.includes(`/anime/${id}</loc>`), 'a public entry is missing from the sitemap')
    // Every <loc> is absolute, or a crawler cannot resolve it.
    for (const loc of res.body.match(/<loc>([^<]*)<\/loc>/g) ?? []) {
      assert.match(loc, /<loc>https?:\/\//, loc)
    }
  })

  // ------------------------------------------------------------- robots.txt

  test('robots.txt keeps the operator surface out of the index', async () => {
    const res = await app.inject({ url: '/robots.txt' })
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['content-type']), /text\/plain/)
    for (const path of ['/v1/', '/graphql', '/admin', '/settings', '/dashboard']) {
      assert.ok(res.body.includes(`Disallow: ${path}`), `${path} is crawlable`)
    }
    assert.match(res.body, /^Sitemap: https?:\/\/\S+\/sitemap\.xml$/m)
  })

  test('the admin surface answers with a noindex header however it is reached', async () => {
    // /admin is not an API path — the SPA fallback serves it with a 200, so
    // without the header it is ordinary indexable HTML.
    for (const url of ['/admin', '/settings', '/v1/config']) {
      const res = await app.inject({ url })
      assert.equal(res.headers['x-robots-tag'], 'noindex', `${url} is indexable`)
    }
    // And an ordinary page is not marked, or the whole site would be excluded.
    const home = await app.inject({ url: '/' })
    assert.equal(home.headers['x-robots-tag'], undefined)
  })

  test('a private instance publishes nothing at all', async () => {
    // require_login is a shared row and the suite runs in parallel, so the
    // reader is replaced rather than the setting written. See lib/site-settings.ts.
    const { settings } = await import('../src/modules/settings/site-settings.ts')
    mock.method(settings, 'requiresLogin', async () => true)
    try {
      const robots = await app.inject({ url: '/robots.txt' })
      assert.match(robots.body, /User-agent: \*\s*\nDisallow: \/\s*$/)
      assert.ok(!robots.body.includes('Sitemap:'), 'a private instance advertised a sitemap')

      const sitemap = await app.inject({ url: '/sitemap.xml' })
      assert.equal(sitemap.statusCode, 404)

      const id = await makeAnime({ canonical_title: 'Secret Show' })
      const page = await app.inject({ url: `/anime/${id}` })
      assert.ok(!page.body.includes('Secret Show'), 'a private instance leaked a title in a link preview')
      assert.equal(page.headers['x-robots-tag'], 'noindex')
    } finally {
      mock.restoreAll()
    }
  })

  // --------------------------------------------------------- the origin used

  test('does not build a canonical out of whatever Host it was handed', async () => {
    // Canonical poisoning: a crawler following a link with a forged Host would
    // otherwise be told the real page lives on the attacker's domain.
    const res = await app.inject({
      url: '/robots.txt',
      headers: { host: 'evil.example.com/../../x y' }
    })
    assert.ok(!res.body.includes('evil.example.com'), 'a forged Host reached the sitemap URL')
  })

  test('PUBLIC_URL wins over the Host header', async () => {
    const previous = process.env.PUBLIC_URL
    process.env.PUBLIC_URL = 'https://yume.example/'
    try {
      const res = await app.inject({ url: '/robots.txt', headers: { host: 'attacker.example' } })
      assert.ok(res.body.includes('Sitemap: https://yume.example/sitemap.xml'), res.body)
      assert.ok(!res.body.includes('attacker.example'))
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_URL
      else process.env.PUBLIC_URL = previous
    }
  })
})
