// Karbantartási mód — az állapotgép, az ütemezés és a döntéshozó.
//
// Ez a három modul TISZTA FÜGGVÉNYEKBŐL áll, adatbázis és HTTP nélkül, és ez
// nem stílus: ez az a rendszer, ahol egy elrontott feltétel azt jelenti, hogy
// vagy MINDENKI ki van zárva, vagy SENKI. Az ilyet nem élesben kell
// kipróbálni.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MODE, MODES, SCOPE, SCOPES, blocksEverything, blocksWrites, isEmergency,
  isRestricting, parseMode, parseScope, scopeMatches, scopesFor
} from '../src/modules/maintenance/state.ts'
import {
  PHASE, effectiveMode, formatInZone, phaseAt, secondsUntilChange, toDate
} from '../src/modules/maintenance/schedule.ts'
import {
  DECISION, DEFAULT_RETRY_SECONDS, decide, offConfig, withinDrain,
  type MaintenanceConfig, type RequestFacts
} from '../src/modules/maintenance/policy.ts'

const at = (iso: string): Date => new Date(iso)

const config = (over: Partial<MaintenanceConfig> = {}): MaintenanceConfig => ({
  ...offConfig(), enabled: true, mode: MODE.ACTIVE, scope: SCOPE.GLOBAL, ...over
})

const ask = (facts: Partial<RequestFacts>, cfg = config(), now = at('2026-09-20T03:00:00Z')) =>
  decide(cfg, now, { url: '/v1/anime', method: 'GET', ...facts })

describe('állapotok', () => {
  it('mind a hat megvan', () => {
    assert.deepEqual([...MODES], ['OFF', 'SCHEDULED', 'ACTIVE', 'DEGRADED', 'READ_ONLY', 'EMERGENCY'])
  })

  it('melyik mit zár', () => {
    assert.equal(blocksEverything(MODE.ACTIVE), true)
    assert.equal(blocksEverything(MODE.EMERGENCY), true)
    assert.equal(blocksEverything(MODE.READ_ONLY), false)
    assert.equal(blocksWrites(MODE.READ_ONLY), true)
    // A teljes lezárás az írásokat IS zárja — különben egy `READ_ONLY`
    // ellenőrzés `ACTIVE` alatt átengedne egy írást.
    assert.equal(blocksWrites(MODE.ACTIVE), true)
    assert.equal(blocksWrites(MODE.OFF), false)
  })

  it('az ütemezett még nem korlátoz', () => {
    assert.equal(isRestricting(MODE.SCHEDULED), false)
    assert.equal(isRestricting(MODE.OFF), false)
    assert.equal(isRestricting(MODE.DEGRADED), true)
  })

  it('az ismeretlen érték a biztonságos irányba esik', () => {
    // Módnál a biztonságos az OFF: egy elgépelt mód ne zárja le az oldalt.
    assert.equal(parseMode('KITALÁLT'), MODE.OFF)
    assert.equal(parseMode(null), MODE.OFF)
    assert.equal(parseMode('active'), MODE.ACTIVE)
    // Hatókörnél a biztonságos a `global`: egy elgépelt hatókör ne nyisson ki
    // véletlenül olyasmit, amit le akartak zárni.
    assert.equal(parseScope('nincs-ilyen'), SCOPE.GLOBAL)
    assert.equal(parseScope('PLAYER'), SCOPE.PLAYER)
  })
})

describe('hatókörök', () => {
  it('a global mindenre illik, a web szerveroldalon semmire', () => {
    assert.equal(scopeMatches(SCOPE.GLOBAL, '/akarmi'), true)
    // A `web` a kliens felületéről szól; a szerver végpontokat zár, nem
    // képernyőket.
    assert.equal(scopeMatches(SCOPE.WEB, '/v1/anime'), false)
  })

  it('az útvonalhoz tartozó területek', () => {
    assert.deepEqual(scopesFor('/v1/anime/episodes/abc'), ['api', 'player', 'catalog'])
    assert.deepEqual(scopesFor('/v1/admin/config'), ['api', 'admin'])
    assert.deepEqual(scopesFor('/v1/comments/1'), ['api', 'comments'])
  })

  it('az ismeretlen végpontra csak a global hat', () => {
    // Egy új végpont maradjon elérhető, amíg valaki ki nem mondja, melyik
    // területhez tartozik. A csendben lezárt új funkció rosszabb.
    assert.deepEqual(scopesFor('/v1/valami-teljesen-uj'), ['api'])
    assert.equal(scopeMatches(SCOPE.PLAYER, '/v1/valami-teljesen-uj'), false)
  })

  it('az előtag nem illeszthet félbe egy nevet', () => {
    // A `/v1/searching` NEM a `/v1/search` alá tartozik.
    assert.equal(scopeMatches(SCOPE.SEARCH, '/v1/search'), true)
    assert.equal(scopeMatches(SCOPE.SEARCH, '/v1/search/advanced'), true)
    assert.equal(scopeMatches(SCOPE.SEARCH, '/v1/searching'), false)
  })

  it('a lekérdezés nem zavarja meg', () => {
    assert.equal(scopeMatches(SCOPE.SEARCH, '/v1/search?q=bleach'), true)
  })
})

