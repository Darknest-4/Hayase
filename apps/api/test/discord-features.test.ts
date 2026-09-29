// A Discord-bot új funkciói (2026-09-29): szerver-beállítások, hírfolyam-
// szűrők és animénkénti rang, a bot nyelve, DM-értesítés, szerepkör-szinkron,
// moderálás Discordból — és a hozzájuk tartozó végpontok.
//
// VALÓDI ADATBÁZISSAL (regisztrált fiókok, saját próbacímek, saját műfaj,
// hozzászólás és bejelentés), a Discordot a `fetch` szintjén hamisítva: a
// modulok valódi kódja fut, és azt mérjük, mit küldenének a Discordnak.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'discord-features-secret-long-enough-0123456789'

type Hivas = { method: string, path: string, body: Record<string, unknown> | null }

/** A hamis Discord: (metódus, útvonal, törzs) → [státusz, válasz]; ami nincs, arra 404. */
function hamisDiscord (kezelo: (method: string, path: string, body: Record<string, unknown> | null) => [number, unknown] | undefined): Hivas[] {
  const hivasok: Hivas[] = []
  mock.method(globalThis, 'fetch', async (url: string, init?: { method?: string, body?: string }) => {
    const path = String(url).replace('https://discord.com/api/v10', '')
    const method = init?.method ?? 'GET'
    let body: Record<string, unknown> | null = null
    try { body = init?.body ? JSON.parse(init.body) : null } catch { body = null }
    hivasok.push({ method, path, body })
    const [status, valasz] = kezelo(method, path, body) ?? [404, { code: 0, message: 'nincs a hamis Discordban' }]
    return { ok: status < 400, status, headers: { get: () => null }, json: async () => valasz }
  })
  return hivasok
}

