// A LEJÁTSZÓOLDAL TELEFONON.
//
// Minden állítás itt egy MÉRT, éles hibát őriz. Mindegyik olyan hiba volt,
// amit CSAK VALÓDI BÖNGÉSZŐ mutat meg: számításból egyik sem következik, és
// a meglévő responsive-mérés sem fogta meg, mert a `watch` útvonal nem
// szerepelt benne — épp az, amelyikre a panasz szólt.
//
// Amit őriz:
//
//   1. A LAP NEM SZÉLESEBB A KÉPERNYŐNÉL. Mérve: 390 képpontos telefonon a
//      tartalom 460 képpont széles volt, a `.page` `overflow-x: clip`-je
//      pedig egyszerűen levágta a szélét — nem lehetett oldalra görgetni,
//      a szöveg csak eltűnt. Az ok az epizódcímek `white-space: nowrap`-je:
//      ellipszisezik, tehát jól néz ki, de a MIN-CONTENT szélessége a teljes
//      szöveg, és az szétfeszítette az egész oldalt.
//
//   2. A LEJÁTSZÓ VAN ELÖL. Az epizódlista `order: -1`-gyel a lejátszó FÖLÉ
//      került, és a videó a hajtás alá csúszott: a néző egy tizenkét soros
//      listát görgetett végig ahhoz, amiért az oldalt megnyitotta.
//
//   3. A KERESŐSÁV FOGANTYÚJA LÁTSZIK. `transform: scale(0)` volt, és csak
//      `:hover`-re nőtt ki — telefonon nincs hover, tehát SOHA nem látszott.
//
//   4. A FELIRATOT MI RAJZOLJUK. A `mode = 'showing'` azt jelentette, hogy a
//      böngésző rajzol: a szöveg a videó aljára, vagyis PONT A VEZÉRLŐSÁVBA
//      került, és a lejátszó egész feliratstílus-rendszere hatástalan volt.

/* global Storage, getComputedStyle, localStorage */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = join(here, '..', '..', 'apps', 'web')

let chromium
try {
  ({ chromium } = await import('playwright'))
} catch {
  chromium = null
}

const VIDEO = '/assets/videos/amv-counting-stars.mp4'
const REASON = !chromium
  ? 'playwright is not installed'
  : !process.env.DATABASE_URL
      ? 'no DATABASE_URL'
      : false

/** A telefonszélességek, amik tényleg forgalomban vannak. */
const SZELESSEGEK = [430, 390, 375, 360]

const VTT = `WEBVTT

00:00.500 --> 00:09.000
Első felirat a méréshez

00:10.000 --> 00:19.000
<b>Második</b> felirat
`

