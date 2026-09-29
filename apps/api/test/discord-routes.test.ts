// A Discord vezérlőpult végpontjai.
//
// AMIT EZ A KÉSZLET ŐRIZ, egy mondatban: EGY SZERVER ADMINJA CSAK A SAJÁT
// GUILDJÉT LÁTHATJA. Ez a modul legkönnyebben elrontható pontja — a kapu
// beengedhet a saját guildünkre, és utána egy érvényes azonosítóval egy
// MÁSIK guild üzenetét lehetne módosítani, ha a `guild_id` nincs benne a
// `WHERE`-ben is.
//
// A második tétel: a LEJÁRT jogosultság nem jogosít. A 7.2. pont kimondja,
// hogy nem szabad kizárólag a tárolt adatra támaszkodni — a Discord oldalán
// bármikor elvehetik a jogot.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'discord-routes-test-secret-long-enough-0123456789'

let app: Awaited<ReturnType<typeof import('../src/app.ts')['buildApp']>>
let pool: typeof import('../src/infrastructure/database/index.ts')['pool']
let hozzaferes: typeof import('../src/modules/discord/guild-access.ts')

/** Két guild: az egyik a miénk, a másik idegen. */
const MIENK = '100000000000000001'
const IDEGEN = '100000000000000002'
const CSATORNA = '200000000000000001'

let adminToken = ''
let tagToken = ''
let adminNev = ''
let tagNev = ''
let tagDiscordId = ''
// 2026-09-29 óta a vezérlőpulthoz YUME-jogosultság is kell (discord.dashboard):
// a „tag" egy próbaszerepkörön át megkapja, a „külső" nem — neki csak a
// Discordon van „Szerver kezelése" joga.
let szerep = ''
let kulsoNev = ''
let kulsoToken = ''
let kulsoDiscordId = ''

