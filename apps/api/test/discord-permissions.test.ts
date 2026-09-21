// Discord-jogosultságok és a REST-adapter.
//
// KÉT DOLGOT ŐRIZ EZ A KÉSZLET, és mindkettő csendben romlik el:
//
//   1. A JOGOSULTSÁGI BITEK 64 BITESEK. A JavaScript `number` 2^53 fölött
//      pontosságot veszít, a Discord bitjei pedig rég túl vannak ezen. Egy
//      `Number` alapú maszkolás a magasabb biteknél rossz eredményt ad — és
//      a hiba néma: a jogosultság egyszerűen hiányzónak látszik.
//
//   2. A BOT TOKEN NEM SZIVÁROGHAT. Sem naplóba, sem hibaüzenetbe, sem a
//      válaszba. Ezt nem elég „odafigyeléssel" megoldani, mérni kell.

import assert from 'node:assert/strict'
import { before, describe, it, mock } from 'node:test'

let perms: typeof import('../src/modules/discord/permissions.ts')
let rest: typeof import('../src/modules/discord/rest-client.ts')

const P = () => perms.PERMISSION_BITS

before(async () => {
  perms = await import('../src/modules/discord/permissions.ts')
  rest = await import('../src/modules/discord/rest-client.ts')
})

describe('a jogosultsági bitmező beolvasása', () => {
  it('sztringből olvas — a Discord így adja', () => {
    assert.equal(perms.parsePermissions('8'), 8n)
    assert.equal(perms.parsePermissions('2147483647'), 2147483647n)
  })

  /*
   * A MAGAS BITEK A LÉNYEG. A `MODERATE_MEMBERS` a 40. bit: az érték
   * 1099511627776, ami elfér egy `Number`-ben — de a Discord az ÖSSZES jogot
   * egyetlen mezőben küldi, és a teljes adminisztrátori maszk már rég a
   * biztonságos egész tartomány fölött van.
   */
  it('a 2^53 fölötti értéket sem veszíti el', () => {
    const nagy = (1n << 60n) | 8n
    const olvasva = perms.parsePermissions(nagy.toString())
    assert.equal(olvasva, nagy, 'a nagy bitmező csonkolódott')
    assert.equal(perms.hasBit(olvasva, 1n << 60n), true)
    assert.equal(perms.hasBit(olvasva, P().ADMINISTRATOR), true)
  })

  it('a hibás bemenetre nulla jár, nem kivétel', () => {
    for (const rossz of ['', '  ', 'nyolc', '-8', '8.5', null, undefined, {}, [], true]) {
      assert.equal(perms.parsePermissions(rossz), 0n, `elfogadta: ${String(rossz)}`)
    }
  })

  it('a biztonságos számot elfogadja, a nem biztonságosat nem', () => {
    assert.equal(perms.parsePermissions(8), 8n)
    assert.equal(perms.parsePermissions(Number.MAX_SAFE_INTEGER + 2), 0n,
      'olyan számot fogadott el, ami már pontatlan')
  })
})

describe('mit szabad a vezérlőpulton', () => {
  const tag = (permissions: bigint, owner = false) => ({ owner, permissions })

  /*
   * A TULAJDONOS ÉS AZ ADMINISZTRÁTOR MINDENT FELÜLÍR. Ha ezt a részjogok
   * UTÁN néznénk, egy hiányzó bit tévesen megtagadna valamit egy
   * adminisztrátortól — a Discord szerint viszont joga van hozzá.
   */
  it('a tulajdonosnak minden szabad', () => {
    for (const c of ['view_stats', 'manage_messages', 'manage_guild', 'manage_channels', 'manage_roles'] as const) {
      assert.equal(perms.can(tag(0n, true), c), true, `a tulajdonostól megtagadta: ${c}`)
    }
  })

  it('az ADMINISTRATOR mindent felülír', () => {
    for (const c of ['view_stats', 'manage_messages', 'manage_guild', 'manage_channels', 'manage_roles'] as const) {
      assert.equal(perms.can(tag(P().ADMINISTRATOR), c), true, `az adminisztrátortól megtagadta: ${c}`)
    }
  })

  /*
   * A NORMÁL TAG NEM LÁTJA A STATISZTIKÁT. Egy szerver taglétszáma,
   * aktivitási görbéje és csatornastatisztikája üzemeltetői adat — a 7.2.
   * pont szerint „Normál tag: ne kapjon dashboard-konfigurációs hozzáférést
   * alapértelmezés szerint".
   */
  it('a jogosultság nélküli tag semmit nem kap', () => {
    for (const c of ['view_stats', 'manage_messages', 'manage_guild', 'manage_channels', 'manage_roles'] as const) {
      assert.equal(perms.can(tag(0n), c), false, `jogosultság nélkül megadta: ${c}`)
    }
  })

  it('a MANAGE_GUILD adja a statisztikát és az üzenetkezelést', () => {
    const t = tag(P().MANAGE_GUILD)
    assert.equal(perms.can(t, 'view_stats'), true)
    assert.equal(perms.can(t, 'manage_messages'), true)
    assert.equal(perms.can(t, 'manage_guild'), true)
    // De NEM ad csatorna- vagy szerepkörkezelést.
    assert.equal(perms.can(t, 'manage_channels'), false)
    assert.equal(perms.can(t, 'manage_roles'), false)
  })

  it('a MANAGE_CHANNELS önmagában nem ad statisztikát', () => {
    const t = tag(P().MANAGE_CHANNELS)
    assert.equal(perms.can(t, 'manage_channels'), true)
    assert.equal(perms.can(t, 'view_stats'), false, 'csatornakezelésből statisztikát adott')
  })

  it('ismeretlen képességre nem', () => {
    assert.equal(perms.can(tag(P().MANAGE_GUILD), 'barmi_mas' as never), false)
    // …de a tulajdonos ág elé nem kerülhet: ott a Discord dönt.
    assert.equal(perms.can(tag(0n, true), 'barmi_mas' as never), true)
  })
})

