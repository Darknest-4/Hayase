// A CSP és a beágyazott lejátszó.
//
// EZ EGY MÉRT, ÉLES HIBÁT ŐRIZ, és olyat, ami SEMMILYEN szerveroldali
// mérésben nem látszott. A szolgáltató forrást adott, az ellenőrzés
// átengedte, a lejátszó megépítette a keretet — és a böngésző csendben
// eldobta az egészet:
//
//   Framing 'https://megaplay.buzz/' violates the following Content Security
//   Policy directive: "frame-src https://www.youtube-nocookie.com …"
//
// A nézőnek ebből annyi jött ki, hogy „ezt a részt egyik elérhető forrásból
// sem sikerült lejátszani" — vagyis pontosan úgy nézett ki, mintha nem lenne
// forrás. A CSP a MI fejlécünk: a hiba nálunk volt, nem a szolgáltatónál.
//
// Amíg a beágyazó gazdagépek listája két helyen él, a szétcsúszás ugyanezt a
// néma hibát szüli. Ezért ez a készlet nem egy beírt sztringet mér, hanem azt,
// hogy a KÉT KAPU UGYANAZT MONDJA.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'csp-embed-test-secret-long-enough-0123456789'

let app: Awaited<ReturnType<typeof import('../src/app.ts')['buildApp']>>
let hosts: typeof import('../src/modules/providers/embed-hosts.ts')
let embedUrl: typeof import('../src/modules/providers/upstream-url.ts')

describe('a CSP és a beágyazás', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    hosts = await import('../src/modules/providers/embed-hosts.ts')
    embedUrl = await import('../src/modules/providers/upstream-url.ts')
    const { buildApp } = await import('../src/app.ts')
    app = await buildApp()
    await app.ready()
  })
  after(async () => { await app?.close() })

  const frameSrc = async (): Promise<string> => {
    const res = await app.inject({ method: 'GET', url: '/v1/config' })
    const csp = String(res.headers['content-security-policy'] ?? '')
    return /frame-src ([^;]+)/.exec(csp)?.[1] ?? ''
  }

  /*
   * A `frame-src` PONTOSAN azt tartalmazza, amit az engedélylista mond.
   *
   * NEM elég végigmenni a listán és megnézni, hogy benne van-e: ha a lista
   * üres (ma az, mert nincs beágyazó szolgáltató), az a ciklus NULLA
   * állítást tenne, és a teszt üresjáratban zöld lenne. Ezért a halmazok
   * EGYEZÉSÉT mérjük — így az üres lista is valódi állítás: akkor egyetlen
   * beágyazó gazdagép sem lóghat bent.
   */
  it('a frame-src pontosan az engedélylistát tükrözi', async () => {
    const fs = await frameSrc()
    const vart = hosts.frameSrcEntries()
    for (const bejegyzes of vart) {
      assert.ok(fs.includes(bejegyzes), `hiányzik a frame-src-ből: ${bejegyzes} — ${fs}`)
    }
    // És semmi más beágyazó gazdagép nincs bent. A YouTube és a Turnstile
    // nem beágyazó szolgáltató: azok külön, nevesített engedélyek.
    const ismertek = ['https://www.youtube-nocookie.com', 'https://www.youtube.com',
      'https://challenges.cloudflare.com', ...vart]
    for (const darab of fs.trim().split(/\s+/)) {
      if (darab === 'frame-src') continue
      assert.ok(ismertek.includes(darab),
        `ismeretlen gazdagép a frame-src-ben: ${darab} — a CSP tágabb, mint az engedélylista`)
    }
  })

  /*
   * AZ ALTARTOMÁNY IS. A szerveroldali ellenőrzés elfogadja a
   * `cdn.megaplay.buzz`-t; ha a CSP nem, egy ilyen cím átmenne a kapun, és a
   * böngészőnél bukna el — megint némán.
   */
  it('az altartományok is átmennek a CSP-n, ahogy az ellenőrzésen is', async () => {
    const fs = await frameSrc()
    for (const host of hosts.embedHosts()) {
      assert.ok(fs.includes(`https://*.${host}`), `hiányzik a *.${host}: ${fs}`)
      // és az ellenőrzés tényleg elfogadja az altartományt
      assert.ok(embedUrl.safeUpstreamUrl(`https://cdn.${host}/x`, hosts.embedHosts()),
        `az ellenőrzés elutasítja a cdn.${host}-ot, a CSP viszont engedi`)
    }
  })

  /*
   * A KÉT KAPU EGYEZÉSE — ez a készlet lényege.
   *
   * Amit a szerveroldali ellenőrzés átenged, azt a CSP-nek is engednie kell,
   * különben a keret némán elbukik. Fordítva is igaz: amit a CSP enged, de az
   * ellenőrzés nem, az fölöslegesen tágítja a CSP-t.
   */
  it('amit az ellenőrzés átenged, azt a CSP is engedi', async () => {
    const fs = await frameSrc()
    for (const host of hosts.embedHosts()) {
      const cim = `https://${host}/stream/s-2/169846/sub`
      assert.ok(embedUrl.safeUpstreamUrl(cim, hosts.embedHosts()), `az ellenőrzés elutasítja: ${cim}`)
      assert.ok(fs.includes(`https://${host}`), `a CSP nem engedi: ${cim}`)
    }
  })

  it('amit az ellenőrzés elutasít, az nem kap külön CSP-engedélyt', async () => {
    const fs = await frameSrc()
    // Egy tetszőleges idegen gazdagép sem az ellenőrzésen, sem a CSP-n.
    assert.equal(embedUrl.safeUpstreamUrl('https://tamado.pelda/x', hosts.embedHosts()), null)
    assert.ok(!fs.includes('tamado.pelda'))
  })

  it('a CSP továbbra sem engedi a YUME beágyazását', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/config' })
    const csp = String(res.headers['content-security-policy'] ?? '')
    assert.match(csp, /frame-ancestors 'none'/)
    assert.equal(res.headers['x-frame-options'], 'DENY')
  })

  it('az előzetesek YouTube-beágyazása megmarad', async () => {
    const fs = await frameSrc()
    assert.ok(fs.includes('https://www.youtube.com'))
    assert.ok(fs.includes('https://www.youtube-nocookie.com'))
  })
})

describe('a beágyazó gazdagépek listája', () => {
  it('a frame-src alakok sémával és altartománnyal készülnek', async () => {
    const m = await import('../src/modules/providers/embed-hosts.ts')
    assert.deepEqual(m.frameSrcEntries(['pelda.hu']), ['https://pelda.hu', 'https://*.pelda.hu'])
  })

  it('az üres és a hibás listaelemeket kihagyja', async () => {
    const m = await import('../src/modules/providers/embed-hosts.ts')
    assert.deepEqual(m.frameSrcEntries(['', '  ', '.']), [])
  })

  it('a kis-nagybetűt és a záró pontot normalizálja', async () => {
    const m = await import('../src/modules/providers/embed-hosts.ts')
    assert.deepEqual(m.frameSrcEntries(['Pelda.HU.']), ['https://pelda.hu', 'https://*.pelda.hu'])
  })
})
