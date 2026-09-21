// Karbantartási mód a kliensen — szolgáltatás, oldal, lejátszó.
//
// EGY HATÁR, amit ezek a tesztek is őriznek: ez a réteg MEGJELENÍT, nem véd.
// A szerver minden kérést maga bírál el; ami itt történik, az arról szól,
// hogy a néző ne egy sor elhasalt kérésből következtesse ki, mi van.

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createDocument, withDocument } from './support/mini-dom.mjs'
import {
  ACTIVE_POLL_MS, IDLE_POLL_MS, MODE, createMaintenanceService, unknownStatus
} from '../src/features/maintenance/core/maintenance-service.js'
import { createMaintenancePage, humanCountdown } from '../src/features/maintenance/ui/maintenance-page.js'
import { createMaintenancePlayer, formatTime } from '../src/features/maintenance/video/maintenance-player.js'

let doc
let restore
const open = []

beforeEach(() => {
  while (open.length) open.pop().stop?.()
  restore?.()
  doc = createDocument()
  restore = withDocument(doc)
})
afterEach(() => {
  while (open.length) open.pop().stop?.()
  restore?.(); restore = null
})

/** Egy `fetch`, ami azt adja vissza, amit mondunk neki. */
const fakeFetch = (payload, { ok = true, status = 200 } = {}) => () =>
  Promise.resolve({ ok, status, json: () => Promise.resolve(payload) })

describe('a státusz szolgáltatás', () => {
  it('amíg nem tud semmit, az oldal működik', () => {
    const service = createMaintenanceService({ fetch: () => new Promise(() => {}) })
    open.push(service)
    assert.equal(service.status.mode, MODE.OFF)
    assert.equal(service.restricting, false)
  })

  it('beolvassa a státuszt, és jelez a változásról', async () => {
    const seen = []
    const service = createMaintenanceService({
      fetch: fakeFetch({ status: 'maintenance', mode: MODE.ACTIVE, version: 7 })
    })
    open.push(service)
    service.subscribe(status => seen.push(status.mode))
    await service.refresh()
    assert.equal(service.status.mode, MODE.ACTIVE)
    assert.equal(service.restricting, true)
    assert.deepEqual(seen, [MODE.ACTIVE])
  })

  it('a változatlan státusz nem vált ki értesítést', async () => {
    // Enélkül a felület húszmásodpercenként újraépülne, és a néző alól
    // elugrana, amit épp néz.
    const seen = []
    const service = createMaintenanceService({
      fetch: fakeFetch({ status: 'maintenance', mode: MODE.ACTIVE, version: 7 })
    })
    open.push(service)
    service.subscribe(() => seen.push(1))
    await service.refresh()
    await service.refresh()
    await service.refresh()
    assert.equal(seen.length, 1, 'minden lekérdezés újrarajzolt')
  })

  it('a lekérdezés hibája NEM karbantartás', async () => {
    // Ha nem érjük el a szervert, az lehet a mi hálózatunk is. Ilyenkor nem
    // ugrunk karbantartási oldalra.
    const service = createMaintenanceService({ fetch: () => Promise.reject(new Error('offline')) })
    open.push(service)
    await service.refresh()
    assert.equal(service.status.mode, MODE.OFF)
    assert.equal(service.restricting, false)
  })

  it('hiba után sem felejti el, amit tudott', async () => {
    let fail = false
    const service = createMaintenanceService({
      fetch: () => fail
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ mode: MODE.EMERGENCY, version: 3 }) })
    })
    open.push(service)
    await service.refresh()
    assert.equal(service.status.mode, MODE.EMERGENCY)
    fail = true
    await service.refresh()
    assert.equal(service.status.mode, MODE.EMERGENCY, 'egy hiba feloldotta a vészhelyzetet')
  })

  it('karbantartás alatt sűrűbben kérdez, de nem agresszíven', () => {
    // A 25. pont: ne legyen végtelen pörgetés.
    assert.ok(ACTIVE_POLL_MS >= 10_000, 'túl sűrű lekérdezés karbantartás alatt')
    assert.ok(IDLE_POLL_MS > ACTIVE_POLL_MS, 'normál üzemben nem ritkább')
  })

  it('a 503-at a FEJLÉC alapján ismeri fel, nem a kód alapján', async () => {
    // Egy 503 jöhet máshonnan is — arra nem karbantartási oldal jár.
    const service = createMaintenanceService({ fetch: fakeFetch({}) })
    open.push(service)
    const maintenance = { status: 503, headers: { get: name => (name === 'x-yume-maintenance' ? 'true' : null) } }
    const other = { status: 503, headers: { get: () => null } }
    assert.equal(service.isMaintenanceResponse(maintenance), true)
    assert.equal(service.isMaintenanceResponse(other), false)
    assert.equal(service.isMaintenanceResponse({ status: 200, headers: { get: () => null } }), false)
  })

  it('a hátralévő időt a befejezésből számolja', async () => {
    const end = new Date(Date.now() + 300_000).toISOString()
    const service = createMaintenanceService({
      fetch: fakeFetch({ mode: MODE.ACTIVE, estimatedEnd: end, version: 1 })
    })
    open.push(service)
    await service.refresh()
    const left = service.secondsLeft()
    assert.ok(left > 290 && left <= 300, `hátralévő: ${left}`)
  })

  it('ismeretlen befejezésnél nem talál ki időt', async () => {
    const service = createMaintenanceService({ fetch: fakeFetch({ mode: MODE.ACTIVE, version: 1 }) })
    open.push(service)
    await service.refresh()
    assert.equal(service.secondsLeft(), null)
  })
})