describe('a beágyazott üzenet küldéséhez', () => {
  it('mind a három jog kell', () => {
    const { VIEW_CHANNEL, SEND_MESSAGES, EMBED_LINKS } = P()
    assert.equal(perms.canPostEmbed(VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS), true)
    // A `SEND_MESSAGES` önmagában kevés: embed nélkül üres üzenet menne ki.
    assert.equal(perms.canPostEmbed(VIEW_CHANNEL | SEND_MESSAGES), false)
    assert.equal(perms.canPostEmbed(SEND_MESSAGES | EMBED_LINKS), false)
    assert.equal(perms.canPostEmbed(0n), false)
  })

  it('megmondja, mi hiányzik', () => {
    assert.deepEqual(perms.missingForEmbed(0n).sort(),
      ['EMBED_LINKS', 'SEND_MESSAGES', 'VIEW_CHANNEL'])
    assert.deepEqual(perms.missingForEmbed(P().ADMINISTRATOR), [])
    assert.deepEqual(perms.missingForEmbed(P().VIEW_CHANNEL | P().SEND_MESSAGES), ['EMBED_LINKS'])
  })
})

describe('a REST-adapter és a token', () => {
  /*
   * A TOKEN SOHA NEM HAGYJA EL A MODULT. Ez nem „odafigyelés" kérdése: a
   * hívások fejlécében ott van, és egy gondatlan hibaüzenet vagy napló
   * kiírná. Ezért a mérés a TÉNYLEGES kimeneten megy — a kivétel szövegén és
   * mindenen, amit a modul kiad magából.
   */
  const TITOK = 'ez-egy-proba-token-NEM-VALODI-0123456789'

  it('token nélkül nem tesz úgy, mintha be lenne állítva', () => {
    const elozo = process.env.DISCORD_BOT_TOKEN
    delete process.env.DISCORD_BOT_TOKEN
    try {
      assert.equal(rest.isConfigured(), false)
      assert.equal(rest.botToken(), null)
    } finally {
      if (elozo !== undefined) process.env.DISCORD_BOT_TOKEN = elozo
    }
  })

  it('a token NEM jelenik meg a hibaüzenetben', async () => {
    const elozo = process.env.DISCORD_BOT_TOKEN
    process.env.DISCORD_BOT_TOKEN = TITOK
    mock.method(globalThis, 'fetch', async () => ({
      ok: false, status: 403,
      json: async () => ({ code: 50013, message: 'Missing Permissions' })
    }))
    try {
      const client = rest.createRestClient()
      await assert.rejects(
        () => client.send('123456789012345678', { content: 'x' }),
        (error: Error) => {
          const mindenSzoveg = `${error.message}\n${error.stack ?? ''}\n${JSON.stringify(error)}`
          assert.ok(!mindenSzoveg.includes(TITOK), 'a token kiszivárgott a hibába')
          return true
        })
    } finally {
      mock.restoreAll()
      if (elozo === undefined) delete process.env.DISCORD_BOT_TOKEN
      else process.env.DISCORD_BOT_TOKEN = elozo
    }
  })

  it('a tokent a fejlécbe teszi, nem a címbe', async () => {
    const elozo = process.env.DISCORD_BOT_TOKEN
    process.env.DISCORD_BOT_TOKEN = TITOK
    let latottUrl = ''
    let latottFejlec: Record<string, string> = {}
    mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      latottUrl = String(url)
      latottFejlec = (init.headers ?? {}) as Record<string, string>
      return { ok: true, status: 200, json: async () => ({ id: '999' }) }
    })
    try {
      await rest.createRestClient().send('123456789012345678', { content: 'x' })
      assert.ok(!latottUrl.includes(TITOK), 'a token a CÍMBE került — az minden proxynaplóba bekerül')
      assert.ok(String(latottFejlec.authorization).includes(TITOK), 'a token nem került a fejlécbe')
      assert.ok(latottUrl.startsWith('https://discord.com/api/'), `idegen cím: ${latottUrl}`)
    } finally {
      mock.restoreAll()
      if (elozo === undefined) delete process.env.DISCORD_BOT_TOKEN
      else process.env.DISCORD_BOT_TOKEN = elozo
    }
  })

  /*
   * AZ AZONOSÍTÓ AZ ÚTVONALBA KERÜL. Egy `../` belőle más végpontra vinné a
   * kérést — például a saját alkalmazásunk törlésére. A Discord azonosítói
   * csak számjegyek, tehát ez olcsó és teljes védelem.
   */
  it('nem enged érvénytelen azonosítót az útvonalba', async () => {
    const elozo = process.env.DISCORD_BOT_TOKEN
    process.env.DISCORD_BOT_TOKEN = TITOK
    let hivva = false
    mock.method(globalThis, 'fetch', async () => { hivva = true; return { ok: true, status: 200, json: async () => ({}) } })
    try {
      const client = rest.createRestClient()
      for (const rossz of ['../../applications/@me', '12', 'abc', '123456789012345678/../x', '', '1'.repeat(25)]) {
        await assert.rejects(() => client.send(rossz, {}), /azonosító/, `átengedte: ${rossz}`)
      }
      assert.equal(hivva, false, 'érvénytelen azonosítóval kiment a kérés')
    } finally {
      mock.restoreAll()
      if (elozo === undefined) delete process.env.DISCORD_BOT_TOKEN
      else process.env.DISCORD_BOT_TOKEN = elozo
    }
  })

  /*
   * A HIBA A KÓDRA ÉPÜL, NEM A SZÖVEGRE. A Discord `code` mezője stabil
   * szerződés; a `message` fordítható és változhat. Egy szövegre épülő
   * elágazás némán rossz ágra vinne — egy jogosultsági hibát
   * üzenet-újralétrehozásnak néznénk, és percenként küldenénk egy újat.
   */
  it('a Discord hibakódját sorolja be, nem a szövegét', async () => {
    const elozo = process.env.DISCORD_BOT_TOKEN
    process.env.DISCORD_BOT_TOKEN = TITOK
    const esetek: Array<[number, number | null, string]> = [
      [404, 10008, 'message_not_found'],
      [404, 10003, 'channel_not_found'],
      [403, 50013, 'forbidden'],
      [403, 50001, 'forbidden'],
      [429, null, 'rate_limited'],
      [500, null, 'transient'],
      [502, null, 'transient']
    ]
    try {
      for (const [status, code, vart] of esetek) {
        mock.method(globalThis, 'fetch', async () => ({
          ok: false, status,
          // A szöveg SZÁNDÉKOSAN félrevezető: ha a besorolás erre épülne,
          // minden esetben ugyanazt adná.
          json: async () => ({ ...(code !== null ? { code } : {}), message: 'valami egészen más' })
        }))
        await assert.rejects(
          () => rest.createRestClient().edit('123456789012345678', '123456789012345678', {}),
          (e: Error & { kind?: string }) => {
            assert.equal(e.kind, vart, `${status}/${code} → ${e.kind}, várt: ${vart}`)
            return true
          })
        mock.restoreAll()
      }
    } finally {
      mock.restoreAll()
      if (elozo === undefined) delete process.env.DISCORD_BOT_TOKEN
      else process.env.DISCORD_BOT_TOKEN = elozo
    }
  })

  it('a rate limit várakozási idejét átveszi', async () => {
    const elozo = process.env.DISCORD_BOT_TOKEN
    process.env.DISCORD_BOT_TOKEN = TITOK
    mock.method(globalThis, 'fetch', async () => ({
      ok: false, status: 429, json: async () => ({ retry_after: 2.5, message: 'rate limited' })
    }))
    try {
      await assert.rejects(
        () => rest.createRestClient().send('123456789012345678', {}),
        (e: Error & { retryAfterMs?: number }) => {
          assert.equal(e.retryAfterMs, 2500, 'a másodpercet nem váltotta ezredmásodpercre')
          return true
        })
    } finally {
      mock.restoreAll()
      if (elozo === undefined) delete process.env.DISCORD_BOT_TOKEN
      else process.env.DISCORD_BOT_TOKEN = elozo
    }
  })
})