describe('a lejátszóoldal telefonon', { skip: REASON }, () => {
  let server, browser, pool, page, base, account, animeId
  const username = 'watchphone' + randomBytes(4).toString('hex')

  before(async () => {
    process.env.WEB_ROOT = WEB_ROOT
    process.env.JWT_SECRET ??= 'watch-phone-secret-not-used-for-anything-0123456789'
    // Az emberpróba kikapcsolva: ezek a tesztek API-hívással regisztrálnak.
    delete process.env.TURNSTILE_SITE_KEY
    delete process.env.TURNSTILE_SECRET_KEY
    process.env.LOG_LEVEL ??= 'warn'
    process.env.RATE_LIMIT_MAX ??= '100000'

    const [{ buildApp }, db] = await Promise.all([
      import('../../apps/api/src/app.ts'),
      import('../../apps/api/src/infrastructure/database/index.ts')
    ])
    server = await buildApp()
    pool = db.pool
    await server.listen({ port: 0, host: '127.0.0.1' })
    base = `http://127.0.0.1:${server.server.address().port}`

    /*
     * A CÍMEK SZÁNDÉKOSAN HOSSZÚAK. A túllógást pont a hosszú epizódcím
     * okozta; egy „1. rész" nevű fixtúra a hibát nem hozná elő.
     */
    const { rows: [anime] } = await pool.query(
      `INSERT INTO anime (canonical_title, format, status, visibility, episode_count, season_year)
       VALUES ($1,'TV','FINISHED','public',12,2024) RETURNING id`,
      ['Telefonos mérés ' + randomBytes(3).toString('hex')])
    animeId = anime.id
    for (let n = 1; n <= 12; n++) {
      const { rows: [ep] } = await pool.query(
        "INSERT INTO episodes (anime_id, number, title, visibility) VALUES ($1,$2,$3,'public') RETURNING id",
        [animeId, n, `A ${n}. rész nagyon hosszú címmel, hogy a tördelés is látszódjon rajta`])
      await pool.query(
        `INSERT INTO video_sources (episode_id, kind, ref, provider, variant, accuracy)
         VALUES ($1,'http',$2,'Helyi próba','sub','high')`, [ep.id, VIDEO])
    }

    const res = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${username}@example.com`, username, password: 'Correct-Horse-Battery-9' })
    })
    account = await res.json()

    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined })
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    await page.addInitScript(tokens => {
      localStorage.setItem('yume-auth', JSON.stringify(tokens))
      const getItem = Storage.prototype.getItem
      Storage.prototype.getItem = function (key) {
        return String(key).includes('-onboarded::') ? '1' : getItem.call(this, key)
      }
    }, account)
    // A felirat egy kitalált címről jön: a mérés tárgya a rajzolás, nem egy
    // idegen kiszolgáló elérhetősége.
    await page.route('https://felirat.teszt/**', route =>
      route.fulfill({ status: 200, contentType: 'text/vtt', body: VTT }))
    await page.route('https://**', route => (route.request().url().includes('felirat.teszt') ? route.continue() : route.abort()))
  })

  after(async () => {
    try {
      await pool?.query('DELETE FROM users WHERE username = $1', [username])
      if (animeId) await pool?.query('DELETE FROM anime WHERE id = $1', [animeId])
    } finally {
      await browser?.close()
      await server?.close()
      await pool?.end()
    }
  })

  /** Az oldal megnyitása egy szélességen, a leírás betöltésével együtt. */
  const nyit = async (width) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(`${base}/#/watch/${animeId}:1`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.player-box, .yp', { timeout: 20000 })
    await page.waitForTimeout(600)
  }

  for (const width of SZELESSEGEK) {
    it(`${width} képponton nem lóg túl semmi`, async () => {
      await nyit(width)
      const tul = await page.evaluate(() => {
        const limit = document.documentElement.clientWidth
        const nev = el => el.tagName.toLowerCase() +
          (typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
            : '')
        const ki = []
        for (const el of document.querySelectorAll('body *')) {
          const b = el.getBoundingClientRect()
          if (b.width && b.right > limit + 1) ki.push(`${nev(el)} → ${Math.round(b.right)} > ${limit}`)
        }
        return [...new Set(ki)].slice(0, 8)
      })
      assert.deepEqual(tul, [], `a tartalom túllóg a képernyőn ${width}px-en`)
    })
  }

  it('a lejátszó ELŐBB van, mint az epizódlista', async () => {
    await nyit(390)
    const sorrend = await page.evaluate(() => {
      const box = document.querySelector('.player-box')?.getBoundingClientRect()
      const lista = document.querySelector('.wep-panel')?.getBoundingClientRect()
      return { lejatszo: box ? Math.round(box.top) : null, lista: lista ? Math.round(lista.top) : null }
    })
    assert.ok(sorrend.lejatszo !== null, 'nincs lejátszó a lapon')
    assert.ok(sorrend.lista !== null, 'nincs epizódlista a lapon')
    assert.ok(sorrend.lejatszo < sorrend.lista,
      `az epizódlista a lejátszó FÖLÖTT van (lejátszó ${sorrend.lejatszo}, lista ${sorrend.lista})`)
  })

  it('a lejátszó a hajtás fölött van', async () => {
    await nyit(390)
    const top = await page.evaluate(() => Math.round(document.querySelector('.player-box').getBoundingClientRect().top))
    assert.ok(top < 400, `a lejátszó ${top} képponttal lejjebb kezdődik — a néző görgetni kényszerül`)
  })

  describe('a lejátszó vezérlői', () => {
    /** A player2 közvetlenül, a saját videónkkal és egy felirattal. */
    const mount = () => page.evaluate(async ({ src }) => {
      document.querySelector('#harness')?.remove()
      const host = document.createElement('div')
      host.id = 'harness'
      host.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#000;'
      document.body.append(host)
      const { createEpisodePlayer } = await import('../../../../src/features/player2/watch/episode-player.js')
      const video = document.createElement('video')
      video.playsInline = true; video.muted = true; video.preload = 'metadata'
      const mounted = createEpisodePlayer({
        video,
        sources: [{ id: 'local', url: src, quality: 1080, label: 'helyi' }],
        subtitles: [{ url: 'https://felirat.teszt/a.vtt', language: 'en', label: 'English', format: 'vtt', kind: 'subtitles' }],
        media: { title: 'Próba' },
        episode: { number: 1 }
      })
      host.append(mounted.node)
      window.__yp = mounted
      await new Promise(resolve => setTimeout(resolve, 2500))
    }, { src: VIDEO })

    it('a keresősáv fogantyúja érintésen is látszik', async () => {
      await nyit(390)
      await mount()
      const lathato = await page.evaluate(() => {
        const head = document.querySelector('.yp-seek-head')
        if (!head) return { hiba: 'nincs fogantyú' }
        const t = getComputedStyle(head).transform
        return { transform: t, latszik: t !== 'matrix(0, 0, 0, 0, 0, 0)' && t !== 'scale(0)' }
      })
      assert.ok(lathato.latszik,
        `a fogantyú rejtve van telefonon (transform: ${lathato.transform ?? lathato.hiba}) — érintésen nincs hover, ami kinöveszthetné`)
    })

    it('a feliratsáv REJTETT módban megy — mi rajzolunk, nem a böngésző', async () => {
      await nyit(390)
      await mount()
      await page.waitForTimeout(1500)
      const modok = await page.evaluate(() =>
        [...(document.querySelector('#harness video')?.textTracks ?? [])].map(t => t.mode))
      assert.ok(modok.length > 0, 'nem töltődött be feliratsáv')
      assert.ok(!modok.includes('showing'),
        'a sáv `showing` módban van: a böngésző rajzolja, a videó aljára — vagyis a vezérlősávba')
    })

    it('a felirat a SAJÁT rétegünkbe kerül, és nem lóg a vezérlősávba', async () => {
      await nyit(390)
      await mount()
      const r = await page.evaluate(async () => {
        const video = document.querySelector('#harness video')
        const track = video.textTracks[0]
        // várunk, amíg a sáv beolvassa a jelzéseket
        for (let i = 0; i < 40 && !(track.cues?.length); i++) await new Promise(resolve => setTimeout(resolve, 100))
        const cue = track.cues?.[0]
        if (!cue) return { hiba: 'nem töltődtek be a feliratok' }
        video.currentTime = cue.startTime + (cue.endTime - cue.startTime) / 2
        for (let i = 0; i < 40 && !(track.activeCues?.length); i++) await new Promise(resolve => setTimeout(resolve, 100))

        const layer = document.querySelector('.yp-subtitles')
        const ctl = document.querySelector('.yp-controls').getBoundingClientRect()
        const lb = layer.getBoundingClientRect()
        return {
          szoveg: (layer.textContent ?? '').trim(),
          dobozok: layer.children.length,
          utkozik: lb.height ? lb.bottom > ctl.top + 1 : false
        }
      })
      assert.ok(!r.hiba, r.hiba)
      assert.ok(r.dobozok > 0, 'a saját feliratrétegünk üres — a rajzolás nem fut le')
      assert.match(r.szoveg, /Első felirat/, `a réteg nem a felirat szövegét mutatja: „${r.szoveg}"`)
      assert.equal(r.utkozik, false, 'a felirat belelóg a vezérlősávba')
    })

    it('a vezérlősáv nem takarja a kép felénél többet', async () => {
      await nyit(390)
      await mount()
      const arany = await page.evaluate(() => {
        const yp = document.querySelector('.yp').getBoundingClientRect()
        const ctl = document.querySelector('.yp-controls').getBoundingClientRect()
        return Math.round(ctl.height / yp.height * 100)
      })
      assert.ok(arany <= 50, `a vezérlősáv a kép ${arany}%-át takarja`)
    })

    it('egyetlen gomb sem lóg ki a lejátszóból', async () => {
      for (const width of SZELESSEGEK) {
        await nyit(width)
        await mount()
        const ki = await page.evaluate(() => {
          const yp = document.querySelector('.yp').getBoundingClientRect()
          return [...document.querySelectorAll('.yp-btn')]
            .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.right > yp.right + 1 || r.left < yp.left - 1) })
            .map(b => b.className)
        })
        assert.deepEqual(ki, [], `gomb lóg ki a lejátszóból ${width}px-en`)
      }
    })
  })
})
