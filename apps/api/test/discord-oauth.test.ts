// Discord OAuth — fiók-összekötés.
//
// EZ NEM BEJELENTKEZÉS. A felhasználó már be van jelentkezve a YUME-ba, és
// itt hozzákapcsolja a Discord-fiókját. Ezért a folyamat nem hoz létre
// munkamenetet és nem ad ki tokent.
//
// A KÉSZLET LEGFONTOSABB ÁLLÍTÁSA A `state`. Enélkül egy támadó a SAJÁT
// Discord-fiókjának engedélyezési kódjával nyithatná meg az áldozat
// visszairányítási címét — és onnantól az áldozat YUME-fiókjához a TÁMADÓ
// Discord-fiókja lenne kötve. Az áldozat a saját guildjeit látná, a támadó
// nevében.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it, mock } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'discord-oauth-test-secret-long-enough-0123456789'

let oauth: typeof import('../src/modules/discord/oauth.ts')
let db: typeof import('../src/infrastructure/database/index.ts')
let app: Awaited<ReturnType<typeof import('../src/app.ts')['buildApp']>>

let userA = ''
let userB = ''
let idA = ''
let idB = ''
let tokenA = ''

const TITOK = 'oauth-proba-secret-NEM-VALODI-0123456789'

const beallitva = async <T>(fn: () => Promise<T>): Promise<T> => {
  const e1 = process.env.DISCORD_CLIENT_ID
  const e2 = process.env.DISCORD_CLIENT_SECRET
  process.env.DISCORD_CLIENT_ID = '123456789012345678'
  process.env.DISCORD_CLIENT_SECRET = TITOK
  try { return await fn() } finally {
    if (e1 === undefined) delete process.env.DISCORD_CLIENT_ID; else process.env.DISCORD_CLIENT_ID = e1
    if (e2 === undefined) delete process.env.DISCORD_CLIENT_SECRET; else process.env.DISCORD_CLIENT_SECRET = e2
  }
}