describe('ütemezés', () => {
  const window = { startsAt: at('2026-09-20T02:00:00Z'), endsAt: at('2026-09-20T04:00:00Z') }

  it('a határok fél-nyitottak', () => {
    // A kezdés pillanata már BENNE van, a befejezésé már NINCS. Csak így nem
    // fedi át magát két egymás utáni ablak, és nem is hagy ki egy pillanatot.
    assert.equal(phaseAt(window, at('2026-09-20T01:59:59Z')), PHASE.BEFORE)
    assert.equal(phaseAt(window, at('2026-09-20T02:00:00Z')), PHASE.DURING)
    assert.equal(phaseAt(window, at('2026-09-20T03:59:59Z')), PHASE.DURING)
    assert.equal(phaseAt(window, at('2026-09-20T04:00:00Z')), PHASE.AFTER)
  })

  it('a lejárt karbantartás MAGÁTÓL véget ér', () => {
    // Ez a legfontosabb állítás az egész ütemezésben: worker nélkül is.
    assert.equal(effectiveMode(MODE.ACTIVE, window, at('2026-09-20T05:00:00Z')), MODE.OFF)
  })

  it('az ablak előtt ütemezett, nem aktív', () => {
    assert.equal(effectiveMode(MODE.ACTIVE, window, at('2026-09-20T01:00:00Z')), MODE.SCHEDULED)
  })

  it('a vészhelyzet nem ütemezhető és nem jár le', () => {
    // Egy magától feloldódó vészlezárás pont az a meglepetés, amit nem
    // akarunk.
    assert.equal(effectiveMode(MODE.EMERGENCY, window, at('2026-09-01T00:00:00Z')), MODE.EMERGENCY)
    assert.equal(effectiveMode(MODE.EMERGENCY, window, at('2026-10-01T00:00:00Z')), MODE.EMERGENCY)
  })

  it('nyitott ablak: kezdés nélkül azonnal, vég nélkül örökké', () => {
    const open = { startsAt: null, endsAt: null }
    assert.equal(effectiveMode(MODE.ACTIVE, open, at('2026-09-20T03:00:00Z')), MODE.ACTIVE)
    assert.equal(secondsUntilChange(MODE.ACTIVE, open, at('2026-09-20T03:00:00Z')), null)
  })

  it('a hátralévő idő a következő változásig szól', () => {
    assert.equal(secondsUntilChange(MODE.ACTIVE, window, at('2026-09-20T01:59:00Z')), 60)
    assert.equal(secondsUntilChange(MODE.ACTIVE, window, at('2026-09-20T03:59:00Z')), 60)
  })

  it('a nyári időszámítás nem tud elrontani semmit', () => {
    /*
     * A tárolt érték ABSZOLÚT PILLANAT, nem „helyi idő plusz zóna". A DST a
     * megjelenítésben látszik, a számításban nem.
     *
     * 2026. október 25-én hajnali 3-kor Magyarországon óraátállítás van.
     * Ugyanaz a pillanat előtte CEST, utána CET — a döntés mindkettőn azonos.
     */
    const dst = { startsAt: at('2026-10-25T00:30:00Z'), endsAt: at('2026-10-25T02:30:00Z') }
    assert.equal(effectiveMode(MODE.ACTIVE, dst, at('2026-10-25T00:00:00Z')), MODE.SCHEDULED)
    assert.equal(effectiveMode(MODE.ACTIVE, dst, at('2026-10-25T01:00:00Z')), MODE.ACTIVE)
    assert.equal(effectiveMode(MODE.ACTIVE, dst, at('2026-10-25T03:00:00Z')), MODE.OFF)

    const before = formatInZone(dst.startsAt, 'Europe/Budapest')
    const after = formatInZone(dst.endsAt, 'Europe/Budapest')
    assert.ok(before && after)
    // A két pillanat két óra különbség, de a kiírt helyi óra csak egyet lép —
    // pontosan ezt csinálja az átállítás.
    assert.match(before, /02:30/)
    assert.match(after, /03:30/)
  })

  it('az elrontott dátumból nem lesz 1970', () => {
    assert.equal(toDate('nem-dátum'), null)
    assert.equal(toDate(''), null)
    assert.equal(toDate(null), null)
    assert.equal(toDate(new Date('x')), null)
    assert.ok(toDate('2026-09-20T02:00:00Z') instanceof Date)
  })

  it('a rossz időzónanév nem némítja el a tájékoztatást', () => {
    assert.ok(formatInZone(at('2026-09-20T02:00:00Z'), 'Nincs/Ilyen'))
    assert.equal(formatInZone(null, 'Europe/Budapest'), null)
  })
})

