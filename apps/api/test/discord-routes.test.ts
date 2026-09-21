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
import { after, before, beforeEach, describe, it } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'discord-routes-test-secret-long-enough-0123456789'

let app: Awaited<ReturnType<typeof import('../src/app.ts')['buildApp']>>
let pool: typeof import('../src/infrastructure/database/index.ts')['pool']

/** Két guild: az egyik a miénk, a másik idegen. */
const MIENK = '100000000000000001'
const IDEGEN = '100000000000000002'
const CSATORNA = '200000000000000001'

let adminToken = ''
let tagToken = ''
let adminNev = ''
let tagNev = ''
let tagDiscordId = ''

describe('a Discord vezérlőpult végpontjai', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    const [{ buildApp }, db] = await Promise.all([
      import('../src/app.ts'),
      import('../src/infrastructure/database/index.ts')
    ])
    app = await buildApp()
    await app.ready()
    pool = db.pool

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
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM persistent_messages WHERE guild_id IN ($1, $2)', [MIENK, IDEGEN])
    await pool.query('DELETE FROM discord_guild_members WHERE discord_user_id = $1', [tagDiscordId])
    // MANAGE_GUILD (1 << 5 = 32), frissen lekérdezve.
    await pool.query(
      `INSERT INTO discord_guild_members (discord_user_id, guild_id, owner, permissions, fetched_at)
       VALUES ($1, $2, false, '32', now())`, [tagDiscordId, MIENK])
  })

  after(async () => {
    await pool?.query('DELETE FROM persistent_messages WHERE guild_id IN ($1, $2)', [MIENK, IDEGEN])
    await pool?.query('DELETE FROM discord_guild_members WHERE discord_user_id = $1', [tagDiscordId])
    await pool?.query('DELETE FROM users WHERE username IN ($1, $2)', [adminNev, tagNev])
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
  it('a lejárt tagság NEM jogosít', async () => {
    await pool.query(
      "UPDATE discord_guild_members SET fetched_at = now() - interval '1 day' WHERE discord_user_id = $1",
      [tagDiscordId])
    const res = await hivas('GET', `/v1/discord/guilds/${MIENK}/persistent-messages`, tagToken)
    assert.equal(res.statusCode, 403)
    assert.equal(res.json().detail, 'stale')
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
    const animeMezo = embed.fields.find((f: { name: string }) => f.name === 'Animék')
    const valodi = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM anime WHERE visibility = 'public'")
    assert.equal(animeMezo.value, String(valodi.rows[0]!.n), 'az embed száma nem a katalógusból jön')
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
})