describe('a karbantartási oldal', () => {
  const status = {
    ...unknownStatus(),
    status: 'maintenance',
    mode: MODE.ACTIVE,
    version: 1,
    title: 'Épp dolgozunk',
    message: 'Mindjárt jövünk.'
  }

  it('a címet és az üzenetet mutatja', () => {
    const page = createMaintenancePage(status, {})
    assert.equal(page.node.querySelector('.mnt-title').textContent, 'Épp dolgozunk')
    assert.equal(page.node.querySelector('.mnt-message').textContent, 'Mindjárt jövünk.')
    assert.equal(page.node.querySelector('.mnt-logo').textContent, 'YUME')
    page.destroy()
  })

  it('üres üzenet helyett is mond valamit', () => {
    const page = createMaintenancePage({ ...status, title: '', message: '' }, {})
    assert.ok(page.node.querySelector('.mnt-title').textContent.length > 0)
    assert.ok(page.node.querySelector('.mnt-message').textContent.length > 0)
    page.destroy()
  })

  it('a mód nem csak színnel jelenik meg', () => {
    // „No color-only information" — a 28. pont. A jelvény SZÖVEGE is
    // megmondja, miről van szó.
    const page = createMaintenancePage({ ...status, mode: MODE.EMERGENCY }, {})
    const badge = page.node.querySelector('.mnt-badge')
    assert.equal(badge.dataset.mode, MODE.EMERGENCY)
    assert.match(badge.textContent, /Rendkívüli/)
    page.destroy()
  })

  it('ismeretlen befejezésnél nem mutat hamis haladást', () => {
    // Egy haladásjelző, ami semmit nem jelez, hamis pontosságot mutat.
    const page = createMaintenancePage(status, {})
    assert.equal(page.node.querySelector('.mnt-progress').hidden, true)
    assert.match(page.node.querySelector('.mnt-when').textContent, /nem ismert/)
    page.destroy()
  })

  it('ismert befejezésnél visszaszámlál', () => {
    const page = createMaintenancePage(status, { service: { secondsLeft: () => 125, status } })
    assert.match(page.node.querySelector('.mnt-when').textContent, /2 perc/)
    assert.equal(page.node.querySelector('.mnt-progress').hidden, false)
    page.destroy()
  })

  it('az Újra gomb ellenőriz, és ha vége, továbbenged', async () => {
    let reloaded = false
    const page = createMaintenancePage(status, {
      service: { refresh: () => Promise.resolve({ ...status, mode: MODE.OFF, status: 'operational' }) },
      onRetry: () => { reloaded = true }
    })
    await page.node.querySelector('.mnt-retry').fire('click')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(reloaded, true, 'vége volt, mégsem engedett tovább')
    page.destroy()
  })

  it('ha még tart, nem tölt újra — nincs átirányítási hurok', async () => {
    let reloaded = false
    const page = createMaintenancePage(status, {
      service: { refresh: () => Promise.resolve(status) },
      onRetry: () => { reloaded = true }
    })
    await page.node.querySelector('.mnt-retry').fire('click')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(reloaded, false)
    page.destroy()
  })

  it('a cím és az üzenet nem kerülhet be jelölésként', () => {
    const page = createMaintenancePage({
      ...status, title: '<img src=x onerror=alert(1)>', message: '<script>alert(1)</script>'
    }, {})
    // `textContent`-tel írjuk ki, tehát elemet nem csinál belőle.
    assert.equal(page.node.querySelectorAll('img').length, 0)
    assert.equal(page.node.querySelectorAll('script').length, 0)
    page.destroy()
  })

  it('videó nélkül is teljes', () => {
    const page = createMaintenancePage({ ...status, video: null }, {})
    assert.ok(page.node.querySelector('.mnt-card'))
    assert.equal(page.node.querySelector('video'), null)
    page.destroy()
  })

  /*
   * A LEJÁTSZÓ A KÁRTYA TARTALMA, ÉS A SZÖVEG UTÁN JÖN.
   *
   * Korábban két külön `append` töltötte ugyanazt a kártyát: a lejátszó
   * feljebb került be, mint a fejléc és a cím, tehát a videó állt legfelül, a
   * „Karbantartás alatt vagyunk" pedig alatta. A néző előbb azt akarja tudni,
   * mi történik.
   */
  it('a lejátszó a kártyában van, a cím és az üzenet után', () => {
    const page = createMaintenancePage(
      { ...status, video: { url: '/x.mp4', type: 'video/mp4' } }, {})
    const card = page.node.querySelector('.mnt-card')
    const order = card.children.map(child => child.className)

    assert.ok(order.includes('mnt-player mnt-maintenance-player'),
      `a lejátszó nincs a kártyában: ${order.join(', ')}`)
    const player = order.findIndex(name => name.startsWith('mnt-player'))
    assert.ok(player > order.indexOf('mnt-title'), 'a lejátszó megelőzi a címet')
    assert.ok(player > order.indexOf('mnt-message'), 'a lejátszó megelőzi az üzenetet')
    page.destroy()
  })

  /*
   * A lejátszó a kártyán BELÜL van, nem a lap gyökerén — utóbbi a
   * háttérréteg helye lenne.
   */
  it('a lap gyökerének egyetlen gyereke a kártya', () => {
    const page = createMaintenancePage(
      { ...status, video: { url: '/x.mp4', type: 'video/mp4' } }, {})
    assert.deepEqual(page.node.children.map(child => child.className), ['mnt-card'])
    page.destroy()
  })

  it('a szétbontás nem hagy időzítőt', () => {
    const before = process.getActiveResourcesInfo().filter(name => name === 'Timeout').length
    const page = createMaintenancePage(status, {})
    page.destroy()
    const after = process.getActiveResourcesInfo().filter(name => name === 'Timeout').length
    assert.ok(after <= before, 'időzítő maradt a szétbontás után')
  })
})