describe('a döntés', () => {
  it('kikapcsolva mindenki mehet', () => {
    assert.equal(ask({}, config({ enabled: false })).kind, DECISION.ALLOW)
    assert.equal(ask({}, config({ mode: MODE.OFF })).kind, DECISION.ALLOW)
  })

  it('ütemezett alatt még minden működik', () => {
    const scheduled = config({ window: { startsAt: at('2026-09-20T05:00:00Z'), endsAt: null } })
    const decision = ask({}, scheduled)
    assert.equal(decision.kind, DECISION.ALLOW)
    assert.equal(decision.mode, MODE.SCHEDULED)
  })

  it('teljes karbantartás alatt a látogató nem megy be', () => {
    const decision = ask({})
    assert.equal(decision.kind, DECISION.BLOCK)
    assert.equal(decision.mode, MODE.ACTIVE)
    assert.ok(decision.retryAfter && decision.retryAfter > 0)
  })

  it('a mindig nyitott útvonalak nyitva maradnak', () => {
    // Enélkül nem lehetne KIJÖNNI: az irányítórendszer halottnak hinné a
    // szolgáltatást, és a karbantartási oldal sem tudná megkérdezni, vége
    // van-e már.
    for (const url of ['/v1/health', '/v1/health/ready', '/v1/status', '/v1/config']) {
      assert.equal(ask({ url }).kind, DECISION.ALLOW, url)
    }
  })

  /*
   * A LAP SAJÁT MÉDIÁJA IS NYITVA MARAD.
   *
   * A karbantartási oldal egy `<video>` lejátszót rajzol `/assets/videos/...`
   * forrással. A kapu viszont azt is 503-mal utasította vissza — böngészőben
   * lemérve —, tehát a látogató egy vezérlőkkel ellátott, de soha meg nem
   * szólaló fekete dobozt kapott. A hibaoldal nem kérhet olyat, amit a saját
   * kapunk visszautasít.
   */
  it('a karbantartási oldal médiája nem akad fenn a saját kapuján', () => {
    for (const url of ['/assets/videos/amv-counting-stars.mp4', '/assets/yume.svg', '/assets']) {
      assert.equal(ask({ url }).kind, DECISION.ALLOW, url)
    }
  })

  it('de az `/assets`-re hasonlító útvonal nem nyílik ki', () => {
    // Előtagegyezés, nem „tartalmazza": egy `/v1/assets-export` nem média.
    assert.equal(ask({ url: '/assetsmuhely' }).kind, DECISION.BLOCK)
    assert.equal(ask({ url: '/v1/assets-export' }).kind, DECISION.BLOCK)
  })

  it('a saját rendszerünket soha nem zárja ki', () => {
    const decision = ask({ internal: true })
    assert.equal(decision.kind, DECISION.ALLOW)
    assert.equal(decision.bypass, 'internal')
  })

  it('a személyzet bemehet', () => {
    assert.equal(ask({ roles: ['admin'] }).kind, DECISION.ALLOW)
    assert.equal(ask({ roles: ['moderator'] }).kind, DECISION.ALLOW)
    assert.equal(ask({ roles: ['user'] }).kind, DECISION.BLOCK)
  })

  it('VÉSZHELYZETBEN a szerep önmagában kevés', () => {
    // A vészhelyzet oka lehet épp egy feltört admin fiók. Ott a
    // helyreállítási útvonal és a jegy a két út.
    const emergency = config({ mode: MODE.EMERGENCY })
    assert.equal(ask({ roles: ['admin'] }, emergency).kind, DECISION.BLOCK)
    assert.equal(ask({ roles: ['admin'], url: '/v1/admin/maintenance' }, emergency).kind, DECISION.ALLOW)
    assert.equal(ask({ hasBypassToken: true }, emergency).kind, DECISION.ALLOW)
  })

  it('az adminból mindig ki lehet kapcsolni — nincs egyirányú ajtó', () => {
    for (const mode of [MODE.ACTIVE, MODE.EMERGENCY, MODE.READ_ONLY, MODE.DEGRADED]) {
      const decision = ask(
        { url: '/v1/admin/maintenance', method: 'POST', roles: ['admin'] },
        config({ mode })
      )
      assert.equal(decision.kind, DECISION.ALLOW, `${mode} alatt nem lehetett kikapcsolni`)
    }
  })

  it('a bejelentkezés vészhelyzetben is működik', () => {
    // Ha a belépés zárva volna, egy kijelentkezett admin sosem tudna
    // visszajönni feloldani.
    assert.equal(
      ask({ url: '/v1/auth/login', method: 'POST' }, config({ mode: MODE.EMERGENCY })).kind,
      DECISION.ALLOW
    )
  })

  it('csak olvasható: az olvasás megy, az írás nem', () => {
    const ro = config({ mode: MODE.READ_ONLY })
    assert.equal(ask({ method: 'GET' }, ro).kind, DECISION.ALLOW)
    assert.equal(ask({ method: 'HEAD' }, ro).kind, DECISION.ALLOW)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(ask({ method, url: '/v1/comments' }, ro).kind, DECISION.READ_ONLY, method)
    }
  })

  it('részleges: csak a lezárt terület esik ki', () => {
    const degraded = config({ mode: MODE.DEGRADED, scope: SCOPE.PLAYER })
    assert.equal(ask({ url: '/v1/anime/episodes/1' }, degraded).kind, DECISION.BLOCK)
    assert.equal(ask({ url: '/v1/search?q=x' }, degraded).kind, DECISION.ALLOW)
    assert.equal(ask({ url: '/v1/comments' }, degraded).kind, DECISION.ALLOW)
  })

  it('a hatókörön kívüli útvonalat teljes karbantartás sem érinti', () => {
    const player = config({ mode: MODE.ACTIVE, scope: SCOPE.PLAYER })
    assert.equal(ask({ url: '/v1/search?q=x' }, player).kind, DECISION.ALLOW)
    assert.equal(ask({ url: '/v1/anime/episodes/1' }, player).kind, DECISION.BLOCK)
  })

  it('a döntés sosem árul el belső részletet a látogatónak', () => {
    // Az indok a naplóé. A tesztje az, hogy nincs benne olyan, aminek a
    // válaszban nem lenne helye.
    const decision = ask({})
    for (const leak of ['postgres', 'select', '/opt/', 'password', 'token']) {
      assert.ok(!decision.reason.toLowerCase().includes(leak), decision.reason)
    }
  })
})

