// A slash parancsok új része — címkiegészítés, gombok, /next, nyelv,
// a /notifications kapcsoló, a /announce csatornaellenőrzése, a parancsok
// szinkronja és a kézbesítés felismerése.
//
// VALÓDI ADATBÁZISSAL: egy regisztrált YUME-fiók (a profiljával), egy
// összekötött Discord-azonosító és két saját próbacím. A Discordot a `fetch`
// szintjén hamisítjuk — a kezelők valódi kódja fut.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'discord-interactions-secret-long-enough-0123456789'

let commands: typeof import('../src/modules/discord/commands.ts')
let rest: typeof import('../src/modules/discord/rest-client.ts')
let pool: typeof import('../src/infrastructure/database/index.ts')['pool']
let app: Awaited<ReturnType<typeof import('../src/app.ts')['buildApp']>>

const GUILD = '400000000000000888'
const MASIK_GUILD = '400000000000000999'
const TOKEN = 'interakcio-proba-token-NEM-VALODI'
const jel = randomBytes(4).toString('hex')
const CIM_A = `Próbacím Alfa ${jel}`
const CIM_B = `Próbacím Béta ${jel}`
const username = 'dcint' + jel
const discordId = '5' + String(Date.now()).padEnd(17, '0').slice(0, 17)
let animeA = ''
let animeB = ''
let epizodB2 = ''
let profileId = ''

function interakcio (extra: Partial<import('../src/modules/discord/commands.ts').Interaction> = {}): never {
  return {
    id: '500000000000000002',
    token: 'interakcio-token',
    applicationId: '500000000000000003',
    type: 2,
    guildId: GUILD,
    channelId: '600000000000000002',
    userId: discordId,
    username: 'proba',
    permissions: '0',
    memberRoles: [],
    command: 'help',
    sub: null,
    options: {},
    focused: null,
    customId: null,
    locale: null,
    guildLocale: null,
    ...extra
  } as never
}

/** A válasz szövege: tartalom vagy az első embed címe + leírása. */
const szoveg = (r: unknown): string => {
  const d = (r as { data?: { content?: string, embeds?: Array<{ title?: string, description?: string }> } }).data ?? {}
  return [d.content, d.embeds?.[0]?.title, d.embeds?.[0]?.description].filter(Boolean).join(' | ')
}

