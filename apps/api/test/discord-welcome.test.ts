// A KÖSZÖNTŐ RENDSZER.
//
// A KÉSZLET LEGFONTOSABB ÁLLÍTÁSA A DUPLIKÁCIÓVÉDELEM. A gateway egy
// újracsatlakozás után MEGISMÉTELHETI az eseményeket, és egy tag két
// köszöntője rosszabb, mint egy sem: az első kellemes, a második azt üzeni,
// hogy a bot hibás.
//
// A MÁSODIK A SABLON. Egy ismeretlen változó nem maradhat nyersen a
// kimenetben, és az `@everyone` egy köszöntőben minden új tagnál felverné
// az egész szervert — ez nem funkció, hanem baleset.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it, mock } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'discord-welcome-secret-long-enough-0123456789'
process.env.DISCORD_BOT_TOKEN ??= 'teszt-bot-token-nem-valodi'

let welcome: typeof import('../src/modules/discord/welcome.ts')
let db: typeof import('../src/infrastructure/database/index.ts')

const GUILD = '200000000000000' + Math.floor(Math.random() * 900 + 100)
const CSATORNA = '300000000000000777'

/** Mit küldött a bot. A hamis Discord ide gyűjt. */
let kuldott: Array<{ path: string, body: Record<string, unknown> }> = []
let tiltott = new Set<string>()