describe('a Discord OAuth', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    oauth = await import('../src/modules/discord/oauth.ts')
    db = await import('../src/infrastructure/database/index.ts')
    const { buildApp } = await import('../src/app.ts')
    app = await buildApp()
    await app.ready()

    const reg = async (nev: string) => {
      const res = await app.inject({
        method: 'POST', url: '/v1/auth/register',
        payload: { email: `${nev}@example.com`, username: nev, password: 'Correct-Horse-Battery-9' }
      })
      return String(res.json().accessToken ?? res.json().token)
    }
    userA = 'oauthA' + randomBytes(4).toString('hex')
    userB = 'oauthB' + randomBytes(4).toString('hex')
    tokenA = await reg(userA)
    await reg(userB)
    idA = (await db.queryOne<{ id: string }>('SELECT id FROM users WHERE username = $1', [userA]))!.id
    idB = (await db.queryOne<{ id: string }>('SELECT id FROM users WHERE username = $1', [userB]))!.id
  })

  beforeEach(async () => {
    await db.query('DELETE FROM discord_oauth_states WHERE user_id IN ($1, $2)', [idA, idB])
    await db.query('DELETE FROM discord_links WHERE user_id IN ($1, $2)', [idA, idB])
    mock.restoreAll()
  })

  after(async () => {
    await db.query('DELETE FROM users WHERE username IN ($1, $2)', [userA, userB])
    await app?.close()
  })

  // ---- a `state` ----

  it('az állapot EGYSZER használható', async () => {
    const state = await oauth.createState(idA)
    assert.equal(await oauth.consumeState(state), idA)
    assert.equal(await oauth.consumeState(state), null, 'másodszor is beváltható volt')
  })

  /*
   * KÉT EGYIDEJŰ BEVÁLTÁSBÓL EGY SIKERÜL. A „megnézem, majd törlöm" minta
   * versenyben mindkettőnek igazat mondana — az egyetlen
   * `DELETE … RETURNING` nem.
   */
  it('két egyidejű beváltásból csak az egyik sikerül', async () => {
    const state = await oauth.createState(idA)
    const [a, b] = await Promise.all([oauth.consumeState(state), oauth.consumeState(state)])
    assert.equal([a, b].filter(Boolean).length, 1, `mindkettő beváltotta: ${a}, ${b}`)
  })

  it('a lejárt állapot nem váltható be', async () => {
    const state = await oauth.createState(idA)
    await db.query("UPDATE discord_oauth_states SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [idA])
    assert.equal(await oauth.consumeState(state), null)
  })

  it('ismeretlen és hibás állapotot elutasít', async () => {
    for (const rossz of ['', 'rovid', 'a'.repeat(64), 'nem-letezo-allapot-0123456789']) {
      assert.equal(await oauth.consumeState(rossz), null, `elfogadta: ${rossz}`)
    }
  })

  /*
   * AZ ÁLLAPOT NEM NYERSEN VAN TÁROLVA. Egy adatbázis-kiolvasás így sem ad
   * használható kulcsot — ugyanaz az elv, mint a jelszavaknál.
   */
  it('az állapotot hashelve tárolja, nem nyersen', async () => {
    const state = await oauth.createState(idA)
    const sorok = await db.query<{ state_hash: string }>(
      'SELECT state_hash FROM discord_oauth_states WHERE user_id = $1', [idA])
    assert.equal(sorok.length, 1)
    assert.notEqual(sorok[0]!.state_hash, state, 'nyersen tárolta az állapotot')
    assert.match(sorok[0]!.state_hash, /^[0-9a-f]{64}$/)
  })

  it('a lejárt állapotokat nyesi', async () => {
    await oauth.createState(idA)
    await db.query("UPDATE discord_oauth_states SET expires_at = now() - interval '1 day' WHERE user_id = $1", [idA])
    assert.ok(await oauth.pruneStates() >= 1)
  })

  // ---- az engedélyezési cím ----

  it('csak azt kéri, amire szükség van', async () => {
    await beallitva(async () => {
      const url = new URL(oauth.authorizeUrl(await oauth.createState(idA)))
      const scope = String(url.searchParams.get('scope')).split(' ')
      assert.deepEqual(scope.sort(), ['guilds', 'identify'])
      for (const felesleges of ['email', 'connections', 'guilds.members.read', 'bot']) {
        assert.ok(!scope.includes(felesleges), `fölösleges engedélyt kér: ${felesleges}`)
      }
    })
  })

  it('a titok NEM kerül az engedélyezési címbe', async () => {
    await beallitva(async () => {
      const url = oauth.authorizeUrl(await oauth.createState(idA))
      assert.ok(!url.includes(TITOK), 'a client secret a címbe került — az minden naplóba bekerülne')
      assert.ok(url.includes('123456789012345678'), 'a client id hiányzik (az nyilvános)')
    })
  })

  /*
   * A VISSZAIRÁNYÍTÁSI CÍM RÖGZÍTETT, nem a kérésből származik. Ha a `Host`
   * fejlécből épülne, egy hamisított fejléc a Discord engedélyezési kódját
   * idegen címre vinné.
   */
  it('a visszairányítási cím rögzített és https', async () => {
    const uri = oauth.redirectUri()
    assert.match(uri, /^https:\/\//)
    assert.match(uri, /discord\.animehub\.hu/)
  })

  // ---- a fiók összekötése ----

  const discordValasz = (userId: string, guilds: unknown[] = []) => {
    mock.method(globalThis, 'fetch', async (url: string) => {
      const u = String(url)
      if (u.includes('/oauth2/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'proba-access-token' }) }
      }
      if (u.endsWith('/users/@me')) {
        return { ok: true, status: 200, json: async () => ({ id: userId, username: 'probauser' }) }
      }
      if (u.includes('/users/@me/guilds')) {
        return { ok: true, status: 200, json: async () => guilds }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    })
  }

  it('összeköti a fiókot és eltárolja a guildeket', async () => {
    await beallitva(async () => {
      discordValasz('300000000000000001', [
        { id: '400000000000000001', name: 'Egyik', owner: true, permissions: '8' },
        { id: '400000000000000002', name: 'Másik', owner: false, permissions: '32' }
      ])
      const r = await oauth.completeLink(idA, 'proba-kod')
      assert.equal(r.discordUserId, '300000000000000001')
      assert.equal(r.guilds, 2)

      const tagsag = await db.query<{ guild_id: string, permissions: string }>(
        'SELECT guild_id, permissions FROM discord_guild_members WHERE discord_user_id = $1 ORDER BY guild_id',
        ['300000000000000001'])
      assert.equal(tagsag.length, 2)
      assert.equal(tagsag[0]!.permissions, '8', 'a jogosultsági bitmező elveszett')
    })
  })

  /*
   * EGY DISCORD-FIÓK EGY YUME-FIÓKHOZ. Enélkül a jogosultság-ellenőrzés
   * megkerülhető lenne egy második YUME-fiók létrehozásával: ugyanaz a
   * Discord-admin két néven lépne be.
   */
  it('ugyanazt a Discord-fiókot nem köti két YUME-fiókhoz', async () => {
    await beallitva(async () => {
      discordValasz('300000000000000009')
      await oauth.completeLink(idA, 'kod-1')
      await assert.rejects(() => oauth.completeLink(idB, 'kod-2'), /másik YUME-fiókhoz/)
    })
  })

  it('érvénytelen Discord-azonosítót elutasít', async () => {
    await beallitva(async () => {
      discordValasz('nem-szam')
      await assert.rejects(() => oauth.completeLink(idA, 'kod'), /érvénytelen azonosítót/)
    })
  })

  /*
   * A KILÉPETT SZERVER TAGSÁGA ELTŰNIK. Ha a régi sorok megmaradnának, a
   * vezérlőpult egy olyan guildhez engedne be, amihez már semmi köze.
   */
  it('a megszűnt tagságot törli az újraszinkronizálás', async () => {
    await beallitva(async () => {
      discordValasz('300000000000000011', [{ id: '400000000000000011', name: 'Régi', owner: true, permissions: '8' }])
      await oauth.completeLink(idA, 'kod-1')
      assert.equal((await db.query('SELECT 1 FROM discord_guild_members WHERE discord_user_id = $1', ['300000000000000011'])).length, 1)

      mock.restoreAll()
      discordValasz('300000000000000011', [])
      await oauth.completeLink(idA, 'kod-2')
      assert.equal((await db.query('SELECT 1 FROM discord_guild_members WHERE discord_user_id = $1', ['300000000000000011'])).length, 0,
        'a megszűnt tagság megmaradt')
    })
  })

  it('a hozzáférési tokent NEM tárolja el', async () => {
    await beallitva(async () => {
      discordValasz('300000000000000021')
      await oauth.completeLink(idA, 'kod')
      const sor = await db.queryOne<Record<string, unknown>>(
        'SELECT * FROM discord_links WHERE user_id = $1', [idA])
      const szoveg = JSON.stringify(sor)
      assert.ok(!szoveg.includes('proba-access-token'), 'eltárolta a hozzáférési tokent')
    })
  })

  it('az összekötés bontása a tagságot is elviszi', async () => {
    await beallitva(async () => {
      discordValasz('300000000000000031', [{ id: '400000000000000031', name: 'X', owner: true, permissions: '8' }])
      await oauth.completeLink(idA, 'kod')
      assert.equal(await oauth.unlink(idA), true)
      assert.equal((await db.query('SELECT 1 FROM discord_guild_members WHERE discord_user_id = $1', ['300000000000000031'])).length, 0)
      assert.equal(await oauth.unlink(idA), false, 'másodszor is sikert jelentett')
    })
  })

  // ---- végpontok ----

  it('beállítás nélkül 503-at ad, nem hazudik', async () => {
    const e1 = process.env.DISCORD_CLIENT_ID
    const e2 = process.env.DISCORD_CLIENT_SECRET
    delete process.env.DISCORD_CLIENT_ID
    delete process.env.DISCORD_CLIENT_SECRET
    try {
      const res = await app.inject({
        method: 'POST', url: '/v1/discord/oauth/start',
        headers: { authorization: `Bearer ${tokenA}` }
      })
      assert.equal(res.statusCode, 503)
    } finally {
      if (e1 !== undefined) process.env.DISCORD_CLIENT_ID = e1
      if (e2 !== undefined) process.env.DISCORD_CLIENT_SECRET = e2
    }
  })

  it('hitelesítés nélkül nem indítható', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/discord/oauth/start' })).statusCode, 401)
    assert.equal((await app.inject({ method: 'GET', url: '/v1/discord/oauth/link' })).statusCode, 401)
  })

  /*
   * A VISSZAIRÁNYÍTÁS NEM KÍVÁN HITELESÍTÉST, és ez szándékos: a Discord egy
   * átirányítással hozza ide a böngészőt, `Authorization` fejléc nélkül. A
   * hívót a `state` azonosítja — azt mi adtuk ki, egyszer használható.
   */
  it('a visszairányítás állapot nélkül nem köt össze semmit', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/discord/oauth/callback?code=x&state=nemletezo0123456789' })
    assert.equal(res.statusCode, 302)
    assert.match(String(res.headers.location), /link=expired/)
    // A CÉL A VEZÉRLŐPULT, nem a YUME adminpanelje: az a szekció már nem
    // létezik, és a néző egy olyan lapon kötne ki, ahol nem lát semmit.
    assert.match(String(res.headers.location), /#\/settings/)
    assert.equal(await oauth.linkOf(idA), null, 'állapot nélkül összekötött egy fiókot')
  })

  /*
   * A ZÁRT PÉLDÁNY KAPUJA NEM ZÁRHATJA KI A DISCORD VISSZAIRÁNYÍTÁSÁT.
   *
   * MÉRT HIBA. A Discord engedélyezési lapjáról a böngésző KERESZTOLDALI
   * átirányítással érkezik — `Authorization` fejléc nélkül, mert azt nem a mi
   * kliensünk küldi, és a munkamenet a `localStorage`-ban ül, nem sütiben. A
   * privát-példány kapu ezért 401-gyel utasította vissza, és a
   * fiók-összekötés zárt példányon SOHA nem tudott volna befejeződni —
   * akkor sem, ha minden titok a helyén van.
   *
   * Ez a tétel a kaput állítja zártra, és úgy méri.
   */
  it('zárt példányon is átmegy a visszairányítás', async () => {
    const { settings } = await import('../src/modules/settings/site-settings.ts')
    const eredeti = settings.requiresLogin.bind(settings)
    // A kapu a gyorsítótárazott olvasón át kérdez; itt azt mondatjuk vele,
    // hogy a példány zárt.
    settings.requiresLogin = async () => true
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/discord/oauth/callback?error=access_denied' })
      assert.equal(res.statusCode, 302, 'a zárt példány kapuja kizárta a Discord visszairányítását')
      assert.match(String(res.headers.location), /link=cancelled/)
    } finally {
      settings.requiresLogin = eredeti
    }
  })

  it('a többi Discord-végpont zárt példányon is hitelesítést kér', async () => {
    // A kivétel PONTOSAN egy útvonalra szól. Ha az előtagra szólna, a
    // vezérlőpult minden adata kifolyna egy zárt példányról.
    for (const url of ['/v1/discord/status', '/v1/discord/oauth/link']) {
      assert.equal((await app.inject({ url })).statusCode, 401, `${url} hitelesítés nélkül válaszolt`)
    }
  })

  it('az elutasított engedély nem hiba', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/discord/oauth/callback?error=access_denied' })
    assert.equal(res.statusCode, 302)
    assert.match(String(res.headers.location), /link=cancelled/)
  })

  it('a link-állapot csak azt a guildet mutatja, amihez van joga', async () => {
    await beallitva(async () => {
      discordValasz('300000000000000041', [
        { id: '400000000000000041', name: 'Vezetem', owner: false, permissions: '32' },
        { id: '400000000000000042', name: 'Csak tag', owner: false, permissions: '0' }
      ])
      await oauth.completeLink(idA, 'kod')
      const res = await app.inject({
        method: 'GET', url: '/v1/discord/oauth/link',
        headers: { authorization: `Bearer ${tokenA}` }
      })
      const body = res.json()
      assert.equal(body.linked, true)
      assert.equal(body.guilds.length, 1, 'olyan guildet is mutat, amihez nincs joga')
      assert.equal(body.guilds[0].id, '400000000000000041')
    })
  })
})
