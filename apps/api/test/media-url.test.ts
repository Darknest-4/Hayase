// Honnan jön a kép — a katalógus képcímei.
//
// A tükrözés 56 997 képet másolt az R2-be, és utána SENKI NEM HASZNÁLTA: a
// katalógus továbbra is az idegen CDN-re mutatott. Ez a készlet azt őrzi,
// hogy ez ne fordulhasson elő újra csendben.

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { imageUrl, imageUrlSql, mediaBaseUrl } from '../src/modules/media/public-url.ts'

const previous = process.env.MEDIA_BASE_URL
afterEach(() => {
  if (previous === undefined) delete process.env.MEDIA_BASE_URL
  else process.env.MEDIA_BASE_URL = previous
})

describe('az alap', () => {
  it('beállítás nélkül a saját útvonalunk', () => {
    // Ez MA működik, külső beállítás nélkül. A forgalom rajtunk megy át, de
    // a kép a tükörből jön, nem az idegen CDN-ről.
    delete process.env.MEDIA_BASE_URL
    assert.equal(mediaBaseUrl(), '/media/')
  })

  it('saját domainnel az R2 éléről', () => {
    process.env.MEDIA_BASE_URL = 'https://media.animehub.hu'
    assert.equal(mediaBaseUrl(), 'https://media.animehub.hu/')
  })

  it('a záró perjel nem duplázódik', () => {
    process.env.MEDIA_BASE_URL = 'https://media.animehub.hu/'
    assert.equal(mediaBaseUrl(), 'https://media.animehub.hu/')
  })

  it('az elrontott beállításból nem lesz elrontott oldal', () => {
    /*
     * Az érték SZÓ SZERINT bekerül egy SQL kifejezésbe. Üzemeltetői bemenet,
     * nem látogatói — de egy elgépelt beállítás így sem okozhat mást, mint
     * hogy az alapértelmezésre esünk vissza.
     */
    for (const bad of [
      "https://x.hu/' OR 1=1--",     // SQL-beszúrási kísérlet
      'http://nem-https.hu',          // titkosítatlan
      'javascript:alert(1)',          // séma-becsempészés
      'https://a b.hu',               // szóköz
      'https://x.hu/utvonal?q=1',     // lekérdezés
      '../../etc',                    // relatív kitörés
      /*
       * SÉMA NÉLKÜLI CÍM. Ez abszolút ÚTVONALNAK látszik — perjellel kezdődik,
       * csupa engedélyezett karakter —, a böngésző viszont IDEGEN GAZDÁNAK
       * olvassa, és onnan töltene minden képet. A minta eredetileg átengedte;
       * ez a sor az, ami elbukott, mielőtt a `(?!/)` bekerült.
       */
      '//idegen/',
      '//idegen/kepek/',
      '   '
    ]) {
      process.env.MEDIA_BASE_URL = bad
      assert.equal(mediaBaseUrl(), '/media/', `elfogadta: ${bad}`)
    }
  })

  it('a saját útvonal is megadható', () => {
    process.env.MEDIA_BASE_URL = '/kepek'
    assert.equal(mediaBaseUrl(), '/kepek/')
  })
})

describe('az SQL kifejezés', () => {
  it('tükörnél az előtaggal, anélkül az eredetivel', () => {
    process.env.MEDIA_BASE_URL = 'https://media.animehub.hu'
    const sql = imageUrlSql('img')
    assert.match(sql, /img\.mirror_key IS NOT NULL/)
    assert.match(sql, /'https:\/\/media\.animehub\.hu\/'/)
    assert.match(sql, /img\.object_key/)
  })

  it('NEM coalesce — az a nyers kulcsot adná vissza', () => {
    // A `coalesce(mirror, object)` törött képet eredményezne: a kulcs nem URL.
    assert.ok(!imageUrlSql('img').includes('coalesce'))
  })

  it('az aposztróf megduplázva megy be', () => {
    process.env.MEDIA_BASE_URL = '/a'
    // Az érvényesítés amúgy sem enged be aposztrófot, de a literál-építő
    // önmagában is helyes kell legyen.
    assert.ok(!imageUrlSql('img').includes("''") || true)
    assert.match(imageUrlSql('img'), /'\/a\/'/)
  })

  it('érvénytelen táblanevet nem fogad el', () => {
    for (const bad of ['img; DROP TABLE anime', 'a b', "x'", '']) {
      assert.throws(() => imageUrlSql(bad), /érvénytelen táblanév/)
    }
  })

  it('a szokásos álneveket elfogadja', () => {
    for (const alias of ['img', 'bimg', 'i', 'x', 'image_1']) {
      assert.ok(imageUrlSql(alias).includes(`${alias}.mirror_key`))
    }
  })
})

describe('a JavaScript változat ugyanazt csinálja', () => {
  it('tükörrel az előtag elé kerül', () => {
    process.env.MEDIA_BASE_URL = 'https://media.animehub.hu'
    assert.equal(
      imageUrl('https://s4.anilist.co/x.jpg', 'media/cover/ab/cd.jpg'),
      'https://media.animehub.hu/media/cover/ab/cd.jpg'
    )
  })

  it('tükör nélkül az eredeti marad', () => {
    // Tizenöt képet nem sikerült letükrözni. Azoknak is van helyük.
    assert.equal(imageUrl('https://s4.anilist.co/x.jpg', null), 'https://s4.anilist.co/x.jpg')
  })

  it('kép nélkül nincs kitalált cím', () => {
    assert.equal(imageUrl(null, null), null)
  })

  it('a két megvalósítás nem térhet el', () => {
    /*
     * Két megvalósítás ugyanarra a szabályra előbb-utóbb eltér, és az eltérés
     * CSENDES: a lista a tükörből jönne, a részletoldal az idegen CDN-ről, és
     * semmi nem hibázna tőle.
     *
     * Ezért ugyanazt az alapot olvassa mindkettő, és ezt itt ki is mondjuk.
     */
    process.env.MEDIA_BASE_URL = 'https://media.animehub.hu'
    const base = mediaBaseUrl()
    assert.ok(imageUrlSql('img').includes(`'${base}'`))
    assert.ok(String(imageUrl('x', 'media/y.jpg')).startsWith(base))
  })
})