describe('kiürítés', () => {
  const start = at('2026-09-20T03:00:00Z')
  const draining = config({
    window: { startsAt: start, endsAt: null },
    allowExistingSessions: true,
    drainSeconds: 300
  })

  it('a bent lévő még kap időt, az új nem jön be', () => {
    const during = at('2026-09-20T03:02:00Z')
    assert.equal(withinDrain(draining, during, { url: '/', method: 'GET', hasSession: true }), true)
    assert.equal(withinDrain(draining, during, { url: '/', method: 'GET', hasSession: false }), false)
  })

  it('a kiürítés után a bent lévő is kiesik', () => {
    const after = at('2026-09-20T03:06:00Z')
    assert.equal(withinDrain(draining, after, { url: '/', method: 'GET', hasSession: true }), false)
    assert.equal(ask({ hasSession: true }, draining, after).kind, DECISION.BLOCK)
  })

  it('a karbantartás UTÁN indult munkamenet nem „meglévő"', () => {
    // Enélkül egy friss bejelentkezés is türelmi időt kapna, és a kiürítés
    // sosem érne véget.
    const during = at('2026-09-20T03:02:00Z')
    assert.equal(withinDrain(draining, during, {
      url: '/', method: 'GET', hasSession: true, sessionStartedAt: at('2026-09-20T03:01:00Z')
    }), false)
  })

  it('kikapcsolt kiürítésnél nincs türelmi idő', () => {
    const strict = config({ window: { startsAt: start, endsAt: null }, allowExistingSessions: false, drainSeconds: 300 })
    assert.equal(withinDrain(strict, at('2026-09-20T03:02:00Z'), { url: '/', method: 'GET', hasSession: true }), false)
  })

  it('ismeretlen kezdésnél a türelmi idő nem létezik, nem végtelen', () => {
    const noStart = config({ window: { startsAt: null, endsAt: null }, allowExistingSessions: true, drainSeconds: 300 })
    assert.equal(withinDrain(noStart, at('2026-09-20T03:02:00Z'), { url: '/', method: 'GET', hasSession: true }), false)
  })
})

describe('újrapróbálkozás', () => {
  it('ismert befejezésnél a hátralévő idő megy vissza', () => {
    const cfg = config({ window: { startsAt: null, endsAt: at('2026-09-20T03:05:00Z') } })
    assert.equal(ask({}, cfg).retryAfter, 300)
  })

  it('ismeretlen befejezésnél egy józan alapérték', () => {
    assert.equal(ask({}).retryAfter, DEFAULT_RETRY_SECONDS)
  })

  it('az átengedett kérés nem kap újrapróbálkozási időt', () => {
    assert.equal(ask({ internal: true }).retryAfter, null)
  })
})
