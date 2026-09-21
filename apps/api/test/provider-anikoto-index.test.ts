// Az Anikoto katalógusindexe.
//
// EZ A KÉSZLET EGY MÉRT, ÉLES HIBÁT ŐRIZ. Az adapter egyetlen lapot kért le
// (`/recent-anime?page=1&per_page=50`), és abban keresett. A szolgáltató
// katalógusa 180 lap, 8958 tétel — vagyis a Shingeki no Kyojin, a Kimetsu no
// Yaiba és a Death Note BENNE VOLT, csak nem az első lapon. A nézőnek ez
// „ezt a részt egyik forrásból sem sikerült lejátszani"-ként jelent meg.
//
// Az API-nak nincs kereső végpontja — mérve: a `/search` 404, a
// `q`/`search`/`keyword`/`title` paramétert a `/recent-anime` figyelmen kívül
// hagyja. Lapozni tud, mást nem. Ezért az index nem gyorsítás, hanem a
// működés feltétele.
//
// A hálózat hamis: a mérés tárgya a bejárás és a párosítás, nem egy külső
// kiszolgáló elérhetősége.

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import {
  buildIndex, clearIndex, crawl, getIndex, peekIndex, normalizeTitle,
  MAX_PAGES, PER_PAGE, TTL_MS
} from '../src/modules/providers/adapters/anikoto-index.ts'

beforeEach(() => { clearIndex() })

/** Katalógus, lapokra bontva — ahogy a valódi kiszolgáló adja. */
function katalogus (osszesen: number, perPage = PER_PAGE) {
  const tetelek = Array.from({ length: osszesen }, (_, i) => ({
    id: 1000 + i,
    title: `Cím ${i}`,
    titles: `Cím ${i}; Alcím ${i}`,
    ani_id: String(20000 + i),
    mal_id: String(30000 + i),
    year: 2000 + (i % 25),
    episodes: '12'
  }))
  const kertLapok: number[] = []
  const fetchPage = async (page: number, pp: number) => {
    kertLapok.push(page)
    const kezd = (page - 1) * pp
    return { ok: true, data: tetelek.slice(kezd, kezd + pp) }
  }
  return { tetelek, fetchPage, kertLapok, perPage }
}

describe('a katalógus bejárása', () => {
  it('az ÜRES LAPIG megy, nem az első lapig', async () => {
    const { fetchPage } = katalogus(430)
    const items = await crawl(fetchPage)
    assert.equal(items.length, 430, 'a bejárás korán megállt — pont ez volt az éles hiba')
  })

  it('egy lapnyi katalógust is végigjár', async () => {
    const { fetchPage } = katalogus(30)
    assert.equal((await crawl(fetchPage)).length, 30)
  })

  it('üres katalóguson nem akad meg', async () => {
    const { fetchPage } = katalogus(0)
    assert.deepEqual(await crawl(fetchPage), [])
  })

  it('párhuzamosan kér, nem egyesével', async () => {
    let egyszerre = 0
    let csucs = 0
    const fetchPage = async (page: number, pp: number) => {
      egyszerre++
      csucs = Math.max(csucs, egyszerre)
      await new Promise(resolve => setTimeout(resolve, 3))
      egyszerre--
      return { ok: true, data: page <= 4 ? Array.from({ length: pp }, (_, i) => ({ id: page * 100 + i })) : [] }
    }
    await crawl(fetchPage, { concurrency: 4 })
    assert.ok(csucs > 1, `egyesével kérte le a lapokat (csúcs: ${csucs})`)
  })

  /*
   * EGY ELVESZETT LAP NEM DÖNTI ÖSSZE AZ INDEXET. Egy hiányos index rosszabb
   * a teljesnél, de sokkal jobb a semmilyennél — és a következő újraépítés
   * úgyis megpróbálja megint.
   */
  it('egy hibás lap nem szakítja meg a bejárást', async () => {
    const { fetchPage } = katalogus(200)
    const hibas = async (page: number, pp: number) => {
      if (page === 2) throw new Error('hálózati hiba')
      return await fetchPage(page, pp)
    }
    const items = await crawl(hibas, { concurrency: 4 })
    assert.equal(items.length, 150, 'a hiányzó lap az egész bejárást elvitte')
  })

  /*
   * A VÉGTELEN LAPOZÁS ELLEN. Ha a kiszolgáló sosem adna üres lapot, enélkül
   * a bejárás örökké futna — egy néző kérése közben.
   */
  it('a lapkorlát megállítja a végtelen lapozást', async () => {
    let hivasok = 0
    const vegtelen = async (_page: number, pp: number) => {
      hivasok++
      return { ok: true, data: Array.from({ length: pp }, (_, i) => ({ id: i })) }
    }
    await crawl(vegtelen, { concurrency: 8, maxPages: 40 })
    assert.ok(hivasok <= 40, `a korlát fölé ment: ${hivasok}`)
    assert.ok(MAX_PAGES > 0)
  })
})