describe('a Discord-bot új funkciói', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: Awaited<ReturnType<typeof import('../src/app.ts')['buildApp']>>
  let pool: typeof import('../src/infrastructure/database/index.ts')['pool']
  let commands: typeof import('../src/modules/discord/commands.ts')
  let feed: typeof import('../src/modules/discord/episode-feed.ts')
  let dm: typeof import('../src/modules/discord/dm-notify.ts')
  let roles: typeof import('../src/modules/discord/role-sync.ts')
  let mod: typeof import('../src/modules/discord/moderation-feed.ts')
  let settings: typeof import('../src/modules/discord/guild-settings.ts')
  let resolve: typeof import('../src/modules/moderation/resolve.ts')

  const jel = randomBytes(4).toString('hex')
  const GUILD = '410000000000000001'
  const MASIK = '410000000000000002'
  const FEED_CH = '420000000000000001'
  const MOD_CH = '420000000000000002'
  const LINKED = '430000000000000001'
  const MODROLE = '430000000000000002'
  const MANAGED = '430000000000000003'
  const id18 = (elo: string): string => elo + String(Date.now() + Math.floor(Math.random() * 1e6)).padEnd(17, '0').slice(0, 17)
  const MOD_DISCORD = id18('6')
  const TAG_DISCORD = id18('7')
  const nevek = { mod: 'dfmod' + jel, tag: 'dftag' + jel, admin: 'dfadm' + jel }
  const szerep = 'dfmodrole' + jel
  const mufaj = 'proba-mufaj-' + jel
  let modId = ''
  let tagId = ''
  let tagProfile = ''
  let adminToken = ''
  let tagToken = ''
  const anime: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' }
  let elozoToken: string | undefined

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([import('../src/app.ts'), import('../src/infrastructure/database/index.ts')])
    pool = db.pool
    commands = await import('../src/modules/discord/commands.ts')
    feed = await import('../src/modules/discord/episode-feed.ts')
    dm = await import('../src/modules/discord/dm-notify.ts')
    roles = await import('../src/modules/discord/role-sync.ts')
    mod = await import('../src/modules/discord/moderation-feed.ts')
    settings = await import('../src/modules/discord/guild-settings.ts')
    resolve = await import('../src/modules/moderation/resolve.ts')
    app = await buildApp()
    await app.ready()
    elozoToken = process.env.DISCORD_BOT_TOKEN
    process.env.DISCORD_BOT_TOKEN = 'features-proba-token-NEM-VALODI'

    const reg = async (nev: string): Promise<string> => {
      const res = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: `${nev}@example.com`, username: nev, password: 'Correct-Horse-Battery-9' } })
      assert.equal(res.statusCode, 201, res.body)
      return String(res.json().accessToken)
    }
    await reg(nevek.mod)
    tagToken = await reg(nevek.tag)
    adminToken = await reg(nevek.admin)
    const idOf = async (nev: string): Promise<string> => (await pool.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [nev])).rows[0]!.id
    modId = await idOf(nevek.mod)
    tagId = await idOf(nevek.tag)
    tagProfile = (await pool.query<{ id: string }>('SELECT id FROM user_profiles WHERE user_id = $1', [tagId])).rows[0]!.id

    // A moderátor YUME-szerepköre: community.moderate — a Discordon lévő rang nem számít.
    await pool.query('INSERT INTO roles (slug, name) VALUES ($1, $1)', [szerep])
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r, permissions p WHERE r.slug = $1 AND p.slug = 'community.moderate'`, [szerep])
    await pool.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE slug = $2', [modId, szerep])
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.username = $1 AND r.slug = 'admin'`,
      [nevek.admin])
    const auth = await import('../src/middleware/auth.ts')
    auth.invalidatePermissions()

    await pool.query('INSERT INTO discord_links (user_id, discord_user_id) VALUES ($1, $2), ($3, $4)', [modId, MOD_DISCORD, tagId, TAG_DISCORD])

    const szezon = feed.currentSeason()
    const uj = async (cim: string, season: string | null, year: number | null): Promise<string> => (await pool.query<{ id: string }>(
      `INSERT INTO anime (canonical_title, format, status, visibility, season, season_year)
       VALUES ($1, 'TV', 'RELEASING', 'public', $2::anime_season, $3) RETURNING id`, [cim, season, year])).rows[0]!.id
    anime.A = await uj(`Funkcióteszt A ${jel}`, szezon.season, szezon.year)
    anime.B = await uj(`Funkcióteszt B ${jel}`, 'WINTER', 1999)
    anime.C = await uj(`Funkcióteszt C ${jel}`, 'WINTER', 1999)
    const g = (await pool.query<{ id: number }>('INSERT INTO genres (slug, name) VALUES ($1, $1) RETURNING id', [mufaj])).rows[0]!.id
    await pool.query('INSERT INTO anime_genres (anime_id, genre_id) VALUES ($1, $3), ($2, $3)', [anime.A, anime.C, g])
  })

  beforeEach(async () => {
    commands.resetCooldowns()
    await pool.query('DELETE FROM discord_guild_settings WHERE guild_id IN ($1, $2)', [GUILD, MASIK])
    await pool.query('DELETE FROM discord_role_mappings WHERE guild_id = $1', [GUILD])
    await pool.query('DELETE FROM discord_anime_mentions WHERE guild_id = $1', [GUILD])
    await pool.query('DELETE FROM discord_episode_announcements WHERE guild_id = $1', [GUILD])
    await pool.query('DELETE FROM discord_role_sync WHERE guild_id = $1', [GUILD])
  })

  afterEach(() => { mock.restoreAll() })

  after(async () => {
    try {
      await pool?.query('DELETE FROM discord_guild_settings WHERE guild_id IN ($1, $2)', [GUILD, MASIK])
      await pool?.query('DELETE FROM discord_role_mappings WHERE guild_id = $1', [GUILD])
      await pool?.query('DELETE FROM discord_role_sync WHERE guild_id = $1', [GUILD])
      await pool?.query('DELETE FROM discord_episode_announcements WHERE guild_id = $1', [GUILD])
      await pool?.query('DELETE FROM discord_registry WHERE guild_id = $1', [GUILD])
      await pool?.query('DELETE FROM discord_moderation_messages WHERE guild_id = $1', [GUILD])
      await pool?.query('DELETE FROM discord_links WHERE discord_user_id IN ($1, $2)', [MOD_DISCORD, TAG_DISCORD])
      await pool?.query('DELETE FROM users WHERE username = ANY($1)', [Object.values(nevek)])
      await pool?.query('DELETE FROM roles WHERE slug = $1', [szerep])
      await pool?.query('DELETE FROM anime WHERE id = ANY($1::uuid[])', [Object.values(anime).filter(Boolean)])
      await pool?.query('DELETE FROM genres WHERE slug = $1', [mufaj])
    } finally {
      if (elozoToken === undefined) delete process.env.DISCORD_BOT_TOKEN
      else process.env.DISCORD_BOT_TOKEN = elozoToken
      await app?.close()
    }
  })

  // ---- szerver-beállítások ----

  it('a beállítás alapból magyar, és csak a megadott mező változik', async () => {
    assert.deepEqual(await settings.settingsOf(GUILD), settings.DEFAULT_SETTINGS)
    await settings.saveSettings(GUILD, { feedCurrentSeason: true })
    await settings.saveSettings(GUILD, { language: 'auto' })
    const s = await settings.settingsOf(GUILD)
    assert.equal(s.feedCurrentSeason, true, 'a nyelv mentése a szűrőt is felülírta')
    await settings.rememberLocale(GUILD, 'en-US')
    assert.equal(await settings.guildLanguage(GUILD), 'en')
    await settings.saveSettings(GUILD, { language: 'hu' })
    assert.equal(await settings.guildLanguage(GUILD), 'hu', 'a kifejezett magyar nyelvet a szerver nyelve felülírta')
  })

  // ---- hírfolyam ----

  describe('az új epizódok hírfolyama', () => {
    before(async () => {
      await pool.query(
        `INSERT INTO discord_registry (guild_id, object_type, logical_key, discord_object_id)
         VALUES ($1, 'channel', 'channel:uj-epizodok', $2) ON CONFLICT DO NOTHING`, [GUILD, FEED_CH])
      for (const a of [anime.A, anime.B, anime.C]) {
        await pool.query("INSERT INTO episodes (anime_id, number, visibility) VALUES ($1, 1, 'public')", [a])
      }
    })

    const kikuldott = (): Hivas[] => hamisDiscord((method, path) =>
      method === 'POST' && path === `/channels/${FEED_CH}/messages` ? [200, { id: '440000000000000001' }] : undefined)
    const cimek = (h: Hivas[]): string[] => h.filter(x => x.method === 'POST')
      .map(x => String(((x.body!.embeds as Array<{ title: string }>)[0]!).title)).sort()

    it('a műfajszűrő csak a megadott műfaj címeit engedi', async () => {
      await settings.saveSettings(GUILD, { feedGenres: [mufaj] })
      const h = kikuldott()
      await feed.announceNew(GUILD)
      assert.deepEqual(cimek(h), [`Funkcióteszt A ${jel}`, `Funkcióteszt C ${jel}`].sort())
    })

    it('az aktuális szezon szűrője a régi szezon címét kihagyja', async () => {
      await settings.saveSettings(GUILD, { feedGenres: [mufaj], feedCurrentSeason: true })
      const h = kikuldott()
      await feed.announceNew(GUILD)
      assert.deepEqual(cimek(h), [`Funkcióteszt A ${jel}`])
    })

    it('az animénkénti rangot említi — és csak azt', async () => {
      await settings.saveSettings(GUILD, { feedGenres: [mufaj], feedCurrentSeason: true })
      assert.equal(await settings.saveAnimeMention(GUILD, anime.A, LINKED), true)
      const h = kikuldott()
      await feed.announceNew(GUILD)
      const body = h.find(x => x.method === 'POST')!.body!
      assert.equal(body.content, `<@&${LINKED}>`)
      assert.deepEqual(body.allowed_mentions, { parse: [], roles: [LINKED] })
    })

    it('angol szerveren angolul jelent be', async () => {
      await settings.saveSettings(GUILD, { feedGenres: [mufaj], feedCurrentSeason: true, language: 'en' })
      const h = kikuldott()
      await feed.announceNew(GUILD)
      const mezok = ((h.find(x => x.method === 'POST')!.body!.embeds as Array<{ fields: Array<{ name: string }> }>)[0]!).fields
      assert.equal(mezok[0]!.name, '🎬 Episode')
    })
  })

  // ---- DM-értesítés ----

  describe('a DM-értesítés', () => {
    const DM_CH = '450000000000000001'
    const kezbesit = (ok = true): Hivas[] => hamisDiscord((method, path) => {
      if (method === 'POST' && path === '/users/@me/channels') return ok ? [200, { id: DM_CH }] : [403, { code: 50007, message: 'Cannot send messages to this user' }]
      if (method === 'POST' && path === `/channels/${DM_CH}/messages`) return [200, { id: '450000000000000002' }]
      return undefined
    })
    const ujResz = async (a: string, n: number): Promise<string> => (await pool.query<{ id: string }>(
      "INSERT INTO episodes (anime_id, number, visibility) VALUES ($1, $2, 'public') RETURNING id", [a, n])).rows[0]!.id

    beforeEach(async () => {
      await pool.query('DELETE FROM library_entries WHERE profile_id = $1', [tagProfile])
      await pool.query('DELETE FROM discord_dm_deliveries WHERE user_id = $1', [tagId])
      await pool.query("DELETE FROM user_settings WHERE profile_id = $1 AND key = 'language.ui'", [tagProfile])
      await dm.setDm(tagId, true)
    })

    it('csak a bekapcsolás UTÁN megjelent részről szól — egyszer', async () => {
      // A sorrend a lényeg: cím a könyvtárban → rész (még kikapcsolt DM mellett) → bekapcsolás → új rész.
      await dm.setDm(tagId, false)
      await pool.query("INSERT INTO library_entries (profile_id, anime_id, status) VALUES ($1, $2, 'WATCHING')", [tagProfile, anime.B])
      await ujResz(anime.B, 50)
      await dm.setDm(tagId, true)
      await ujResz(anime.B, 51)
      const h = kezbesit()
      assert.deepEqual(await dm.notifyNew(), { sent: 1, failed: 0, disabled: 0 }, 'a bekapcsolás előtti részről is szólt')
      const uzenet = h.find(x => x.path === `/channels/${DM_CH}/messages`)!.body!
      assert.match(String(uzenet.content), /Új rész jelent meg a könyvtáradból/)
      assert.match(String((uzenet.embeds as Array<{ fields: Array<{ value: string }> }>)[0]!.fields[0]!.value), /51\. rész/)
      assert.deepEqual(await dm.notifyNew(), { sent: 0, failed: 0, disabled: 0 }, 'ugyanarról kétszer szólt')
    })

    it('a könyvtárba vétel előtt megjelent részről nem szól', async () => {
      // Bekapcsolva (beforeEach) → rész → a cím csak utána kerül a könyvtárba.
      await ujResz(anime.B, 55)
      await pool.query("INSERT INTO library_entries (profile_id, anime_id, status) VALUES ($1, $2, 'WATCHING')", [tagProfile, anime.B])
      kezbesit()
      assert.equal((await dm.notifyNew()).sent, 0, 'a könyvtárba vétel előtti részről is szólt')
      await ujResz(anime.B, 56)
      assert.equal((await dm.notifyNew()).sent, 1)
    })

    // Két worker egyszerre ébred: a küldés előtti foglalás dönt, nem a lekérdezés.
    it('két egyszerre futó kör sem küld kétszer', async () => {
      await pool.query("INSERT INTO library_entries (profile_id, anime_id, status) VALUES ($1, $2, 'WATCHING')", [tagProfile, anime.B])
      await ujResz(anime.B, 58)
      const h = kezbesit()
      const [a, b] = await Promise.all([dm.notifyNew(), dm.notifyNew()])
      assert.equal(a.sent + b.sent, 1, `${a.sent + b.sent} DM ment ki egy részről`)
      assert.equal(h.filter(x => x.path === `/channels/${DM_CH}/messages`).length, 1)
    })

    it('a befejezett cím új részéről nem szól', async () => {
      await pool.query("INSERT INTO library_entries (profile_id, anime_id, status) VALUES ($1, $2, 'COMPLETED')", [tagProfile, anime.C])
      await ujResz(anime.C, 60)
      kezbesit()
      assert.equal((await dm.notifyNew()).sent, 0)
    })

    it('angol felületű felhasználónak angolul', async () => {
      await pool.query(`INSERT INTO user_settings (profile_id, key, value) VALUES ($1, 'language.ui', '"en"')`, [tagProfile])
      await pool.query("INSERT INTO library_entries (profile_id, anime_id, status) VALUES ($1, $2, 'PLANNING')", [tagProfile, anime.B])
      await ujResz(anime.B, 70)
      const h = kezbesit()
      await dm.notifyNew()
      assert.match(String(h.find(x => x.path === `/channels/${DM_CH}/messages`)!.body!.content), /A new episode is out/)
    })

    it('három sikertelen kézbesítés után a kapcsoló magától kikapcsol', async () => {
      await pool.query("INSERT INTO library_entries (profile_id, anime_id, status) VALUES ($1, $2, 'WATCHING')", [tagProfile, anime.B])
      for (const n of [80, 81, 82]) await ujResz(anime.B, n)
      kezbesit(false)
      const e = await dm.notifyNew()
      assert.equal(e.failed, 3)
      assert.equal(e.disabled, 1)
      const { rows } = await pool.query<{ dm_new_episodes: boolean }>('SELECT dm_new_episodes FROM discord_links WHERE user_id = $1', [tagId])
      assert.equal(rows[0]?.dm_new_episodes, false)
    })

    it('a főoldal kapcsolója: összekötött fióknak megy, összekötetlennek 404', async () => {
      const ki = await app.inject({ method: 'PATCH', url: '/v1/discord/oauth/link', headers: { authorization: `Bearer ${tagToken}` }, payload: { dmNewEpisodes: false } })
      assert.equal(ki.statusCode, 200)
      const allapot = await app.inject({ url: '/v1/discord/oauth/link', headers: { authorization: `Bearer ${tagToken}` } })
      assert.equal(allapot.json().dmNewEpisodes, false)
      const idegen = await app.inject({ method: 'PATCH', url: '/v1/discord/oauth/link', headers: { authorization: `Bearer ${adminToken}` }, payload: { dmNewEpisodes: true } })
      assert.equal(idegen.statusCode, 404)
    })
  })

  // ---- szerepkör-szinkron ----

  describe('a szerepkör-szinkron', () => {
    it('az elvárt rangok: összekötött + megfeleltetett; felfüggesztettnek semmi', () => {
      const beall = { linkedRoleId: LINKED, mappings: [{ yumeRole: szerep, discordRoleId: MODROLE }] }
      assert.deepEqual([...roles.desiredRoles({ active: true, yumeRoles: [szerep] }, beall)].sort(), [LINKED, MODROLE].sort())
      assert.deepEqual([...roles.desiredRoles({ active: true, yumeRoles: [] }, beall)], [LINKED])
      assert.deepEqual([...roles.desiredRoles({ active: false, yumeRoles: [szerep] }, beall)], [])
    })

    it('felrakja, ami jár, leveszi a kezeltet, ami nem jár — a kézzel adott más rangot nem bántja', async () => {
      await settings.saveSettings(GUILD, { linkedRoleId: LINKED })
      await settings.saveRoleMappings(GUILD, [{ yumeRole: szerep, discordRoleId: MODROLE }])
      const h = hamisDiscord((method, path) => {
        if (method === 'GET' && path === `/guilds/${GUILD}/members/${MOD_DISCORD}`) return [200, { roles: [] }]
        if (method === 'GET' && path === `/guilds/${GUILD}/members/${TAG_DISCORD}`) return [200, { roles: [MODROLE, '499999999999999999'] }]
        if (method === 'GET' && path.startsWith(`/guilds/${GUILD}/members/`)) return [404, { code: 10007, message: 'Unknown Member' }]
        if (method === 'PUT' || method === 'DELETE') return [204, {}]
        return undefined
      })
      await roles.syncRoles()
      const muveletek = h.filter(x => x.method !== 'GET').map(x => `${x.method} ${x.path}`).sort()
      assert.deepEqual(muveletek, [
        `DELETE /guilds/${GUILD}/members/${TAG_DISCORD}/roles/${MODROLE}`,
        `PUT /guilds/${GUILD}/members/${MOD_DISCORD}/roles/${LINKED}`,
        `PUT /guilds/${GUILD}/members/${MOD_DISCORD}/roles/${MODROLE}`,
        `PUT /guilds/${GUILD}/members/${TAG_DISCORD}/roles/${LINKED}`
      ].sort())
    })

    it('akinek a fiókja levált, attól a kezelt rang lekerül, és kikerül a nyilvántartásból', async () => {
      const LEVALT = id18('8')
      await settings.saveSettings(GUILD, { linkedRoleId: LINKED })
      await pool.query('INSERT INTO discord_role_sync (guild_id, discord_user_id) VALUES ($1, $2)', [GUILD, LEVALT])
      const h = hamisDiscord((method, path) => {
        if (method === 'GET' && path === `/guilds/${GUILD}/members/${LEVALT}`) return [200, { roles: [LINKED, '499999999999999999'] }]
        if (method === 'GET' && path.startsWith(`/guilds/${GUILD}/members/`)) return [200, { roles: [LINKED] }]
        if (method === 'DELETE') return [204, {}]
        return undefined
      })
      await roles.syncRoles()
      assert.ok(h.some(x => x.method === 'DELETE' && x.path === `/guilds/${GUILD}/members/${LEVALT}/roles/${LINKED}`))
      assert.ok(!h.some(x => x.method === 'DELETE' && x.path.endsWith('/roles/499999999999999999')), 'a nem kezelt rangot is levette')
      const { rows } = await pool.query('SELECT 1 FROM discord_role_sync WHERE guild_id = $1 AND discord_user_id = $2', [GUILD, LEVALT])
      assert.equal(rows.length, 0)
    })

    it('ha a Discord nem válaszol, semmihez nem nyúl', async () => {
      await settings.saveSettings(GUILD, { linkedRoleId: LINKED })
      const h = hamisDiscord(() => [500, {}])
      await roles.syncRoles()
      assert.ok(!h.some(x => x.method !== 'GET'), 'ismeretlen állapotnál is módosított')
    })
  })

  // ---- moderálás ----

  describe('a moderálás Discordból', () => {
    let reportId = ''
    let commentId = ''
    const ujBejelentes = async (): Promise<void> => {
      commentId = (await pool.query<{ id: string }>(
        `INSERT INTO comments (subject_type, subject_id, author_id, body) VALUES ('anime', $1, $2, 'Csúnya spoiler ${jel}') RETURNING id`,
        [anime.A, tagId])).rows[0]!.id
      reportId = (await pool.query<{ id: string }>(
        `INSERT INTO reports (reporter_id, subject_type, subject_id, reason) VALUES ($1, 'comment', $2, 'spoiler') RETURNING id`,
        [modId, commentId])).rows[0]!.id
    }
    beforeEach(async () => { await ujBejelentes() })

    /*
     * EGYSZERRE indítva: mindkettő még nyitottnak látja a bejelentést, és a
     * tranzakción belüli foglalás dönt — a második semmit nem talál, amit
     * lefoglalhatna, és nem írja felül az elsőt.
     */
    it('két egyidejű döntésből csak az egyik érvényes', async () => {
      const [a, b] = await Promise.all([
        resolve.resolveReport(reportId, 'hide', 'spoiler', { id: modId, username: nevek.mod }),
        resolve.resolveReport(reportId, 'dismiss', 'mégse', { id: modId, username: nevek.mod })
      ])
      assert.equal([a.ok, b.ok].filter(Boolean).length, 1, `mindkettő (${a.ok}/${b.ok}) — az egyik felülírta a másikat`)
      const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM moderation_actions WHERE report_id = $1', [reportId])
      assert.equal(rows[0]?.n, 1, 'két moderálási bejegyzés egy bejelentésre')
    })

    it('az új bejelentés a moderátori csatornába megy, gombokkal — a bejelentő neve nélkül', async () => {
      await settings.saveSettings(GUILD, { moderationChannelId: MOD_CH })
      const h = hamisDiscord((method, path) =>
        method === 'POST' && path === `/channels/${MOD_CH}/messages` ? [200, { id: '460000000000000001' }] : undefined)
      await mod.syncModeration()
      const kuldott = h.find(x => x.method === 'POST' && x.body && JSON.stringify(x.body).includes(reportId))
      assert.ok(kuldott, 'a bejelentés nem ment ki')
      const gombok = ((kuldott.body!.components as Array<{ components: Array<{ custom_id?: string }> }>)[0]!).components
        .map(g => g.custom_id).filter(Boolean)
      assert.deepEqual(gombok, [`mod:hide:${reportId}`, `mod:dismiss:${reportId}`])
      assert.ok(!JSON.stringify(kuldott.body).includes(nevek.mod), 'a bejelentő neve a Discordra került')
      assert.deepEqual(kuldott.body!.allowed_mentions, { parse: [] })
    })

    it('ha máshol döntöttek, az üzenet frissül, és a gombok eltűnnek', async () => {
      await settings.saveSettings(GUILD, { moderationChannelId: MOD_CH })
      hamisDiscord((method, path) => method === 'POST' && path === `/channels/${MOD_CH}/messages` ? [200, { id: '460000000000000002' }] : undefined)
      await mod.syncModeration()
      mock.restoreAll()
      await resolve.resolveReport(reportId, 'dismiss', 'nem spoiler', { id: modId, username: nevek.mod })
      const h = hamisDiscord((method, path) => method === 'PATCH' && path.startsWith(`/channels/${MOD_CH}/messages/`) ? [200, { id: '460000000000000002' }] : undefined)
      await mod.syncModeration()
      const szerk = h.find(x => x.method === 'PATCH')
      assert.ok(szerk, 'nem frissítette a lezárt bejelentés üzenetét')
      assert.deepEqual(szerk.body!.components, [])
    })

    const gomb = (userId: string, customId: string): never => ({
      id: '470000000000000001', token: 't', applicationId: '470000000000000002', type: 3, guildId: GUILD, channelId: MOD_CH,
      userId, username: 'x', permissions: '0', memberRoles: [], command: '', sub: null, options: {},
      focused: null, customId, locale: null, guildLocale: null
    }) as never

    it('nem moderátor gombnyomására csak neki válaszol, és nem nyit ablakot', async () => {
      const e = await commands.handleComponent(gomb(TAG_DISCORD, `mod:hide:${reportId}`))
      assert.equal(e.outcome, 'forbidden')
      const r = e.response as { type: number, data: { flags: number } }
      assert.equal(r.type, commands.RESPONSE.MESSAGE)
      assert.equal(r.data.flags, commands.EPHEMERAL)
    })

    it('a moderátor gombnyomása indoklás-ablakot nyit, az elküldése dönt és átírja az üzenetet', async () => {
      const ablak = await commands.handleComponent(gomb(MOD_DISCORD, `mod:hide:${reportId}`))
      const r = ablak.response as { type: number, data: { custom_id: string } }
      assert.equal(r.type, commands.RESPONSE.MODAL)
      assert.equal(r.data.custom_id, `modr:hide:${reportId}`)

      const kuld = { ...(gomb(MOD_DISCORD, `modr:hide:${reportId}`) as object), type: 5, options: { reason: 'Spoiler a címben' } } as never
      const e = await commands.handleModal(kuld)
      assert.equal(e.outcome, 'ok')
      const valasz = e.response as { type: number, data: { embeds: Array<{ description: string }>, components: unknown[] } }
      assert.equal(valasz.type, commands.RESPONSE.UPDATE_MESSAGE)
      assert.match(valasz.data.embeds[0]!.description, new RegExp(`Elrejtve — ${nevek.mod}.*Spoiler a címben`))
      assert.deepEqual(valasz.data.components, [])
      const { rows } = await pool.query<{ hidden: boolean, reason: string }>(
        `SELECT c.hidden_at IS NOT NULL AS hidden, a.reason FROM comments c
           JOIN moderation_actions a ON a.report_id = $1 WHERE c.id = $2`, [reportId, commentId])
      assert.deepEqual(rows[0], { hidden: true, reason: 'Spoiler a címben' })

      // Ugyanaz még egyszer: már lezárva — nem dönt újra.
      const masodik = await commands.handleModal(kuld)
      assert.equal(masodik.outcome, 'error')
      assert.match(JSON.stringify(masodik.response), /Lezárva a YUME-ban/)
    })

    // Az ablak nyitva maradhatott, miközben a jogot elvették: az elküldés újra ellenőriz.
    it('az indoklás elküldésekor is ellenőrzi a jogot', async () => {
      const kuld = { ...(gomb(TAG_DISCORD, `modr:hide:${reportId}`) as object), type: 5, options: { reason: 'Nem vagyok moderátor' } } as never
      const e = await commands.handleModal(kuld)
      assert.equal(e.outcome, 'forbidden')
      const { rows } = await pool.query<{ status: string }>('SELECT status FROM reports WHERE id = $1', [reportId])
      assert.equal(rows[0]?.status, 'open', 'nem moderátor döntött')
    })

    it('felfüggesztett moderátor nem dönthet', async () => {
      await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [modId])
      try {
        assert.equal(await mod.moderatorOf(MOD_DISCORD), undefined)
      } finally {
        await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [modId])
      }
    })
  })

  // ---- a szerver-beállítások végpontjai ----

  describe('a szerver-beállítások végpontjai', () => {
    const discordRangok = (): Hivas[] => hamisDiscord((method, path) => {
      if (method === 'GET' && path === `/guilds/${GUILD}/roles`) {
        return [200, [
          { id: GUILD, name: '@everyone', managed: false, position: 0, permissions: '0' },
          { id: LINKED, name: 'YUME-tag', managed: false, position: 2, permissions: '0' },
          { id: MANAGED, name: 'Bot', managed: true, position: 3, permissions: '0' }
        ]]
      }
      if (method === 'GET' && path === `/channels/${MOD_CH}`) return [200, { id: MOD_CH, guild_id: MASIK }]
      return undefined
    })
    const hivas = async (method: string, url: string, payload?: unknown, token = adminToken) =>
      await app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload } : {}) })

    it('a választható értékeket a kiszolgáló adja', async () => {
      const res = await hivas('GET', `/v1/discord/guilds/${GUILD}/config`)
      assert.equal(res.statusCode, 200, res.body)
      assert.ok(res.json().options.genres.some((g: { slug: string }) => g.slug === mufaj))
      assert.ok(res.json().options.yumeRoles.some((r: { slug: string }) => r.slug === szerep))
    })

    it('ismeretlen műfajt, idegen csatornát és nem kezelhető rangot elutasít', async () => {
      discordRangok()
      const base = `/v1/discord/guilds/${GUILD}/config`
      assert.equal((await hivas('PATCH', base, { feedGenres: ['nincs-ilyen-' + jel] })).statusCode, 400)
      const csatorna = await hivas('PATCH', base, { moderationChannelId: MOD_CH })
      assert.equal(csatorna.statusCode, 400)
      assert.match(csatorna.json().detail, /nem ehhez a szerverhez/)
      assert.equal((await hivas('PATCH', base, { linkedRoleId: GUILD })).statusCode, 400, 'az @everyone-t elfogadta')
      assert.equal((await hivas('PATCH', base, { linkedRoleId: MANAGED })).statusCode, 400, 'integráció rangját elfogadta')
      assert.equal((await hivas('PATCH', base, { linkedRoleId: '439999999999999999' })).statusCode, 400)
      const jo = await hivas('PATCH', base, { linkedRoleId: LINKED, language: 'en' })
      assert.equal(jo.statusCode, 200, jo.body)
      assert.equal(jo.json().settings.linkedRoleId, LINKED)
    })

    it('a rangmegfeleltetés: szerepkörönként egyszer, létező szerepkörre', async () => {
      discordRangok()
      const url = `/v1/discord/guilds/${GUILD}/config/role-mappings`
      assert.equal((await hivas('PUT', url, { mappings: [{ yumeRole: szerep, discordRoleId: LINKED }, { yumeRole: szerep, discordRoleId: LINKED }] })).statusCode, 400)
      assert.equal((await hivas('PUT', url, { mappings: [{ yumeRole: 'nincs-' + jel, discordRoleId: LINKED }] })).statusCode, 400)
      const jo = await hivas('PUT', url, { mappings: [{ yumeRole: szerep, discordRoleId: LINKED }] })
      assert.equal(jo.statusCode, 200, jo.body)
      assert.deepEqual(jo.json().roleMappings, [{ yumeRole: szerep, discordRoleId: LINKED }])
    })

    it('az animénkénti rang felvehető és törölhető', async () => {
      discordRangok()
      const url = `/v1/discord/guilds/${GUILD}/config/anime-mentions/${anime.A}`
      const fel = await hivas('PUT', url, { discordRoleId: LINKED })
      assert.equal(fel.statusCode, 200, fel.body)
      assert.equal(fel.json().animeMentions[0]?.animeId, anime.A)
      assert.equal((await hivas('DELETE', url)).statusCode, 200)
      assert.equal((await hivas('DELETE', url)).statusCode, 404)
    })

    it('szerver-kezelési jog nélkül a beállítás sem látszik', async () => {
      const res = await hivas('GET', `/v1/discord/guilds/${GUILD}/config`, undefined, tagToken)
      assert.equal(res.statusCode, 403)
    })
  })
})