function hamisDiscord (): void {
  kuldott = []
  mock.method(globalThis, 'fetch', async (url: string, init?: { method?: string, body?: string }) => {
    const path = new URL(String(url)).pathname.replace('/api/v10', '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : {}

    if (tiltott.has(`${method} ${path}`)) {
      return { ok: false, status: 403, json: async () => ({ code: 50013, message: 'Missing Permissions' }) }
    }
    if (method === 'POST' && path.endsWith('/messages')) {
      kuldott.push({ path, body })
      return { ok: true, status: 200, json: async () => ({ id: '400000000000000001' }) }
    }
    if (method === 'GET' && path.startsWith('/guilds/')) {
      return { ok: true, status: 200, json: async () => ({ name: 'Próba szerver', approximate_member_count: 42 }) }
    }
    if (method === 'PUT' && path.includes('/roles/')) {
      kuldott.push({ path, body })
      return { ok: true, status: 204, json: async () => ({}) }
    }
    if (method === 'POST' && path === '/users/@me/channels') {
      return { ok: true, status: 200, json: async () => ({ id: '500000000000000001' }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
}

describe('a köszöntő', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    welcome = await import('../src/modules/discord/welcome.ts')
    db = await import('../src/infrastructure/database/index.ts')
  })

  beforeEach(async () => {
    mock.restoreAll()
    tiltott = new Set()
    hamisDiscord()
    await db.query('DELETE FROM discord_welcome_log WHERE guild_id = $1', [GUILD])
    await db.query('DELETE FROM discord_welcome_config WHERE guild_id = $1', [GUILD])
    await db.query('DELETE FROM discord_registry WHERE guild_id = $1', [GUILD])
  })

  after(async () => {
    mock.restoreAll()
    await db.query('DELETE FROM discord_welcome_log WHERE guild_id = $1', [GUILD])
    await db.query('DELETE FROM discord_welcome_config WHERE guild_id = $1', [GUILD])
    await db.query('DELETE FROM discord_registry WHERE guild_id = $1', [GUILD])
  })

  const bekapcsol = async (extra: Record<string, unknown> = {}) =>
    await welcome.saveConfig(GUILD, { enabled: true, channelId: CSATORNA, ...extra })

  const belep = async (userId = '600000000000000001') =>
    await welcome.handleJoin({ guildId: GUILD, userId, username: 'ujtag' })

  // ---- sablon ----

  it('ismeretlen változót elutasít', () => {
    const e = welcome.validateTemplate('Üdv, {user}! A {nincs_ilyen} változó.')
    assert.equal(e.ok, false)
    assert.match(e.ok === false ? e.error : '', /nincs_ilyen/)
  })

  /*
   * AZ `@everyone` EGY KÖSZÖNTŐBEN MINDEN ÚJ TAGNÁL FELVERNÉ AZ EGÉSZ
   * SZERVERT. Ez nem funkció, hanem baleset — és a leggyakoribb módja, hogy
   * egy jó szándékú beállításból zaklatás legyen.
   */
  it('tömeges említést nem enged a sablonba', () => {
    for (const rossz of ['Üdv @everyone!', 'Hé @here, új tag']) {
      const e = welcome.validateTemplate(rossz)
      assert.equal(e.ok, false, rossz)
    }
  })

  it('üres és túl hosszú sablont elutasít', () => {
    assert.equal(welcome.validateTemplate('').ok, false)
    assert.equal(welcome.validateTemplate('   ').ok, false)
    assert.equal(welcome.validateTemplate('x'.repeat(4000)).ok, false)
  })

  it('az alapértelmezett sablon érvényes', () => {
    assert.equal(welcome.validateTemplate(welcome.DEFAULT_TEMPLATE).ok, true)
  })

  it('minden támogatott változót behelyettesít', () => {
    const sablon = welcome.VARIABLES.map(v => `{${v}}`).join(' ')
    const szoveg = welcome.renderTemplate(sablon, {
      userId: '123456789012345678',
      username: 'teszt',
      serverName: 'Szerver',
      memberCount: 7,
      rulesChannelId: '999999999999999999',
      welcomeChannelId: CSATORNA
    })
    assert.ok(!/\{[a-z_]+\}/.test(szoveg), `maradt behelyettesítetlen változó: ${szoveg}`)
    assert.match(szoveg, /<@123456789012345678>/)
    assert.match(szoveg, /<#999999999999999999>/)
  })

  /*
   * A NULLA ÉS A „NEM TUDJUK" NEM UGYANAZ. Ha nincs létszámadat, nem írunk
   * oda nullát — az azt állítaná, hogy a szervernek nincs tagja.
   */
  it('ismeretlen létszámra nem ír nullát', () => {
    const szoveg = welcome.renderTemplate('Te vagy a {member_count}. tag', {
      userId: '1', username: 'a', serverName: 's', memberCount: null,
      rulesChannelId: null, welcomeChannelId: null
    })
    assert.match(szoveg, /—/)
    assert.ok(!/\b0\b/.test(szoveg))
  })

  it('a beállítás mentése elutasítja a hibás sablont', async () => {
    await assert.rejects(() => welcome.saveConfig(GUILD, { template: 'Üdv {rossz_valtozo}' }), /rossz_valtozo/)
  })

  // ---- küldés ----

  it('kikapcsolva nem küld, de naplóz', async () => {
    await welcome.saveConfig(GUILD, { enabled: false, channelId: CSATORNA })
    assert.equal(await belep(), 'skipped')
    assert.equal(kuldott.length, 0)
    const naplo = await welcome.log(GUILD)
    assert.equal(naplo.length, 1)
    assert.match(String(naplo[0]!.detail), /ki van kapcsolva/)
  })

  it('csatorna nélkül nem küld', async () => {
    await welcome.saveConfig(GUILD, { enabled: true, channelId: null })
    assert.equal(await belep(), 'skipped')
    assert.equal(kuldott.length, 0)
  })

  it('bekapcsolva küld, és említi a tagot', async () => {
    await bekapcsol()
    assert.equal(await belep(), 'sent')
    assert.equal(kuldott.length, 1)
    assert.match(String(kuldott[0]!.body.content), /<@600000000000000001>/)
  })

  /*
   * AZ EMLÍTÉS AZ ÜZENET TÖRZSÉBEN KELL. A Discord az EMBEDBEN lévő
   * említésre nem küld értesítést — a tag nem venné észre a köszöntőt.
   */
  it('az említés a törzsben van, nem csak az embedben', async () => {
    await bekapcsol({ mention: true })
    await belep()
    assert.ok('content' in kuldott[0]!.body, 'nincs törzs az üzenetben')
  })

  it('az említés kikapcsolható', async () => {
    await bekapcsol({ mention: false })
    await belep()
    assert.ok(!('content' in kuldott[0]!.body))
  })

  /*
   * CSAK AZT A TAGOT EMLÍTHETJÜK, AKIRŐL AZ ÜZENET SZÓL. Szerepkört és
   * `@everyone`-t soha — akkor sem, ha a sablonba valahogy bekerülne.
   */
  it('az említések korlátozva vannak', async () => {
    await bekapcsol()
    await belep()
    const am = kuldott[0]!.body.allowed_mentions as { parse: string[], users: string[] }
    assert.deepEqual(am.parse, [])
    assert.deepEqual(am.users, ['600000000000000001'])
  })

  it('ugyanaz a tag MÁSODSZOR nem kap köszöntőt', async () => {
    await bekapcsol()
    assert.equal(await belep(), 'sent')
    assert.equal(await belep(), 'skipped', 'kétszer köszöntött')
    assert.equal(kuldott.length, 1, `${kuldott.length} üzenet ment ki`)
  })

  it('MÁSIK tag viszont kap', async () => {
    await bekapcsol()
    await belep('600000000000000001')
    assert.equal(await belep('600000000000000002'), 'sent')
    assert.equal(kuldott.length, 2)
  })

  it('jogosultsági hibánál failed, és naplóz', async () => {
    await bekapcsol()
    tiltott.add(`POST /channels/${CSATORNA}/messages`)
    assert.equal(await belep(), 'failed')
    const naplo = await welcome.log(GUILD)
    assert.equal(naplo[0]!.outcome, 'failed')
  })

  /*
   * A RANG ÉS A DM NEM BUKTATJA MEG A KÖSZÖNTŐT. Ha az üzenet kiment, a
   * lényeg megtörtént.
   */
  it('a ranghozzárendelés hibája nem buktatja meg a köszöntőt', async () => {
    await db.query(
      `INSERT INTO discord_registry (guild_id, object_type, logical_key, discord_object_id, created_by_yume)
       VALUES ($1, 'role', 'role:verified', '700000000000000001', true)`, [GUILD])
    await bekapcsol({ roleKey: 'role:verified' })
    tiltott.add(`PUT /guilds/${GUILD}/members/600000000000000001/roles/700000000000000001`)
    assert.equal(await belep(), 'sent')
  })

  it('a beállított rangot hozzáadja', async () => {
    await db.query(
      `INSERT INTO discord_registry (guild_id, object_type, logical_key, discord_object_id, created_by_yume)
       VALUES ($1, 'role', 'role:verified', '700000000000000002', true)`, [GUILD])
    await bekapcsol({ roleKey: 'role:verified' })
    await belep()
    assert.ok(kuldott.some(k => k.path.includes('/roles/700000000000000002')), 'nem adta hozzá a rangot')
  })

  it('az előnézet NEM küld', async () => {
    await bekapcsol()
    const e = await welcome.preview(GUILD)
    assert.equal(kuldott.length, 0, 'az előnézet üzenetet küldött')
    assert.ok(e.text.length > 0)
  })
})