describe('a Discord vezérlőpult végpontjai', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    const [{ buildApp }, db] = await Promise.all([
      import('../src/app.ts'),
      import('../src/infrastructure/database/index.ts')
    ])
    app = await buildApp()
    await app.ready()
    pool = db.pool
    hozzaferes = await import('../src/modules/discord/guild-access.ts')

    const reg = async (nev: string) => {
      const res = await app.inject({
        method: 'POST', url: '/v1/auth/register',
        payload: { email: `${nev}@example.com`, username: nev, password: 'Correct-Horse-Battery-9' }
      })
      const body = res.json()
      return String(body.accessToken ?? body.token)
    }

    adminNev = 'dcadm' + randomBytes(4).toString('hex')
    tagNev = 'dctag' + randomBytes(4).toString('hex')
    adminToken = await reg(adminNev)
    tagToken = await reg(tagNev)
    kulsoNev = 'dckul' + randomBytes(4).toString('hex')
    kulsoToken = await reg(kulsoNev)

    szerep = 'dcdash' + randomBytes(4).toString('hex')
    await pool.query('INSERT INTO roles (slug, name) VALUES ($1, $1)', [szerep])
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r, permissions p WHERE r.slug = $1 AND p.slug = 'discord.dashboard'`, [szerep])
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT u.id, r.id FROM users u, roles r WHERE u.username = $1 AND r.slug = $2`, [tagNev, szerep])

    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT u.id, r.id FROM users u, roles r WHERE u.username = $1 AND r.slug = 'admin'
       ON CONFLICT DO NOTHING`, [adminNev])
    const auth = await import('../src/middleware/auth.ts')
    auth.invalidatePermissions()

    // A „tag" felhasználó Discord-fiókja: a MIÉNK guildben MANAGE_GUILD.
    tagDiscordId = '3' + randomBytes(8).toString('hex').replace(/\D/g, '0').padEnd(17, '7').slice(0, 17)
    await pool.query(
      'INSERT INTO discord_links (user_id, discord_user_id) SELECT id, $2 FROM users WHERE username = $1',
      [tagNev, tagDiscordId])
    kulsoDiscordId = '4' + randomBytes(8).toString('hex').replace(/\D/g, '0').padEnd(17, '7').slice(0, 17)
    await pool.query(
      'INSERT INTO discord_links (user_id, discord_user_id) SELECT id, $2 FROM users WHERE username = $1',
      [kulsoNev, kulsoDiscordId])
  })

  beforeEach(async () => {
    // Egy korábbi tétel sikertelen frissítése fél percig visszatartaná a
    // következőt (lásd `refreshMembership`) — tételenként tiszta lap.
    hozzaferes.forgetMembershipRefreshes()
    await pool.query('DELETE FROM persistent_messages WHERE guild_id IN ($1, $2)', [MIENK, IDEGEN])
    await pool.query('DELETE FROM discord_guild_members WHERE discord_user_id = $1', [tagDiscordId])
    // MANAGE_GUILD (1 << 5 = 32), frissen lekérdezve.
    await pool.query(
      `INSERT INTO discord_guild_members (discord_user_id, guild_id, owner, permissions, fetched_at)
       VALUES ($1, $2, false, '32', now())`, [tagDiscordId, MIENK])
    await pool.query('DELETE FROM discord_guild_members WHERE discord_user_id = $1', [kulsoDiscordId])
    await pool.query(
      `INSERT INTO discord_guild_members (discord_user_id, guild_id, owner, permissions, fetched_at)
       VALUES ($1, $2, false, '32', now())`, [kulsoDiscordId, MIENK])
  })

  after(async () => {
    await pool?.query('DELETE FROM persistent_messages WHERE guild_id IN ($1, $2)', [MIENK, IDEGEN])
    await pool?.query('DELETE FROM discord_guild_members WHERE discord_user_id = $1', [tagDiscordId])
    await pool?.query('DELETE FROM discord_guild_members WHERE discord_user_id = $1', [kulsoDiscordId])
    await pool?.query('DELETE FROM users WHERE username IN ($1, $2, $3)', [adminNev, tagNev, kulsoNev])
    await pool?.query('DELETE FROM roles WHERE slug = $1', [szerep])
    await app?.close()
  })

  const hivas = (method: string, url: string, token: string | null, payload?: unknown) =>
    app.inject({
      method: method as 'GET',
      url,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      ...(payload !== undefined ? { payload } : {})
    })

  const letrehoz = async (guildId: string, token: string, type = 'yume_statistics') =>
    await hivas('POST', `/v1/discord/guilds/${guildId}/persistent-messages`, token,
      { channelId: CSATORNA, messageType: type })

  // ---- hitelesítés ----

  it('hitelesítés nélkül semmi nem megy', async () => {
    for (const [m, u] of [
      ['GET', `/v1/discord/guilds/${MIENK}/persistent-messages`],
      ['POST', `/v1/discord/guilds/${MIENK}/persistent-messages`],
      ['GET', '/v1/discord/status']
    ] as const) {
      assert.equal((await hivas(m, u, null, m === 'POST' ? {} : undefined)).statusCode, 401, `${m} ${u}`)
    }
  })

  // ---- guild-elkülönítés: EZ A LÉNYEG ----

  it('a YUME-jogosultság bejuttat a saját rendszerbe', async () => {
    assert.equal((await hivas('GET', `/v1/discord/guilds/${MIENK}/persistent-messages`, adminToken)).statusCode, 200)
  })

  it('vezérlőpult-jogosultság nélkül a Discord-jog sem elég', async () => {
    // A „külső" a MIÉNK guildben „Szerver kezelése" joggal bír — eddig ez
    // egymagában bejuttatott. A vezérlőpult nem nyilvános: YUME-jogosultság kell.
    const res = await hivas('GET', `/v1/discord/guilds/${MIENK}/persistent-messages`, kulsoToken)
    assert.equal(res.statusCode, 403)
    assert.equal(res.json().detail, 'no_dashboard_permission')
    assert.equal((await hivas('GET', '/v1/discord/status', kulsoToken)).statusCode, 403)
  })

  it('az összekötés viszont jogosultság nélkül is elérhető — a főoldal is ezt használja', async () => {
    const res = await hivas('GET', '/v1/discord/oauth/link', kulsoToken)
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().linked, true)
  })

  it('a Discord MANAGE_GUILD bejuttat a saját guildbe', async () => {
    assert.equal((await hivas('GET', `/v1/discord/guilds/${MIENK}/persistent-messages`, tagToken)).statusCode, 200)
  })

  /*
   * A LEGFONTOSABB ÁLLÍTÁS. A felhasználónak a MIÉNK guildben van joga —
   * az IDEGEN-hez semmi köze. A válasz 403, és nem árulja el, hogy az a
   * guild létezik-e nálunk.
   */
  it('másik guildhez NEM enged, pedig a sajátjához igen', async () => {
    const res = await hivas('GET', `/v1/discord/guilds/${IDEGEN}/persistent-messages`, tagToken)
    assert.equal(res.statusCode, 403)
    assert.ok(!JSON.stringify(res.json()).includes('exists'), 'elárulja, hogy a guild létezik-e')
  })

  it('összekötött fiók nélkül nem jut be', async () => {
    await pool.query('DELETE FROM discord_links WHERE discord_user_id = $1', [tagDiscordId])
    try {
      const res = await hivas('GET', `/v1/discord/guilds/${MIENK}/persistent-messages`, tagToken)
      assert.equal(res.statusCode, 403)
      assert.equal(res.json().detail, 'no_link')
    } finally {
      await pool.query(
        'INSERT INTO discord_links (user_id, discord_user_id) SELECT id, $2 FROM users WHERE username = $1 ON CONFLICT DO NOTHING',
        [tagNev, tagDiscordId])
    }
  })

  /*
   * A LEJÁRT JOGOSULTSÁG NEM JOGOSÍT. Ez az a pont, ahol a legkönnyebb
   * engedni — „hát tegnap még admin volt" —, és pont ezért van kimondva a
   * 7.2. pontban.
   */
  it('a lejárt tagság NEM jogosít, ha a bot sem tudja megerősíteni', async () => {
    // Bot token nélkül a frissítés nem kérdezhet — a lejárt adat marad lejárt.
    const elozo = process.env.DISCORD_BOT_TOKEN
    delete process.env.DISCORD_BOT_TOKEN
    try {
      await pool.query(
        "UPDATE discord_guild_members SET fetched_at = now() - interval '1 day' WHERE discord_user_id = $1",
        [tagDiscordId])
      const res = await hivas('GET', `/v1/discord/guilds/${MIENK}/persistent-messages`, tagToken)
      assert.equal(res.statusCode, 403)
      assert.equal(res.json().detail, 'stale')
    } finally {
      if (elozo !== undefined) process.env.DISCORD_BOT_TOKEN = elozo
    }
  })

  it('a puszta tagság (jogosultság nélkül) nem elég', async () => {
    await pool.query(
      "UPDATE discord_guild_members SET permissions = '0', owner = false WHERE discord_user_id = $1",
      [tagDiscordId])
    const res = await hivas('GET', `/v1/discord/guilds/${MIENK}/persistent-messages`, tagToken)
    assert.equal(res.statusCode, 403)
    assert.equal(res.json().detail, 'insufficient')
  })

  it('a guild tulajdonosa mindig bejut', async () => {
    await pool.query(
      "UPDATE discord_guild_members SET permissions = '0', owner = true WHERE discord_user_id = $1",
      [tagDiscordId])
    assert.equal((await hivas('GET', `/v1/discord/guilds/${MIENK}/persistent-messages`, tagToken)).statusCode, 200)
  })

  // ---- létrehozás és duplikáció ----

  it('létrehoz, és visszaadja a rekordot', async () => {
    const res = await letrehoz(MIENK, adminToken)
    assert.equal(res.statusCode, 201)
    const body = res.json()
    assert.equal(body.guildId, MIENK)
    assert.equal(body.messageId, null, 'üzenetazonosítót talált ki küldés nélkül')
    assert.equal(body.enabled, true)
  })

  /*
   * EGY GUILD + EGY TÍPUS = EGY AKTÍV ÜZENET. A duplikációt az adatbázis
   * dönti el, nem egy előzetes lekérdezés: két egyidejű kérés a „megnézem,
   * van-e már" mintával mindkettőnek azt mondaná, hogy nincs.
   */
  it('ugyanahhoz a típushoz nem enged másodikat', async () => {
    assert.equal((await letrehoz(MIENK, adminToken)).statusCode, 201)
    assert.equal((await letrehoz(MIENK, adminToken)).statusCode, 409)
  })

  it('két egyidejű létrehozásból csak az egyik sikerül', async () => {
    const [a, b] = await Promise.all([letrehoz(MIENK, adminToken), letrehoz(MIENK, adminToken)])
    const kodok = [a.statusCode, b.statusCode].sort()
    assert.deepEqual(kodok, [201, 409], `két rekord jött létre: ${kodok.join(', ')}`)
  })

  it('más típusból lehet másik', async () => {
    assert.equal((await letrehoz(MIENK, adminToken, 'yume_statistics')).statusCode, 201)
    assert.equal((await letrehoz(MIENK, adminToken, 'system_health')).statusCode, 201)
  })

  it('ismeretlen üzenettípust nem fogad el', async () => {
    const res = await hivas('POST', `/v1/discord/guilds/${MIENK}/persistent-messages`, adminToken,
      { channelId: CSATORNA, messageType: 'barmi_mas' })
    assert.equal(res.statusCode, 400)
  })

  it('érvénytelen azonosítót nem fogad el', async () => {
    for (const rossz of ['abc', '12', '../../x', '1'.repeat(25)]) {
      const res = await hivas('POST', `/v1/discord/guilds/${MIENK}/persistent-messages`, adminToken,
        { channelId: rossz, messageType: 'yume_statistics' })
      assert.equal(res.statusCode, 400, `átengedte: ${rossz}`)
    }
  })

  // ---- guild-elkülönítés a MŰVELETEKBEN ----

  /*
   * A KAPU NEM ELÉG. Ha a `guild_id` nincs benne a `WHERE`-ben is, egy
   * érvényes azonosítóval egy MÁSIK guild üzenetét lehetne módosítani —
   * miközben a kapu a sajátunkra engedett be.
   */
  it('másik guild üzenetét NEM lehet módosítani a sajátunkon át', async () => {
    const idegen = await pool.query<{ id: string }>(
      `INSERT INTO persistent_messages (guild_id, channel_id, message_type)
       VALUES ($1, $2, 'yume_statistics') RETURNING id`, [IDEGEN, CSATORNA])
    const id = idegen.rows[0]!.id

    // A kapu a MIÉNK guildre enged be, az azonosító viszont az IDEGEN-é.
    const res = await hivas('PATCH', `/v1/discord/guilds/${MIENK}/persistent-messages/${id}`,
      adminToken, { enabled: false })
    assert.equal(res.statusCode, 404, 'módosította egy másik guild üzenetét')

    const utana = await pool.query<{ enabled: boolean }>(
      'SELECT enabled FROM persistent_messages WHERE id = $1', [id])
    assert.equal(utana.rows[0]!.enabled, true, 'az idegen rekord megváltozott')
  })

  it('másik guild üzenetét NEM lehet törölni', async () => {
    const idegen = await pool.query<{ id: string }>(
      `INSERT INTO persistent_messages (guild_id, channel_id, message_type)
       VALUES ($1, $2, 'system_health') RETURNING id`, [IDEGEN, CSATORNA])
    const id = idegen.rows[0]!.id
    assert.equal((await hivas('DELETE', `/v1/discord/guilds/${MIENK}/persistent-messages/${id}`, adminToken)).statusCode, 404)
    const utana = await pool.query('SELECT 1 FROM persistent_messages WHERE id = $1', [id])
    assert.equal(utana.rows.length, 1, 'törölte egy másik guild rekordját')
  })

  it('a csatorna cseréje elengedi a régi üzenetazonosítót', async () => {
    const letre = (await letrehoz(MIENK, adminToken)).json()
    await pool.query("UPDATE persistent_messages SET message_id = '300000000000000001' WHERE id = $1", [letre.id])

    const res = await hivas('PATCH', `/v1/discord/guilds/${MIENK}/persistent-messages/${letre.id}`,
      adminToken, { channelId: '200000000000000009' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().messageId, null,
      'a régi üzenetazonosító megmaradt — az a RÉGI csatornára mutat, és ott már nem módosítható')
  })

  // ---- előnézet ----

  /*
   * AZ ELŐNÉZET NEM KÜLDÉS. A 11.2. pont kifejezetten kimondja: „A preview ne
   * állítsa azt, hogy az üzenet már elküldésre került."
   */
  it('az előnézet nem küld, és ezt ki is mondja', async () => {
    const letre = (await letrehoz(MIENK, adminToken)).json()
    const res = await hivas('GET', `/v1/discord/guilds/${MIENK}/persistent-messages/${letre.id}/preview`, adminToken)
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.sent, false)
    assert.ok(body.payload?.embeds?.length > 0, 'nincs tartalom az előnézetben')

    const utana = await pool.query<{ message_id: string | null }>(
      'SELECT message_id FROM persistent_messages WHERE id = $1', [letre.id])
    assert.equal(utana.rows[0]!.message_id, null, 'az előnézet üzenetet küldött')
  })

  it('az előnézet VALÓS adatot mutat, nem kitalált számokat', async () => {
    const letre = (await letrehoz(MIENK, adminToken)).json()
    const body = (await hivas('GET', `/v1/discord/guilds/${MIENK}/persistent-messages/${letre.id}/preview`, adminToken)).json()
    const embed = body.payload.embeds[0]
    // A mezőnév emodzsit kapott a tervrajz szerint; a keresés a SZÖVEGRE megy,
    // nem a pontos egyezésre — különben minden vizuális változás megbuktatná
    // ezt a tételt, pedig nem arról szól.
    const animeMezo = embed.fields.find((f: { name: string }) => f.name.includes('Animék'))
    const valodi = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM anime WHERE visibility = 'public'")
    // Az érték félkövér (`**32 534**`) és ezres tagolású — a SZÁM az, ami
    // számít, nem a formázás.
    const szam = String(animeMezo.value).replace(/[^0-9]/g, '')
    assert.equal(szam, String(valodi.rows[0]!.n), 'az embed száma nem a katalógusból jön')
  })

  // ---- token nélkül ----

  it('bot token nélkül a szinkronizálás 503-at ad, nem hazudik sikert', async () => {
    const elozo = process.env.DISCORD_BOT_TOKEN
    delete process.env.DISCORD_BOT_TOKEN
    try {
      const letre = (await letrehoz(MIENK, adminToken)).json()
      const res = await hivas('POST', `/v1/discord/guilds/${MIENK}/persistent-messages/${letre.id}/resync`, adminToken)
      assert.equal(res.statusCode, 503)
      assert.match(String(res.json().detail), /token/)
    } finally {
      if (elozo !== undefined) process.env.DISCORD_BOT_TOKEN = elozo
    }
  })

  it('bot token nélkül az újraküldés sem hazudik sikert', async () => {
    const elozo = process.env.DISCORD_BOT_TOKEN
    delete process.env.DISCORD_BOT_TOKEN
    try {
      const letre = (await letrehoz(MIENK, adminToken)).json()
      await pool.query("UPDATE persistent_messages SET message_id = '300000000000000002' WHERE id = $1", [letre.id])
      const res = await hivas('POST', `/v1/discord/guilds/${MIENK}/persistent-messages/${letre.id}/recreate`, adminToken)
      assert.equal(res.statusCode, 503)
      // ÉS NEM NYÚLT A REKORDHOZ. Egy félbehagyott újraküldés, ami a
      // nyilvántartást már törölte, de újat nem küldött, rosszabb a
      // semminél: az üzenet kint marad, és többé senki nem frissíti.
      const utana = await pool.query<{ message_id: string | null }>(
        'SELECT message_id FROM persistent_messages WHERE id = $1', [letre.id])
      assert.equal(utana.rows[0]!.message_id, '300000000000000002',
        'token nélkül is elengedte a régi üzenetazonosítót')
    } finally {
      if (elozo !== undefined) process.env.DISCORD_BOT_TOKEN = elozo
    }
  })

  it('másik guild üzenetét NEM lehet újraküldeni', async () => {
    const idegen = await pool.query<{ id: string }>(
      `INSERT INTO persistent_messages (guild_id, channel_id, message_type)
       VALUES ($1, $2, 'bot_status') RETURNING id`, [IDEGEN, CSATORNA])
    const res = await hivas('POST',
      `/v1/discord/guilds/${MIENK}/persistent-messages/${idegen.rows[0]!.id}/recreate`, adminToken)
    // A 404 akkor is 404, ha token sincs: a guild-ellenőrzés ELŐBB fut.
    assert.ok([404, 503].includes(res.statusCode), `váratlan válasz: ${res.statusCode}`)
    const utana = await pool.query<{ message_id: string | null }>(
      'SELECT message_id FROM persistent_messages WHERE id = $1', [idegen.rows[0]!.id])
    assert.equal(utana.rows.length, 1)
    assert.equal(utana.rows[0]!.message_id, null)
  })

  /*
   * A VEZÉRLŐPULT FORRÁSA NEM RAGADHAT BE.
   *
   * MÉRT HIBA. A felületnek nincs build lépése: a böngésző azokat a
   * fájlneveket tölti le, amik a lemezen vannak — egy telepítés után tehát
   * ugyanarról a CÍMRŐL kérné az új kódot, és ha a régit gyorsítótárazta,
   * nem kéri. Az eredet `max-age=0`-t küldött, a Cloudflare felülírta
   * `max-age=14400`-ra, és négy órán át a JAVÍTÁS ELŐTTI kód ment ki.
   *
   * A `no-cache` nem azt jelenti, hogy „ne tárold", hanem hogy „használat
   * előtt kérdezd meg" — az ETag megmarad, a válasz jellemzően 304.
   */
  it('a vezérlőpult forrását nem engedi gyorsítótárba ragadni', async () => {
    for (const url of ['/dashboard/src/app.js', '/dashboard/index.html', '/dashboard/css/tokens.css']) {
      const res = await app.inject({ url })
      assert.equal(res.statusCode, 200, `${url} nem érhető el`)
      assert.match(String(res.headers['cache-control']), /no-cache/,
        `${url}: ${res.headers['cache-control']} — a régi kód négy órán át kimenne`)
    }
  })

  it('a képek viszont maradhatnak a gyorsítótárban', async () => {
    // Egy elavult kép legrosszabb esetben csúnya; egy elavult modul törött
    // alkalmazás. A kettőnek nem kell ugyanaz a szabály.
    const res = await app.inject({ url: '/dashboard/assets/yume.svg' })
    if (res.statusCode === 200) {
      assert.ok(!/no-cache/.test(String(res.headers['cache-control'])),
        'a képekre is no-cache jár, pedig nem kell')
    }
  })

  it('a státusz megmondja, be van-e kötve a bot', async () => {
    const res = await hivas('GET', '/v1/discord/status', adminToken)
    assert.equal(res.statusCode, 200)
    assert.equal(typeof res.json().configured, 'boolean')
    assert.ok(Array.isArray(res.json().messageTypes))
  })

  // ---- előzmények ----

  it('az előzmény csak a saját guild üzenetéé', async () => {
    const idegen = await pool.query<{ id: string }>(
      `INSERT INTO persistent_messages (guild_id, channel_id, message_type)
       VALUES ($1, $2, 'provider_status') RETURNING id`, [IDEGEN, CSATORNA])
    assert.equal((await hivas('GET',
      `/v1/discord/guilds/${MIENK}/persistent-messages/${idegen.rows[0]!.id}/history`, adminToken)).statusCode, 404)
  })

  // ---- a bot állapota: körútidő és a kapcsolat naponta ----

  it('a bot állapota a körútidőt és a kapcsolat napi sorait is megmutatja', async () => {
    const regi = (await pool.query<{ heartbeat_rtt_ms: number | null }>(
      'SELECT heartbeat_rtt_ms FROM discord_gateway_state WHERE id = 1')).rows[0]
    const nap = (await pool.query<{ d: string }>('SELECT (current_date - 13)::text AS d')).rows[0]!.d
    const volt = (await pool.query('SELECT * FROM discord_gateway_daily WHERE day = $1', [nap])).rows[0]
    try {
      await pool.query('UPDATE discord_gateway_state SET heartbeat_rtt_ms = 42 WHERE id = 1')
      await pool.query(
        `INSERT INTO discord_gateway_daily (day, reconnects, resumed, identified, rtt_sum_ms, rtt_count, rtt_max_ms)
         VALUES ($1, 5, 4, 1, 500, 5, 180)
         ON CONFLICT (day) DO UPDATE SET reconnects = 5, resumed = 4, identified = 1, rtt_sum_ms = 500, rtt_count = 5, rtt_max_ms = 180`,
        [nap])
      const res = await hivas('GET', `/v1/discord/guilds/${MIENK}/health`, tagToken)
      assert.equal(res.statusCode, 200)
      const gw = res.json().gateway
      assert.equal(gw.heartbeatRttMs, 42)
      assert.deepEqual(gw.daily.find((n: { day: string }) => n.day === nap),
        { day: nap, reconnects: 5, resumed: 4, identified: 1, rttAvgMs: 100, rttMaxMs: 180 })
    } finally {
      await pool.query('UPDATE discord_gateway_state SET heartbeat_rtt_ms = $1 WHERE id = 1', [regi?.heartbeat_rtt_ms ?? null])
      if (volt) {
        await pool.query(
          `UPDATE discord_gateway_daily SET reconnects = $2, resumed = $3, identified = $4, rtt_sum_ms = $5, rtt_count = $6, rtt_max_ms = $7
            WHERE day = $1`,
          [nap, volt.reconnects, volt.resumed, volt.identified, volt.rtt_sum_ms, volt.rtt_count, volt.rtt_max_ms])
      } else {
        await pool.query('DELETE FROM discord_gateway_daily WHERE day = $1', [nap])
      }
    }
  })

  // ---- a tartós üzenetek napi hibaösszesítője ----

  /*
   * AZ ÜZENET SAJÁT HIBASZÁMLÁLÓJA egy sikeres frissítéskor nullázódik: egy
   * tegnap órákig hibás üzenet ma hibátlannak látszik. Az összesítő a
   * frissítési előzményből számol — és csak a saját guild üzeneteiből.
   */
  it('a napi hibaösszesítő a saját guild hibás napjait mutatja, kísérletszámmal', async () => {
    const [mienk, idegen] = await Promise.all([MIENK, IDEGEN].map(async g => (await pool.query<{ id: string }>(
      `INSERT INTO persistent_messages (guild_id, channel_id, message_type) VALUES ($1, $2, 'yume_statistics') RETURNING id`,
      [g, CSATORNA])).rows[0]!.id))
    const esemeny = async (id: string, event: string, n: number, mikor: string, detail: string | null = null) => {
      await pool.query(
        `INSERT INTO persistent_message_events (message_id, event, detail, at)
         SELECT $1, $2, $3, now() - $4::interval FROM generate_series(1, $5)`, [id, event, detail, mikor, n])
    }
    await esemeny(mienk!, 'failed', 3, '1 day', 'forbidden: Missing Permissions')
    await esemeny(mienk!, 'skipped', 10, '1 day')
    await esemeny(mienk!, 'edited', 2, '1 day')
    await esemeny(mienk!, 'locked_out', 4, '1 day') // nem kísérlet
    await esemeny(mienk!, 'skipped', 5, '1 minute') // ma nincs hiba
    await esemeny(idegen!, 'failed', 4, '1 minute', 'idegen hiba')

    const tegnap = (await pool.query<{ d: string }>(
      "SELECT ((now() - interval '1 day') AT TIME ZONE 'UTC')::date::text AS d")).rows[0]!.d
    const res = await hivas('GET', `/v1/discord/guilds/${MIENK}/message-failures`, tagToken)
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json().data.map((r: Record<string, unknown>) => ({ ...r, lastFailedAt: typeof r.lastFailedAt })), [{
      day: tegnap, messageType: 'yume_statistics', failures: 3, attempts: 15,
      lastError: 'forbidden: Missing Permissions', lastFailedAt: 'string'
    }])
  })

  it('a hibaösszesítő ablaka legfeljebb 30 nap, és a vezérlőpulté', async () => {
    assert.equal((await hivas('GET', `/v1/discord/guilds/${MIENK}/message-failures?days=31`, tagToken)).statusCode, 400)
    const res = await hivas('GET', `/v1/discord/guilds/${MIENK}/message-failures`, kulsoToken)
    assert.equal(res.statusCode, 403)
    assert.equal(res.json().detail, 'no_dashboard_permission')
    assert.equal((await hivas('GET', `/v1/discord/guilds/${IDEGEN}/message-failures`, tagToken)).statusCode, 403,
      'idegen guild összesítőjét is kiadta')
  })

  // ---- a lejárt tagság frissítése és a szerverlista — a bot tokenjével ----
  //
  // HAMIS DISCORDDAL, a `fetch` szintjén: a kiszolgáló valódi kódja fut, csak
  // a Discord válaszait mi adjuk.

  describe('a bot tokenjével', () => {
    const MOD = '100000000000000009'
    const HARMADIK = '100000000000000003'
    let elozoToken: string | undefined

    before(() => {
      elozoToken = process.env.DISCORD_BOT_TOKEN
      process.env.DISCORD_BOT_TOKEN = 'routes-proba-token-NEM-VALODI'
    })
    after(() => {
      if (elozoToken === undefined) delete process.env.DISCORD_BOT_TOKEN
      else process.env.DISCORD_BOT_TOKEN = elozoToken
    })
    afterEach(() => { mock.restoreAll() })

    /** A hamis Discord: URL → [státusz, törzs]. Ami nincs benne, arra 404. */
    const discord = (valasz: (url: string) => [number, unknown] | undefined, kesleltetes = 0): string[] => {
      const hivasok: string[] = []
      mock.method(globalThis, 'fetch', async (url: string) => {
        hivasok.push(String(url))
        if (kesleltetes) await new Promise(resolve => setTimeout(resolve, kesleltetes))
        const [status, body] = valasz(String(url)) ?? [404, { code: 0, message: 'nincs a hamis Discordban' }]
        return { ok: status < 400, status, json: async () => body }
      })
      return hivasok
    }

    /** A MIÉNK guild a Discord szerint: a MOD rang kezelheti. */
    const guildValasz = (tagRangjai: string[]) => (url: string): [number, unknown] | undefined => {
      if (url.endsWith(`/guilds/${MIENK}`)) {
        return [200, {
          id: MIENK, name: 'Mienk a Discordon', owner_id: '100000000000000999',
          roles: [{ id: MIENK, permissions: '0' }, { id: MOD, permissions: '32' }]
        }]
      }
      if (url.endsWith(`/guilds/${MIENK}/members/${tagDiscordId}`)) return [200, { roles: tagRangjai }]
      return undefined
    }

    const elavit = async (): Promise<void> => {
      await pool.query(
        "UPDATE discord_guild_members SET fetched_at = now() - interval '1 day' WHERE discord_user_id = $1",
        [tagDiscordId])
    }

    /*
     * EDDIG ITT KIZÁRÓDOTT: az összekötés után öt perccel a tárolt tagság
     * lejárt, és újra kellett kötni. Most a bot megkérdezi a Discordot.
     */
    it('a lejárt tagságot a bot frissíti — újra-összekötés nélkül', async () => {
      await elavit()
      const hivasok = discord(guildValasz([MOD]))
      const res = await hivas('GET', `/v1/discord/guilds/${MIENK}/persistent-messages`, tagToken)
      assert.equal(res.statusCode, 200, res.body)
      assert.equal(hivasok.length, 2, 'a guildet és a tagot kell lekérdeznie, se többet, se kevesebbet')
      const { rows } = await pool.query<{ friss: boolean, permissions: string, guild_name: string }>(
        `SELECT fetched_at > now() - interval '1 minute' AS friss, permissions, guild_name
           FROM discord_guild_members WHERE discord_user_id = $1 AND guild_id = $2`, [tagDiscordId, MIENK])
      assert.equal(rows[0]?.friss, true, 'a frissítés nem került a sorba')
      assert.equal(rows[0]?.permissions, '32')
      assert.equal(rows[0]?.guild_name, 'Mienk a Discordon')
      // A következő kérés már a friss sorból dönt — nem kérdez újra.
      assert.equal((await hivas('GET', `/v1/discord/guilds/${MIENK}/persistent-messages`, tagToken)).statusCode, 200)
      assert.equal(hivasok.length, 2, 'friss adat mellett is a Discordhoz fordult')
    })

    it('ha a Discordon elvették a jogát, a friss adat dönt', async () => {
      await elavit()
      discord(guildValasz([]))
      const res = await hivas('GET', `/v1/discord/guilds/${MIENK}/persistent-messages`, tagToken)
      assert.equal(res.statusCode, 403)
      assert.equal(res.json().detail, 'insufficient')
    })

    it('ha a bot szerint már nem tag, a tagsága törlődik', async () => {
      await elavit()
      discord(url => url.includes('/members/')
        ? [404, { code: 10007, message: 'Unknown Member' }]
        : guildValasz([])(url))
      const res = await hivas('GET', `/v1/discord/guilds/${MIENK}/persistent-messages`, tagToken)
      assert.equal(res.statusCode, 403)
      assert.equal(res.json().detail, 'not_member')
      const { rows } = await pool.query(
        'SELECT 1 FROM discord_guild_members WHERE discord_user_id = $1 AND guild_id = $2', [tagDiscordId, MIENK])
      assert.equal(rows.length, 0, 'a megszűnt tagság ott maradt')
    })

    it('ha a Discord nem válaszol, nem enged be, és fél percig nem is kérdez újra', async () => {
      await elavit()
      const hivasok = discord(() => [500, {}])
      const elso = await hivas('GET', `/v1/discord/guilds/${MIENK}/persistent-messages`, tagToken)
      assert.equal(elso.statusCode, 403)
      assert.equal(elso.json().detail, 'stale')
      const utana = hivasok.length
      const masodik = await hivas('GET', `/v1/discord/guilds/${MIENK}/persistent-messages`, tagToken)
      assert.equal(masodik.json().detail, 'stale')
      assert.equal(hivasok.length, utana, 'egy nem válaszoló Discordot minden kérésnél újra megkérdezett')
    })

    it('az egyszerre érkező kérések egyetlen frissítésre várnak', async () => {
      await elavit()
      const hivasok = discord(guildValasz([MOD]), 50)
      const valaszok = await Promise.all(Array.from({ length: 4 }, async () =>
        await hivas('GET', `/v1/discord/guilds/${MIENK}/persistent-messages`, tagToken)))
      assert.deepEqual(valaszok.map(r => r.statusCode), [200, 200, 200, 200])
      assert.equal(hivasok.length, 2, `négy kérés ${hivasok.length / 2} frissítést indított`)
    })

    // ---- a szerverválasztó ----

    const botSzerverei = (url: string): [number, unknown] | undefined =>
      url.includes('/users/@me/guilds')
        ? [200, [{ id: IDEGEN, name: 'Idegen' }, { id: MIENK, name: 'Mienk' }]]
        : undefined

    it('az üzemeltető összekötés nélkül is látja a bot szervereit', async () => {
      discord(botSzerverei)
      const res = await hivas('GET', '/v1/discord/guilds', adminToken)
      assert.equal(res.statusCode, 200)
      assert.deepEqual(res.json().data.map((g: { id: string }) => g.id).sort(), [MIENK, IDEGEN].sort())
      assert.equal(res.json().botListAvailable, true)
    })

    it('a vezérlőpult-jogosult csak a saját, a bot által is ismert szervereit látja', async () => {
      // A HARMADIK-ban is kezelő, de ott nincs bent a bot; az IDEGEN-ben bent
      // van a bot, de ott nincs joga.
      await pool.query(
        `INSERT INTO discord_guild_members (discord_user_id, guild_id, owner, permissions, fetched_at)
         VALUES ($1, $2, false, '32', now()), ($1, $3, false, '0', now())`, [tagDiscordId, HARMADIK, IDEGEN])
      discord(botSzerverei)
      const res = await hivas('GET', '/v1/discord/guilds', tagToken)
      assert.equal(res.statusCode, 200)
      assert.deepEqual(res.json().data, [{ id: MIENK, name: 'Mienk' }])
    })

    it('ha a bot listája nem kérdezhető le, az összekötött szerverek maradnak', async () => {
      await pool.query(
        `INSERT INTO discord_guild_members (discord_user_id, guild_id, owner, permissions, fetched_at)
         VALUES ($1, $2, false, '32', now())`, [tagDiscordId, HARMADIK])
      discord(() => [500, {}])
      const res = await hivas('GET', '/v1/discord/guilds', tagToken)
      assert.equal(res.statusCode, 200)
      assert.deepEqual(res.json().data.map((g: { id: string }) => g.id).sort(), [MIENK, HARMADIK].sort())
      assert.equal(res.json().botListAvailable, false)
    })

    // ---- a slash parancsok nézete ----

    it('a Parancsok nézet megmondja a kézbesítést, a regisztrációt és a szerver saját használatát', async () => {
      const jelzo = 'dcuse' + randomBytes(3).toString('hex')
      await pool.query(
        `INSERT INTO analytics_events (event_type, visitor_key, subject_type, subject_id, metadata)
         VALUES ('discord.command.use', $1, 'discord_command', 'anime latest', jsonb_build_object('guildId', $2::text)),
                ('discord.command.use', $1, 'discord_command', 'anime latest', jsonb_build_object('guildId', $2::text)),
                ('discord.command.use', $1, 'discord_command', 'help', jsonb_build_object('guildId', $3::text))`,
        [jelzo, MIENK, IDEGEN])
      try {
        const rest = await import('../src/modules/discord/rest-client.ts')
        rest.forgetApplicationInfo()
        discord(url => url.endsWith('/applications/@me')
          ? [200, { id: '500000000000000003', interactions_endpoint_url: 'https://regi.example/interactions' }]
          : url.includes(`/guilds/${MIENK}/commands`) ? [200, [{ id: '1', name: 'help', description: 'Mit tud ez a bot?' }]] : undefined)
        const res = await hivas('GET', `/v1/discord/guilds/${MIENK}/commands`, tagToken)
        assert.equal(res.statusCode, 200, res.body)
        const d = res.json()
        assert.deepEqual(d.delivery, { mode: 'http', endpointUrl: 'https://regi.example/interactions' })
        assert.deepEqual(d.registered, ['help'])
        assert.equal(d.inSync, false)
        assert.ok(d.defined.includes('next') && d.defined.includes('watchlist'))
        // Csak a SAJÁT szerver használata: az idegen guild /help-je nem számít.
        const sajat = d.usage.filter((u: { command: string }) => u.command === 'anime latest')
        assert.equal(sajat[0]?.uses, 2)
        assert.ok(!d.usage.some((u: { command: string }) => u.command === 'help'), 'az idegen szerver használatát is beszámolta')
        rest.forgetApplicationInfo()
      } finally {
        await pool.query("DELETE FROM analytics_events WHERE event_type = 'discord.command.use' AND visitor_key = $1", [jelzo])
      }
    })

    it('a szerverlista is a vezérlőpulté: jogosultság és belépés nélkül nincs', async () => {
      discord(botSzerverei)
      const res = await hivas('GET', '/v1/discord/guilds', kulsoToken)
      assert.equal(res.statusCode, 403)
      assert.equal(res.json().detail, 'no_dashboard_permission')
      assert.equal((await hivas('GET', '/v1/discord/guilds', null)).statusCode, 401)
    })
  })
})