describe('a slash parancsok új része', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    const [{ buildApp }, db] = await Promise.all([
      import('../src/app.ts'), import('../src/infrastructure/database/index.ts')
    ])
    commands = await import('../src/modules/discord/commands.ts')
    rest = await import('../src/modules/discord/rest-client.ts')
    pool = db.pool
    app = await buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST', url: '/v1/auth/register',
      payload: { email: `${username}@example.com`, username, password: 'Correct-Horse-Battery-9' }
    })
    assert.equal(res.statusCode, 201, res.body)
    await pool.query('INSERT INTO discord_links (user_id, discord_user_id) SELECT id, $2 FROM users WHERE username = $1',
      [username, discordId])
    profileId = (await pool.query<{ id: string }>(
      'SELECT p.id FROM user_profiles p JOIN users u ON u.id = p.user_id WHERE u.username = $1', [username])).rows[0]!.id

    animeA = (await pool.query<{ id: string }>(
      `INSERT INTO anime (canonical_title, format, status, visibility, season_year)
       VALUES ($1, 'TV', 'RELEASING', 'public', 2026) RETURNING id`, [CIM_A])).rows[0]!.id
    animeB = (await pool.query<{ id: string }>(
      `INSERT INTO anime (canonical_title, format, status, visibility)
       VALUES ($1, 'TV', 'RELEASING', 'public') RETURNING id`, [CIM_B])).rows[0]!.id
    await pool.query("INSERT INTO episodes (anime_id, number, visibility) VALUES ($1, 1, 'public')", [animeB])
    epizodB2 = (await pool.query<{ id: string }>(
      "INSERT INTO episodes (anime_id, number, visibility) VALUES ($1, 2, 'public') RETURNING id", [animeB])).rows[0]!.id
  })

  beforeEach(async () => {
    commands.resetCooldowns()
    await pool.query('DELETE FROM library_entries WHERE profile_id = $1', [profileId])
    await pool.query('DELETE FROM watch_progress WHERE profile_id = $1', [profileId])
  })

  afterEach(() => {
    mock.restoreAll()
    rest.forgetApplicationInfo()
  })

  after(async () => {
    try {
      await pool?.query('DELETE FROM discord_links WHERE discord_user_id = $1', [discordId])
      await pool?.query('DELETE FROM users WHERE username = $1', [username])
      await pool?.query('DELETE FROM anime WHERE id = ANY($1::uuid[])', [[animeA, animeB].filter(Boolean)])
      await pool?.query("DELETE FROM discord_registry WHERE guild_id = $1", [GUILD])
    } finally {
      await app?.close()
    }
  })

  // ---- bemenet ----

  it('a nyers interakcióból a gépelt mezőt, a gombot, a rangokat és a nyelvet is kiolvassa', () => {
    const i = commands.parseInteraction({
      id: '1'.repeat(18), token: 'tok', type: 4, guild_id: GUILD, locale: 'en-US', guild_locale: 'hu',
      member: { roles: ['7'.repeat(18)], permissions: '0', user: { id: '2'.repeat(18) } },
      data: { name: 'watchlist', options: [{ type: 1, name: 'add', options: [{ type: 3, name: 'cim', value: 'nar', focused: true }] }] }
    })
    assert.equal(i?.focused, 'cim')
    assert.equal(i?.options.cim, 'nar')
    assert.deepEqual(i?.memberRoles, ['7'.repeat(18)])
    assert.equal(i?.locale, 'en-US')
    const gomb = commands.parseInteraction({ id: '1'.repeat(18), token: 't', type: 3, user: { id: '2'.repeat(18) }, data: { custom_id: 'wl:cancel' } })
    assert.equal(gomb?.customId, 'wl:cancel')
  })

  // ---- címkiegészítés ----

  it('a címkiegészítés a katalógusból javasol, és az érték az anime azonosítója', async () => {
    const r = await commands.autocomplete(interakcio({
      type: 4, command: 'anime', sub: 'info', focused: 'cim', options: { cim: `Alfa ${jel}` }
    })) as { type: number, data: { choices: Array<{ name: string, value: string }> } }
    assert.equal(r.type, commands.RESPONSE.AUTOCOMPLETE_RESULT)
    assert.deepEqual(r.data.choices, [{ name: `${CIM_A} (2026)`, value: animeA }])
  })

  it('a kiválasztott javaslat pontos találat — az azonosítóra keres, nem a címre', async () => {
    const e = await commands.handle(interakcio({ command: 'anime', sub: 'info', options: { cim: animeA } }))
    assert.equal(e.outcome, 'ok')
    assert.match(szoveg(e.response), new RegExp(CIM_A))
  })

  it('a keresés a % és _ jeleket betű szerint érti', async () => {
    const e = await commands.handle(interakcio({ command: 'anime', sub: 'search', options: { cim: '%%' } }))
    assert.match(szoveg(e.response), /Nincs találat/)
  })

  // ---- /watchlist add + gombok ----

  it('a /watchlist add megerősítést kér, és a gomb a saját könyvtárba ír', async () => {
    const kerdes = await commands.handle(interakcio({ command: 'watchlist', sub: 'add', options: { cim: animeA } }))
    const gombok = (kerdes.response as { data: { components: Array<{ components: Array<{ custom_id: string }> }> } })
      .data.components[0]!.components.map(c => c.custom_id)
    assert.deepEqual(gombok, [`wl:add:${animeA}`, 'wl:cancel'])
    // A kérdés még nem írt semmit.
    assert.equal((await pool.query('SELECT 1 FROM library_entries WHERE profile_id = $1', [profileId])).rows.length, 0)

    const valasz = await commands.handleComponent(interakcio({ type: 3, customId: `wl:add:${animeA}` }))
    assert.equal((valasz.response as { type: number }).type, commands.RESPONSE.UPDATE_MESSAGE)
    assert.match(szoveg(valasz.response), /Hozzáadva/)
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM library_entries WHERE profile_id = $1 AND anime_id = $2', [profileId, animeA])
    assert.equal(rows[0]?.status, 'PLANNING')
  })

  it('ami már a könyvtárban van, annak az állapotát a gomb nem írja át', async () => {
    await pool.query("INSERT INTO library_entries (profile_id, anime_id, status) VALUES ($1, $2, 'WATCHING')", [profileId, animeA])
    const valasz = await commands.handleComponent(interakcio({ type: 3, customId: `wl:add:${animeA}` }))
    assert.match(szoveg(valasz.response), /Ez már a könyvtáradban van.*nézem/)
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM library_entries WHERE profile_id = $1 AND anime_id = $2', [profileId, animeA])
    assert.equal(rows[0]?.status, 'WATCHING')
  })

  it('a Mégse nem ír semmit, az ismeretlen gomb nem csinál semmit', async () => {
    assert.match(szoveg((await commands.handleComponent(interakcio({ type: 3, customId: 'wl:cancel' }))).response), /nem adtam hozzá/)
    const ismeretlen = await commands.handleComponent(interakcio({ type: 3, customId: 'wl:add:nem-uuid' }))
    assert.equal(ismeretlen.outcome, 'unknown')
    assert.equal((await pool.query('SELECT 1 FROM library_entries WHERE profile_id = $1', [profileId])).rows.length, 0)
  })

  it('összekötés nélkül a gomb sem ír, csak megmondja, hol kell összekötni', async () => {
    const valasz = await commands.handleComponent(interakcio({ type: 3, customId: `wl:add:${animeA}`, userId: '599999999999999999' }))
    assert.match(szoveg(valasz.response), /nincs YUME-fiók kötve.*#\/settings\?tab=account/s)
  })

  // ---- /next ----

  it('a /next a félbehagyott részt adja, a pozícióval', async () => {
    await pool.query(
      `INSERT INTO watch_progress (profile_id, episode_id, anime_id, position_sec, duration_sec)
       VALUES ($1, $2, $3, 754, 1420)`, [profileId, epizodB2, animeB])
    const e = await commands.handle(interakcio({ command: 'next' }))
    const t = szoveg(e.response)
    assert.match(t, new RegExp(`Folytasd: ${CIM_B} — 2\\. rész`))
    assert.match(t, /12:34/)
    const url = (e.response as { data: { embeds: Array<{ url: string }> } }).data.embeds[0]!.url
    assert.match(url, new RegExp(`#/watch/${epizodB2}$`))
  })

  it('félbehagyott rész nélkül a „nézem" cím következő részét adja — vagy megmondja, hogy még nincs kint', async () => {
    await pool.query("INSERT INTO library_entries (profile_id, anime_id, status, progress) VALUES ($1, $2, 'WATCHING', 1)", [profileId, animeB])
    assert.match(szoveg((await commands.handle(interakcio({ command: 'next' }))).response), /Következik: .* — 2\. rész/)
    commands.resetCooldowns()
    await pool.query('UPDATE library_entries SET progress = 2 WHERE profile_id = $1 AND anime_id = $2', [profileId, animeB])
    assert.match(szoveg((await commands.handle(interakcio({ command: 'next' }))).response), /3\. rész még nem jelent meg/)
  })

  it('üres könyvtárral a /next nem talál ki semmit', async () => {
    assert.match(szoveg((await commands.handle(interakcio({ command: 'next' }))).response), /Nincs folyamatban lévő sorozatod/)
  })

  // ---- nyelv ----

  it('angol kliensnek angolul válaszol, magyarnak magyarul', async () => {
    assert.match(szoveg((await commands.handle(interakcio({ command: 'anime', sub: 'search', options: { cim: 'x' }, locale: 'en-US' }))).response),
      /Type at least two characters/)
    commands.resetCooldowns()
    assert.match(szoveg((await commands.handle(interakcio({ command: 'anime', sub: 'search', options: { cim: 'x' }, locale: 'hu' }))).response),
      /két karakter/)
  })

  it('minden parancsnak van angol leírása', () => {
    for (const d of commands.DEFINITIONS) {
      const lok = (d as { description_localizations?: Record<string, string> }).description_localizations
      assert.ok(lok?.['en-US'] && lok['en-US'].length <= 100, `${d.name}: nincs angol leírás`)
    }
  })

  // ---- /notifications kapcsoló ----

  describe('a Discordot hívó parancsok', () => {
    const RANG = '400000000000000777'
    let elozo: string | undefined
    before(async () => {
      elozo = process.env.DISCORD_BOT_TOKEN
      process.env.DISCORD_BOT_TOKEN = TOKEN
      await pool.query(
        `INSERT INTO discord_registry (guild_id, object_type, logical_key, discord_object_id, created_by_yume)
         VALUES ($1, 'role', 'role:notifications', $2, true)
         ON CONFLICT DO NOTHING`, [GUILD, RANG])
    })
    after(() => {
      if (elozo === undefined) delete process.env.DISCORD_BOT_TOKEN
      else process.env.DISCORD_BOT_TOKEN = elozo
    })

    const hivasok = (): Array<{ method: string, url: string }> => {
      const lista: Array<{ method: string, url: string }> = []
      mock.method(globalThis, 'fetch', async (url: string, init?: { method?: string }) => {
        lista.push({ method: init?.method ?? 'GET', url: String(url) })
        return { ok: true, status: 204, headers: { get: () => null }, json: async () => { throw new Error('üres') } }
      })
      return lista
    }

    it('a /notifications felrakja a rangot, ha nincs rajta — és leveszi, ha rajta van', async () => {
      const fel = hivasok()
      assert.match(szoveg((await commands.handle(interakcio({ command: 'notifications' }))).response), /Megkaptad/)
      assert.deepEqual(fel.map(h => h.method), ['PUT'])
      assert.match(fel[0]!.url, new RegExp(`/members/${discordId}/roles/${RANG}$`))
      mock.restoreAll()

      commands.resetCooldowns()
      const le = hivasok()
      assert.match(szoveg((await commands.handle(interakcio({ command: 'notifications', memberRoles: [RANG] }))).response), /Levettem/)
      assert.deepEqual(le.map(h => h.method), ['DELETE'])
    })

    it('a /announce idegen szerver csatornájába nem küld', async () => {
      const lista: string[] = []
      mock.method(globalThis, 'fetch', async (url: string, init?: { method?: string }) => {
        lista.push(`${init?.method ?? 'GET'} ${String(url)}`)
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: '600000000000000009', guild_id: MASIK_GUILD }) }
      })
      const e = await commands.handle(interakcio({
        command: 'announce', permissions: String(1n << 5n), options: { csatorna: '600000000000000009', szoveg: 'Hahó' }
      }))
      assert.match(szoveg(e.response), /nem ehhez a szerverhez tartozik/)
      assert.ok(!lista.some(h => h.startsWith('POST')), 'mégis küldött az idegen csatornába')
    })

    // ---- szinkron és kézbesítés ----

    /** A Discord így adja vissza: azonosítóval, verzióval, kiegészített mezőkkel, a hamis értékek nélkül. */
    const discordAlak = (): Array<Record<string, unknown>> => JSON.parse(JSON.stringify(commands.DEFINITIONS))
      .map((d: Record<string, unknown>, n: number) => ({
        id: String(700000000000000000n + BigInt(n)), application_id: '500000000000000003', version: '1', type: 1,
        nsfw: false, contexts: null, default_member_permissions: d.default_member_permissions ?? null, ...d
      }))

    it('a Discord kiegészített alakját ugyanannak látja, egy átírt leírást nem', () => {
      assert.equal(commands.azonos(discordAlak()), true)
      const mas = discordAlak()
      mas[0]!.description = 'Valami más'
      assert.equal(commands.azonos(mas), false)
      assert.equal(commands.azonos(discordAlak().slice(1)), false, 'egy hiányzó parancsot nem vett észre')
    })

    it('a szinkron csak eltérésnél tölt fel', async () => {
      const valaszok = (fent: unknown): string[] => {
        const lista: string[] = []
        mock.method(globalThis, 'fetch', async (url: string, init?: { method?: string }) => {
          lista.push(`${init?.method ?? 'GET'} ${String(url).replace('https://discord.com/api/v10', '')}`)
          const body = String(url).endsWith('/applications/@me') ? { id: '500000000000000003' } : fent
          return { ok: true, status: 200, headers: { get: () => null }, json: async () => body }
        })
        return lista
      }
      const egyezo = valaszok(discordAlak())
      assert.equal(await commands.sync(GUILD), 'unchanged')
      assert.ok(!egyezo.some(h => h.startsWith('PUT')), 'változatlan készletet is feltöltött')
      mock.restoreAll()

      const regi = valaszok(discordAlak().slice(2))
      assert.equal(await commands.sync(GUILD), 'updated')
      assert.ok(regi.some(h => h.startsWith(`PUT /applications/500000000000000003/guilds/${GUILD}/commands`)))
    })

    it('felismeri, ha a Discord a parancsokat HTTP-végpontra küldi', async () => {
      mock.method(globalThis, 'fetch', async () => ({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ id: '500000000000000003', interactions_endpoint_url: 'https://pelda.example/interactions' })
      }))
      assert.deepEqual(await commands.deliveryStatus(), { mode: 'http', endpointUrl: 'https://pelda.example/interactions' })
      mock.restoreAll()
      rest.forgetApplicationInfo()
      mock.method(globalThis, 'fetch', async () => ({
        ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: '500000000000000003', interactions_endpoint_url: null })
      }))
      assert.deepEqual(await commands.deliveryStatus(), { mode: 'gateway', endpointUrl: null })
    })
  })
})