describe('az index felépítése', () => {
  it('azonosító és cím szerint is kereshető', () => {
    const index = buildIndex([
      { id: 8717, title: 'Liar Game', titles: 'LIAR GAME; Hazug Játék', ani_id: '197754', mal_id: '62331', year: 2026, episodes: '26' }
    ])
    assert.equal(index.all.length, 1)
    assert.equal(index.byAnilist.get(197754)?.[0]?.id, '8717')
    assert.equal(index.byMal.get(62331)?.[0]?.id, '8717')
    assert.equal(index.byTitle.get(normalizeTitle('Liar Game'))?.[0]?.id, '8717')
    // A `titles` blokk darabjai külön kulcsok — ezen múlik a másik nyelvű keresés.
    assert.equal(index.byTitle.get(normalizeTitle('Hazug Játék'))?.[0]?.id, '8717')
  })

  it('SZÁM alakú azonosítót is elfogad', () => {
    const index = buildIndex([{ id: 8717, title: 'A', ani_id: 197754, mal_id: 62331 }])
    assert.equal(index.all[0]?.id, '8717')
    assert.equal(index.all[0]?.anilistId, 197754)
  })

  it('az azonosító nélküli tételt kihagyja, a többit megtartja', () => {
    const index = buildIndex([{ title: 'nincs id' }, { id: 5, title: 'van' }])
    assert.equal(index.all.length, 1)
  })

  it('azonos azonosítón több tétel is megfér', () => {
    const index = buildIndex([
      { id: 1, title: 'Első évad', ani_id: '100' },
      { id: 2, title: 'Második évad', ani_id: '100' }
    ])
    assert.equal(index.byAnilist.get(100)?.length, 2)
  })
})

describe('az index tárolása', () => {
  it('másodszorra nem jár be újra', async () => {
    const { fetchPage, kertLapok } = katalogus(120)
    await getIndex(fetchPage)
    const elso = kertLapok.length
    await getIndex(fetchPage)
    assert.equal(kertLapok.length, elso, 'másodszor is végigjárta a katalógust')
  })

  /*
   * EGYSZERRE EGY ÉPÍTÉS. Enélkül tíz egyidejű kérés tízszer járná be a
   * katalógust: ezerhétszáz HTTP-kérés egyetlen epizód lejátszásáért.
   */
  it('az egyidejű kérések EGY bejárást osztanak meg', async () => {
    let hivasok = 0
    const lassu = async (page: number, pp: number) => {
      hivasok++
      await new Promise(resolve => setTimeout(resolve, 5))
      return { ok: true, data: page <= 3 ? Array.from({ length: pp }, (_, i) => ({ id: page * 100 + i })) : [] }
    }
    const [a, b, c] = await Promise.all([getIndex(lassu), getIndex(lassu), getIndex(lassu)])
    assert.equal(a, b)
    assert.equal(b, c)
    assert.ok(hivasok <= 8, `${hivasok} kérés ment ki három egyidejű kérésre`)
  })

  /*
   * ÜRES BEJÁRÁST NEM TÁROLUNK. Ha a kiszolgáló épp nem elérhető, egy üres
   * index egy ÓRÁRA kizárná az egész szolgáltatót — és a néző ugyanazt a
   * „nincs forrás" üzenetet kapná, amit javítunk.
   */
  it('a sikertelen bejárás nem rögzül egy órára', async () => {
    const semmi = async () => ({ ok: true, data: [] })
    await getIndex(semmi)
    assert.equal(peekIndex(), null, 'az üres bejárás beragadt a gyorsítótárba')
  })

  /*
   * AZ IDŐT ELŐRETEKERJÜK, mert különben ez a teszt ÜRESJÁRATBAN ZÖLD:
   * friss gyorsítótárnál a `getIndex` vissza sem hívja a lapkérőt, tehát
   * nem az „üres bejárás" ágat mérné, hanem azt, hogy van gyorsítótár.
   */
  it('a lejárt index NEM vész el egy sikertelen újraépítéstől', async () => {
    const { fetchPage } = katalogus(80)
    const jo = await getIndex(fetchPage)
    assert.equal(jo.all.length, 80)

    const valodi = Date.now
    try {
      Date.now = () => valodi() + TTL_MS + 1_000
      assert.equal(peekIndex(), null, 'a lejárat nem érvényesül')

      let hivva = false
      const semmi = async () => { hivva = true; return { ok: true, data: [] } }
      const utana = await getIndex(semmi)

      assert.ok(hivva, 'meg sem próbálta újraépíteni — a teszt nem azt méri, amit állít')
      assert.equal(utana.all.length, 80, 'egy elérhetetlen kiszolgáló eldobta a jó indexet')
    } finally {
      Date.now = valodi
    }
  })

  it('a peekIndex nem épít', () => {
    assert.equal(peekIndex(), null)
  })
})