describe('az idő kiírása', () => {
  it('emberi alakban', () => {
    assert.equal(humanCountdown(45), '45 másodperc')
    assert.equal(humanCountdown(125), '2 perc 05 mp')
    assert.equal(humanCountdown(7200), '2 óra 0 perc')
  })

  it('a nem értelmezhető időből nincs kiírás', () => {
    assert.equal(humanCountdown(0), null)
    assert.equal(humanCountdown(-5), null)
    assert.equal(humanCountdown(NaN), null)
    assert.equal(humanCountdown(null), null)
  })

  it('a lejátszó ideje percben és másodpercben', () => {
    assert.equal(formatTime(0), '0:00')
    assert.equal(formatTime(83), '1:23')
    assert.equal(formatTime(NaN), '0:00')
  })
})

describe('a karbantartás-lejátszó', () => {
  const asset = { url: '/assets/videos/maintenance.mp4', type: 'video/mp4' }

  it('videó nélkül nem épül fel — és nem is hibázik', () => {
    const player = createMaintenancePlayer(null, {})
    assert.equal(player.node, null)
    assert.doesNotThrow(() => player.destroy())
  })

  it('kikapcsolva sem épül fel', () => {
    assert.equal(createMaintenancePlayer(asset, { enabled: false }).node, null)
  })

  /*
   * NINCS HÁTTÉRMÓD — és ez a teszt a korábbi ellentéte.
   *
   * A lejátszónak volt egy `mode: 'background'` ága: csupasz `<video>`,
   * némán, hurokban, `aria-hidden`-nel. A karbantartási videó azóta TARTALOM:
   * a kártyában áll, saját vezérlőkkel, és a néző indítja.
   *
   * A régi módot kérve sem kaphat vissza senki háttérréteget: ez a vizsgálat
   * pont azzal a beállítással megy, ami korábban azt adta.
   */
  it('háttérmódot kérve is előtérbeli lejátszót kapunk', () => {
    const player = createMaintenancePlayer(asset, { mode: 'background' })
    assert.notEqual(player.node.tagName, 'VIDEO', 'csupasz videóelem = háttérréteg')
    assert.ok(player.node.classList.contains('mnt-player'))

    const video = player.node.querySelector('video')
    assert.ok(video, 'nincs videóelem a lejátszóban')
    assert.notEqual(video.getAttribute('aria-hidden'), 'true',
      'a videó tartalom, nem dekoráció — a felolvasó elől nem rejtjük el')
    assert.notEqual(video.loop, true, 'a hurok a háttérvideók sajátja')
    assert.ok(player.node.querySelector('.mnt-controls'), 'nincsenek vezérlők')
    player.destroy()
  })

  it('előtérmódban saját vezérlői vannak', () => {
    const player = createMaintenancePlayer(asset, { mode: 'foreground' })
    assert.ok(player.node.querySelector('.mnt-controls'))
    assert.ok(player.node.querySelector('.mnt-seek'))
    // Minden gombnak van felolvasható neve.
    for (const button of player.node.querySelectorAll('button')) {
      assert.ok(button.getAttribute('aria-label'), 'névtelen gomb')
    }
    player.destroy()
  })

  it('a kép a képben gombja csak ott jelenik meg, ahol működik', () => {
    // Egy tétlen gomb rosszabb, mint egy hiányzó.
    const player = createMaintenancePlayer(asset, { mode: 'foreground' })
    const labels = player.node.querySelectorAll('button').map(b => b.getAttribute('aria-label'))
    assert.ok(!labels.includes('Kép a képben'), 'a csonkolt környezetben is kitette')
    player.destroy()
  })

  it('a videó hibája nem viszi magával az oldalt', () => {
    const player = createMaintenancePlayer(asset, { mode: 'foreground' })
    player.video.fire('error')
    assert.match(player.node.querySelector('.mnt-state').textContent, /nem játszható le/)
    assert.ok(player.node.classList.contains('mnt-player-failed'))
    player.destroy()
  })

  it('a forrás típusa is kimegy, nem csak a cím', () => {
    // Enélkül a böngészőnek találgatnia kell, és néha nem is próbálkozik.
    const player = createMaintenancePlayer({ url: '/x.webm', type: 'video/webm' })
    const source = player.node.querySelector('source')
    assert.equal(source.type, 'video/webm')
    player.destroy()
  })
})
