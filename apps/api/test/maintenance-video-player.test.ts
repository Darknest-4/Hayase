// A karbantartási videó: LEJÁTSZÓ, nem háttér.
//
// AMI A HIBA VOLT, és amiért ez a fájl létezik.
//
// A karbantartási oldal két helyen készül el. A böngésző ebből azt kapja, amit
// a KISZOLGÁLÓ rajzol ki (`status-page.ts`) — a kliens alkalmazás el sem
// indul, hiszen a kérés 503-mal fordul vissza. Mérve, karbantartás alatt:
//
//   GET /            Accept: text/html      → 503
//   a válasz tartalmaz `main.js` hivatkozást?  → NEM
//
// Emiatt a kliensoldali lejátszó (`features/maintenance/…`) átírása a
// megjelenésen semmit nem változtatott: az a kód nem futott le. Ami futott, az
// ez a lap, és benne a videó így állt:
//
//   <video class="bg" autoplay muted loop aria-hidden="true" tabindex="-1">
//   .bg { position: fixed; inset: 0; width: 100%; height: 100%;
//         object-fit: cover; opacity: .22; pointer-events: none; z-index: 0 }
//
// Vagyis: a viewportot kitöltő, rögzített, 22%-osra halványított réteg a
// kártya SZÖVEGE mögött, `pointer-events: none`-nal (tehát megállítani sem
// lehetett) és `aria-hidden`-nel (tehát a felolvasó számára nem is létezett).
//
// Ez a suite azt méri, hogy egyik jellemző sem tért vissza.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderStatusPage } from '../src/infrastructure/http/status-page.ts'

const VIDEO = { url: '/assets/videos/karbantartas.mp4', type: 'video/mp4' }

const render = (video: typeof VIDEO | null = VIDEO): string => renderStatusPage({
  status: 503,
  title: 'Karbantartás',
  message: 'Mindjárt jövünk.',
  retryAfter: 120,
  retryHref: '/',
  video
})

/** A videóelem nyitócímkéje. */
const tag = (html: string): string => /<video[^>]*>/.exec(html)?.[0] ?? ''

describe('a karbantartási lap videója', () => {
  it('egyáltalán kimegy', () => {
    assert.match(render(), /<video[^>]*>/)
    assert.match(render(), /<source src="\/assets\/videos\/karbantartas\.mp4" type="video\/mp4">/)
  })

  it('videó nélkül nem marad üres elem a lapon', () => {
    assert.doesNotMatch(render(null), /<video/)
  })

  /*
   * A NÉGY JELLEMZŐ, ami háttérréteggé tette. Egyenként felsorolva, mert egy
   * összevont állítás nem mondaná meg, melyik jött vissza.
   */
  it('nem háttérréteg: nincs `bg` osztálya', () => {
    assert.doesNotMatch(tag(render()), /class="bg"/)
    assert.doesNotMatch(render(), /\.bg\s*\{/)
  })

  it('nem magától indul, és nem jár hurokban', () => {
    const video = tag(render())
    assert.doesNotMatch(video, /\bautoplay\b/)
    assert.doesNotMatch(video, /\bloop\b/)
    assert.doesNotMatch(video, /\bmuted\b/)
  })

  it('a felolvasó és a billentyűzet számára is létezik', () => {
    const video = tag(render())
    assert.doesNotMatch(video, /aria-hidden/)
    assert.doesNotMatch(video, /tabindex="-1"/)
  })

  /*
   * A pozicionálás a lényeg: `fixed`/`absolute` + `inset: 0` az, amitől egy
   * elem kikerül a folyamból és a tartalom mögé áll. A lap többi része
   * (a háttérfény) használ `fixed`-et, ezért kifejezetten a videó
   * szabályblokkját nézzük.
   */
  it('semmi nem emeli ki a tartalom folyamából', () => {
    const rule = /\.video\s*\{([^}]*)\}/.exec(render())?.[1] ?? ''
    assert.ok(rule.length > 0, 'nincs stílusa a videónak')
    for (const tiltott of ['position', 'inset', 'z-index', 'pointer-events', 'opacity', 'transform']) {
      assert.ok(!rule.includes(tiltott), `a videó szabálya kiemeli a folyamból: ${tiltott}`)
    }
  })

  /*
   * Ez a lap SZKRIPT NÉLKÜLI — a `script-src 'self'` megfogná a beágyazott
   * szkriptet, és a lap pont akkor megy ki, amikor a kiszolgáló bajban van.
   * Saját vezérlősávot tehát nincs mivel építeni: a natív `controls` az, ami
   * indítást, tekerést, hangerőt, teljes képernyőt és — ahol van — kép a
   * képben funkciót ad, mobilon és konzolböngészőben egyaránt.
   */
  it('valódi HTML5 vezérlői vannak', () => {
    const video = tag(render())
    assert.match(video, /\bcontrols\b/)
    assert.match(video, /\bplaysinline\b/)
    assert.match(video, /preload="metadata"/)
  })

  it('a kártya tartalmának része, nem a kártya előtt áll', () => {
    const html = render()
    const card = html.indexOf('<div class="card">')
    const video = html.indexOf('<video')
    const cardEnd = html.indexOf('</div>', card)
    assert.ok(card >= 0 && video > card && video < cardEnd,
      'a videó nem a kártyán belül van')
  })

  /*
   * A SORREND: a néző előbb azt akarja tudni, MI TÖRTÉNIK, és csak utána jön
   * a videó. Egy lejátszó a cím előtt a választ tolja lejjebb.
   */
  it('a cím és az üzenet után jön', () => {
    const html = render()
    assert.ok(html.indexOf('<h1>') < html.indexOf('<video'))
    assert.ok(html.indexOf('Mindjárt jövünk') < html.indexOf('<video'))
  })

  it('poszter, ha van hozzá', () => {
    const html = renderStatusPage({
      status: 503, title: 'K', message: 'M', retryAfter: 60, retryHref: '/',
      video: { ...VIDEO, poster: '/assets/poszter.jpg' }
    })
    assert.match(tag(html), /poster="\/assets\/poszter\.jpg"/)
  })

  it('a forrás címe kódolva megy ki', () => {
    const html = renderStatusPage({
      status: 503, title: 'K', message: 'M', retryAfter: 60, retryHref: '/',
      video: { url: '/a"><script>alert(1)</script>.mp4', type: 'video/mp4' }
    })
    assert.doesNotMatch(html, /<script>alert/)
  })
})
