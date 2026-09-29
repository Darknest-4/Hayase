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
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test'

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
    for (const c of ['view_stats', 'manage_bot', 'manage_guild', 'manage_channels', 'manage_roles'] as const) {
      assert.equal(perms.can(tag(0n, true), c), true, `a tulajdonostól megtagadta: ${c}`)
    }
  })

  it('az ADMINISTRATOR mindent felülír', () => {
    for (const c of ['view_stats', 'manage_bot', 'manage_guild', 'manage_channels', 'manage_roles'] as const) {
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
    for (const c of ['view_stats', 'manage_bot', 'manage_guild', 'manage_channels', 'manage_roles'] as const) {
      assert.equal(perms.can(tag(0n), c), false, `jogosultság nélkül megadta: ${c}`)
    }
  })

  it('a MANAGE_GUILD adja a statisztikát és a bot kezelését', () => {
    const t = tag(P().MANAGE_GUILD)
    assert.equal(perms.can(t, 'view_stats'), true)
    assert.equal(perms.can(t, 'manage_bot'), true)
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

describe('a guild-szintű jog a rangokból', () => {
  const GUILD = '800000000000000001'
  const MOD = '800000000000000002'
  const DJ = '800000000000000003'

  /*
   * UGYANAZ AZ ÉRTÉK, AMIT AZ OAUTH AD: az `@everyone` rang (azonosítója a
   * guildé) és a tag rangjainak VAGY-olt összege. A lejárt tagságot a bot
   * ebből frissíti — ha itt tévedünk, a kapu rossz jogra dönt.
   */
  it('az @everyone és a tag rangjai összeadódnak', () => {
    const rangok = [
      { id: GUILD, permissions: String(P().VIEW_CHANNEL) },
      { id: MOD, permissions: String(P().MANAGE_GUILD) },
      { id: DJ, permissions: String(P().SEND_MESSAGES) }
    ]
    assert.equal(perms.basePermissions(GUILD, rangok, [MOD]), P().VIEW_CHANNEL | P().MANAGE_GUILD)
    assert.equal(perms.basePermissions(GUILD, rangok, []), P().VIEW_CHANNEL, 'rang nélkül is jár az @everyone')
  })

  it('az ismeretlen rang semmit nem ad', () => {
    const rangok = [{ id: GUILD, permissions: '0' }]
    assert.equal(perms.basePermissions(GUILD, rangok, ['800000000000000099']), 0n)
  })

  it('a 2^53 fölötti biteket sem veszíti el', () => {
    const nagy = (1n << 40n) | P().MANAGE_GUILD
    assert.equal(perms.basePermissions(GUILD, [{ id: MOD, permissions: nagy.toString() }], [MOD]), nagy)
  })

  it('az időkorlátozott tag a megtekintésen kívül mindent elveszít — az adminisztrátor nem', () => {
    const rangok = [
      { id: GUILD, permissions: String(P().VIEW_CHANNEL) },
      { id: MOD, permissions: String(P().MANAGE_GUILD) }
    ]
    assert.equal(perms.basePermissions(GUILD, rangok, [MOD], { timedOut: true }), P().VIEW_CHANNEL)
    const admin = [{ id: MOD, permissions: String(P().ADMINISTRATOR) }]
    assert.equal(perms.basePermissions(GUILD, admin, [MOD], { timedOut: true }), P().ADMINISTRATOR)
  })

  // A régi név („manage_messages") soha nem az üzenetkezelés jogát nézte; az
  // átnevezés után nem nyithat semmit.
  it('a régi képességnév már nem nyit kaput', () => {
    assert.equal(perms.can({ owner: false, permissions: P().MANAGE_GUILD }, 'manage_messages' as never), false)
  })
})

describe('a globális sebességkorlát', () => {
  const TITOK = 'ez-egy-proba-token-NEM-VALODI-0123456789'
  const GUILD = '850000000000000001'
  let elozo: string | undefined

  before(() => { elozo = process.env.DISCORD_BOT_TOKEN; process.env.DISCORD_BOT_TOKEN = TITOK })
  after(() => {
    if (elozo === undefined) delete process.env.DISCORD_BOT_TOKEN
    else process.env.DISCORD_BOT_TOKEN = elozo
  })
  beforeEach(() => { rest.resetGlobalPause() })
  afterEach(() => { mock.restoreAll(); rest.resetGlobalPause() })

  /** Az első válasz a megadott 429, utána minden 200; a hívások ideje naplózva. */
  const korlat = (body: Record<string, unknown>, fejlecek: Record<string, string> = {}) => {
    const hivasok: number[] = []
    mock.method(globalThis, 'fetch', async () => {
      hivasok.push(Date.now())
      if (hivasok.length === 1) {
        return { ok: false, status: 429, headers: { get: (n: string) => fejlecek[n.toLowerCase()] ?? null }, json: async () => body }
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => [] }
    })
    return hivasok
  }

  /*
   * EDDIG CSAK AZ A HÍVÁS VÁRT, amelyik a 429-et kapta; a többi — más
   * végpontra — ment tovább, és sorra 429-et kapott.
   */
  it('globális 429 után a többi végpont is kivárja a szünetet', async () => {
    const hivasok = korlat({ global: true, retry_after: 0.08, message: 'You are being rate limited.' })
    assert.equal(await rest.fetchGuild(GUILD), null)
    await rest.fetchChannels(GUILD)
    assert.equal(hivasok.length, 2)
    assert.ok(hivasok[1]! - hivasok[0]! >= 70, `a második hívás nem várt: ${hivasok[1]! - hivasok[0]!} ms`)
  })

  it('a hosszú szünet alatt a Discordhoz sem fordul, azonnal hibázik', async () => {
    const hivasok = korlat({ global: true, retry_after: 60 })
    await rest.fetchGuild(GUILD)
    await assert.rejects(() => rest.createRestClient().send('850000000000000002', { content: 'x' }),
      (e: Error & { kind?: string, retryAfterMs?: number }) => {
        assert.equal(e.kind, 'rate_limited')
        assert.ok(Number(e.retryAfterMs) > 15_000)
        return true
      })
    assert.equal(hivasok.length, 1, 'a szünet alatt is a Discordhoz fordult')
  })

  it('a fejléc is jelezheti a globális korlátot', async () => {
    korlat({ retry_after: 5 }, { 'x-ratelimit-scope': 'global' })
    await rest.fetchGuild(GUILD)
    assert.ok(rest.globalPauseLeft() > 4000)
  })

  it('a végpontszintű 429 nem állít meg mindent', async () => {
    korlat({ global: false, retry_after: 5 }, { 'x-ratelimit-scope': 'user' })
    await rest.fetchGuild(GUILD)
    assert.equal(rest.globalPauseLeft(), 0)
  })
})

describe('a tagjog lekérdezése a bot tokenjével', () => {
  const TITOK = 'ez-egy-proba-token-NEM-VALODI-0123456789'
  const GUILD = '810000000000000001'
  const TAG = '810000000000000002'
  const MOD = '810000000000000003'

  /** Hamis Discord: a guild (rangok, tulajdonos) és a tag (rangjai). */
  const discord = (valaszok: { guild?: [number, unknown], tag?: [number, unknown] }) => {
    const hivasok: string[] = []
    mock.method(globalThis, 'fetch', async (url: string) => {
      hivasok.push(String(url))
      const [status, body] = String(url).includes('/members/')
        ? (valaszok.tag ?? [200, { roles: [] }])
        : (valaszok.guild ?? [200, { id: GUILD, name: 'Próba', owner_id: '1', roles: [] }])
      return { ok: status < 400, status, json: async () => body }
    })
    return hivasok
  }

  const tokennel = async (fn: () => Promise<void>) => {
    const elozo = process.env.DISCORD_BOT_TOKEN
    process.env.DISCORD_BOT_TOKEN = TITOK
    try {
      await fn()
    } finally {
      mock.restoreAll()
      if (elozo === undefined) delete process.env.DISCORD_BOT_TOKEN
      else process.env.DISCORD_BOT_TOKEN = elozo
    }
  }

  it('a rangokból kiszámolja a jogot', async () => {
    await tokennel(async () => {
      discord({
        guild: [200, { id: GUILD, name: 'Próba szerver', owner_id: '1', roles: [{ id: GUILD, permissions: '0' }, { id: MOD, permissions: '32' }] }],
        tag: [200, { roles: [MOD] }]
      })
      const r = await rest.memberAccess(GUILD, TAG)
      assert.equal(r.status, 'ok')
      assert.ok(r.status === 'ok')
      assert.equal(r.permissions, P().MANAGE_GUILD)
      assert.equal(r.owner, false)
      assert.equal(r.guildName, 'Próba szerver')
    })
  })

  it('a tulajdonost a guild adataiból ismeri fel', async () => {
    await tokennel(async () => {
      discord({ guild: [200, { id: GUILD, owner_id: TAG, roles: [] }], tag: [200, { roles: [] }] })
      const r = await rest.memberAccess(GUILD, TAG)
      assert.ok(r.status === 'ok' && r.owner === true, 'a tulajdonost nem ismerte fel')
    })
  })

  // CSAK a 10007 jelenti, hogy nem tag: a bot láthatja úgy is a szervert.
  it('a 10007 = nem tag; a 403 és az ismeretlen guild = nem tudjuk', async () => {
    await tokennel(async () => {
      discord({ tag: [404, { code: 10007, message: 'Unknown Member' }] })
      assert.equal((await rest.memberAccess(GUILD, TAG)).status, 'not_member')
      mock.restoreAll()
      discord({ tag: [403, { code: 50001, message: 'Missing Access' }] })
      assert.equal((await rest.memberAccess(GUILD, TAG)).status, 'unknown')
      mock.restoreAll()
      discord({ guild: [404, { code: 10004, message: 'Unknown Guild' }], tag: [404, { code: 10004 }] })
      assert.equal((await rest.memberAccess(GUILD, TAG)).status, 'unknown', 'a bot hiányát tagság hiányának vette')
      mock.restoreAll()
      discord({ guild: [500, {}] })
      assert.equal((await rest.memberAccess(GUILD, TAG)).status, 'unknown')
    })
  })

  it('az időkorlátozott tag nem kezelheti a szervert', async () => {
    await tokennel(async () => {
      discord({
        guild: [200, { id: GUILD, owner_id: '1', roles: [{ id: MOD, permissions: '32' }] }],
        tag: [200, { roles: [MOD], communication_disabled_until: new Date(Date.now() + 3_600_000).toISOString() }]
      })
      const r = await rest.memberAccess(GUILD, TAG)
      assert.ok(r.status === 'ok')
      assert.equal(perms.can({ owner: r.owner, permissions: r.permissions }, 'view_stats'), false)
    })
  })

  it('token nélkül nem kérdez, és nem is állít semmit', async () => {
    const elozo = process.env.DISCORD_BOT_TOKEN
    delete process.env.DISCORD_BOT_TOKEN
    const hivasok = discord({})
    try {
      assert.equal((await rest.memberAccess(GUILD, TAG)).status, 'unknown')
      assert.equal(hivasok.length, 0)
    } finally {
      mock.restoreAll()
      if (elozo !== undefined) process.env.DISCORD_BOT_TOKEN = elozo
    }
  })

  it('érvénytelen azonosítóval nem megy ki kérés', async () => {
    await tokennel(async () => {
      const hivasok = discord({})
      assert.equal((await rest.memberAccess('../../applications/@me', TAG)).status, 'unknown')
      assert.equal((await rest.memberAccess(GUILD, '12')).status, 'unknown')
      assert.equal(hivasok.length, 0)
    })
  })

  it('a bot szervereit lapozva gyűjti össze', async () => {
    await tokennel(async () => {
      const elso = Array.from({ length: 200 }, (_, n) => ({ id: String(820000000000000000n + BigInt(n)), name: `G${n}` }))
      const hivasok: string[] = []
      mock.method(globalThis, 'fetch', async (url: string) => {
        hivasok.push(String(url))
        const body = String(url).includes('after=') ? [{ id: '830000000000000001', name: 'Utolsó' }] : elso
        return { ok: true, status: 200, json: async () => body }
      })
      const lista = await rest.botGuilds()
      assert.equal(lista?.length, 201)
      assert.equal(hivasok.length, 2)
      assert.match(hivasok[1]!, /after=820000000000000199/)
    })
  })

  it('a bot szerverlistája hibánál null, nem üres', async () => {
    await tokennel(async () => {
      mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500, json: async () => ({}) }))
      assert.equal(await rest.botGuilds(), null)
    })
  })

  /*
   * A HALASZTOTT VÁLASZ KITÖLTÉSE az interakció tokenjével megy, nem a bot
   * tokenjével; a láthatóság (`flags`) a halasztáskor dőlt el.
   */
  it('a halasztott válasz kitöltése: jó cím, láthatóság és bot token nélkül', async () => {
    await tokennel(async () => {
      let latott: { url: string, init: RequestInit } | null = null
      mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
        latott = { url: String(url), init }
        return { ok: true, status: 200, json: async () => ({}) }
      })
      const ok = await rest.editOriginalResponse('840000000000000001', 'interakcio/token', { content: 'kész', flags: 64 })
      assert.equal(ok, true)
      const l = latott as unknown as { url: string, init: RequestInit }
      assert.equal(l.url, 'https://discord.com/api/v10/webhooks/840000000000000001/interakcio%2Ftoken/messages/@original')
      assert.equal(l.init.method, 'PATCH')
      assert.deepEqual(JSON.parse(String(l.init.body)), { content: 'kész' })
      assert.ok(!JSON.stringify(l.init.headers).includes(TITOK), 'a bot tokenje is kiment')
    })
  })
})
