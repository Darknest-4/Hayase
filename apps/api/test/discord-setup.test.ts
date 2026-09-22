// A DISCORD-SETUP — idempotencia, örökbefogadás, védett takarítás.
//
// HAMIS DISCORDDAL, A `fetch` SZINTJÉN. Nem a REST-klienst cseréljük ki,
// hanem a hálózatot: így a valódi `rest-client.ts` is végigfut — az
// azonosító-ellenőrzés, a hibabesorolás és az audit-fejléc is. Egy
// kicserélt kliensnél mindez kimaradna a mérésből.
//
// A KÉSZLET LEGFONTOSABB ÁLLÍTÁSAI:
//
//   1. Kétszer lefuttatva nem jön létre semmi másodszor.
//   2. Az azonos nevű, IDEGEN objektumot örökbe fogadjuk, de SOHA nem
//      töröljük — a gyári visszaállítás sem.
//   3. A megerősítő jegy egyszer használható, lejár, és a LISTÁHOZ van kötve.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it, mock } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'discord-setup-secret-long-enough-0123456789'
process.env.DISCORD_BOT_TOKEN ??= 'teszt-bot-token-nem-valodi'

let setup: typeof import('../src/modules/discord/setup.ts')
let registry: typeof import('../src/modules/discord/registry.ts')
let structure: typeof import('../src/modules/discord/structure.ts')
let db: typeof import('../src/infrastructure/database/index.ts')

const GUILD = '100000000000000' + Math.floor(Math.random() * 900 + 100)

/** A bot rangjának pozíciója. A fölötte lévő rangokhoz nem nyúlhat. */
const BOT_ROLE_POS = 50

// ---------------------------------------------------------------- hamis Discord

interface FakeState {
  channels: Array<{ id: string, name: string, type: number, position: number, parent_id: string | null }>
  roles: Array<{ id: string, name: string, color: number, position: number, managed: boolean, permissions: string }>
  /** Mit NEM enged a hamis Discord — a jogosultsági ágak méréséhez. */
  deny: Set<string>
  calls: string[]
}

let allapot: FakeState

function ujAllapot (): FakeState {
  return {
    channels: [],
    roles: [
      // Az `@everyone` azonosítója a guild azonosítója — a Discord így adja.
      { id: GUILD, name: '@everyone', color: 0, position: 0, managed: false, permissions: '0' },
      { id: '900000000000000001', name: 'YUME Bot', color: 0, position: BOT_ROLE_POS, managed: true, permissions: String((1n << 4n) | (1n << 28n)) }
    ],
    deny: new Set(),
    calls: []
  }
}

let idSzamlalo = 1
const ujId = (): string => `70000000000000${String(idSzamlalo++).padStart(4, '0')}`

function hamisDiscord (): void {
  mock.method(globalThis, 'fetch', async (url: string, init?: { method?: string, body?: string }) => {
    const u = new URL(String(url))
    const path = u.pathname.replace('/api/v10', '')
    const method = init?.method ?? 'GET'
    allapot.calls.push(`${method} ${path}`)
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : {}

    const valasz = (status: number, data: unknown) => ({
      ok: status < 400, status, json: async () => data
    })

    if (allapot.deny.has(`${method} ${path}`)) {
      return valasz(403, { code: 50013, message: 'Missing Permissions' })
    }

    if (method === 'GET' && path === `/guilds/${GUILD}/channels`) return valasz(200, allapot.channels)
    if (method === 'GET' && path === `/guilds/${GUILD}/roles`) return valasz(200, allapot.roles)
    // A BOT SAJÁT AZONOSÍTÓJA. A `@me` tag-végpont bot tokennel NEM
    // működik (50035) — élesben mérve; a kliens ezért előbb ezt kérdezi.
    if (method === 'GET' && path === '/users/@me') {
      return valasz(200, { id: '800000000000000002', username: 'YumeBot' })
    }
    if (method === 'GET' && path === `/guilds/${GUILD}/members/800000000000000002`) {
      return valasz(200, { roles: ['900000000000000001'] })
    }
    if (method === 'GET' && path === `/guilds/${GUILD}/members/@me`) {
      // A hamis Discord is úgy viselkedik, mint az igazi: ezt elutasítja.
      return valasz(400, { code: 50035, message: 'Invalid Form Body' })
    }
    if (method === 'GET' && path.startsWith(`/guilds/${GUILD}`)) {
      return valasz(200, { name: 'Próba szerver', approximate_member_count: 10, approximate_presence_count: 3 })
    }
    if (method === 'GET' && path === '/applications/@me') return valasz(200, { id: '800000000000000001' })

    if (method === 'POST' && path === `/guilds/${GUILD}/channels`) {
      const id = ujId()
      allapot.channels.push({
        id,
        name: String(body.name ?? ''),
        type: Number(body.type ?? 0),
        position: allapot.channels.length,
        parent_id: body.parent_id ? String(body.parent_id) : null
      })
      return valasz(201, { id })
    }
    if (method === 'PATCH' && /^\/channels\/\d+$/.test(path)) {
      const id = path.split('/')[2]!
      const cs = allapot.channels.find(c => c.id === id)
      if (cs && body.name) cs.name = String(body.name)
      return valasz(200, { id })
    }
    if (method === 'DELETE' && /^\/channels\/\d+$/.test(path)) {
      const id = path.split('/')[2]!
      const i = allapot.channels.findIndex(c => c.id === id)
      if (i < 0) return valasz(404, { code: 10003, message: 'Unknown Channel' })
      allapot.channels.splice(i, 1)
      return valasz(204, {})
    }

    if (method === 'POST' && path === `/guilds/${GUILD}/roles`) {
      const id = ujId()
      allapot.roles.push({
        id,
        name: String(body.name ?? ''),
        color: Number(body.color ?? 0),
        position: 1,
        managed: false,
        permissions: String(body.permissions ?? '0')
      })
      return valasz(201, { id })
    }
    if (method === 'PATCH' && /^\/guilds\/\d+\/roles\/\d+$/.test(path)) {
      const id = path.split('/')[4]!
      const r = allapot.roles.find(x => x.id === id)
      if (r) {
        if (body.name) r.name = String(body.name)
        if (body.permissions !== undefined) r.permissions = String(body.permissions)
      }
      return valasz(200, { id })
    }
    if (method === 'DELETE' && /^\/guilds\/\d+\/roles\/\d+$/.test(path)) {
      const id = path.split('/')[4]!
      const i = allapot.roles.findIndex(x => x.id === id)
      if (i < 0) return valasz(404, { code: 10011, message: 'Unknown Role' })
      allapot.roles.splice(i, 1)
      return valasz(204, {})
    }

    return valasz(404, { message: 'nincs ilyen útvonal a hamis Discordban: ' + path })
  })
}

describe('a Discord-setup', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    setup = await import('../src/modules/discord/setup.ts')
    registry = await import('../src/modules/discord/registry.ts')
    structure = await import('../src/modules/discord/structure.ts')
    db = await import('../src/infrastructure/database/index.ts')
  })

  beforeEach(async () => {
    mock.restoreAll()
    allapot = ujAllapot()
    hamisDiscord()
    // A bot azonosítója gyorsítótárazódik; a tesztek közt el kell felejteni.
    const rest = await import('../src/modules/discord/rest-client.ts')
    rest.forgetBotUser()
    await db.query('DELETE FROM discord_registry WHERE guild_id = $1', [GUILD])
    await db.query('DELETE FROM discord_registry_events WHERE guild_id = $1', [GUILD])
    await db.query('DELETE FROM discord_setup_runs WHERE guild_id = $1', [GUILD])
    await db.query('DELETE FROM discord_confirmations WHERE guild_id = $1', [GUILD])
    await db.query('DELETE FROM persistent_messages WHERE guild_id = $1', [GUILD])
  })

  after(async () => {
    mock.restoreAll()
    await db.query('DELETE FROM discord_registry WHERE guild_id = $1', [GUILD])
    await db.query('DELETE FROM discord_registry_events WHERE guild_id = $1', [GUILD])
    await db.query('DELETE FROM discord_setup_runs WHERE guild_id = $1', [GUILD])
    await db.query('DELETE FROM discord_confirmations WHERE guild_id = $1', [GUILD])
    await db.query('DELETE FROM persistent_messages WHERE guild_id = $1', [GUILD])
  })

  // ---- terv ----

  it('üres szerveren mindent létrehozandónak lát', async () => {
    const terv = await setup.plan(GUILD)
    assert.equal(terv.blocked, false, `blokkolt: ${JSON.stringify(terv.missingPermissions)}`)
    assert.ok(terv.steps.every(s => s.action === 'create'),
      `nem mind létrehozandó: ${terv.steps.filter(s => s.action !== 'create').map(s => s.key + '=' + s.action).join(', ')}`)
    const varhato = structure.CATEGORIES.length + structure.allChannels().length +
      structure.ROLES.length + structure.PERSISTENT_MESSAGES.length
    assert.equal(terv.steps.length, varhato)
  })

  it('az előnézet SEMMIT nem módosít', async () => {
    await setup.plan(GUILD)
    assert.equal(allapot.channels.length, 0, 'a terv létrehozott valamit')
    assert.ok(!allapot.calls.some(c => c.startsWith('POST')), `írt a Discordra: ${allapot.calls.join(', ')}`)
  })

  // ---- idempotencia ----

  it('lefuttatva létrehozza a struktúrát', async () => {
    const e = await setup.apply(GUILD, 'setup', null)
    assert.equal(e.status, 'ok', JSON.stringify(e.counts))
    assert.equal(allapot.channels.filter(c => c.type === 4).length, structure.CATEGORIES.length)
    assert.equal(allapot.channels.filter(c => c.type === 0).length, structure.allChannels().length)
    // Az `@everyone` és a bot rangja mellé a négy YUME-rang.
    assert.equal(allapot.roles.length, 2 + structure.ROLES.length)
  })

  /*
   * EZ A KÉSZLET LEGFONTOSABB TÉTELE. Egy nem idempotens setup minden
   * futásnál megduplázná a szervert — és a hiba csak a második futáskor
   * látszik, amit fejlesztés közben ritkán csinál meg az ember.
   */
  it('MÁSODSZOR nem hoz létre semmit', async () => {
    await setup.apply(GUILD, 'setup', null)
    const csatornakElso = allapot.channels.length
    const rangokElso = allapot.roles.length

    allapot.calls.length = 0
    const masodik = await setup.apply(GUILD, 'setup', null)

    assert.equal(allapot.channels.length, csatornakElso, 'duplikált csatorna jött létre')
    assert.equal(allapot.roles.length, rangokElso, 'duplikált rang jött létre')
    assert.ok(!allapot.calls.some(c => c.startsWith('POST /guilds')), 'létrehozó hívás ment ki')
    assert.equal(masodik.counts.created ?? 0, 0)
    assert.ok((masodik.counts.skipped ?? 0) > 0)
    /*
     * ÉS `adopted` SEM. Ez szabotázzsal derült ki: ha a terv NEM nézi a
     * registryt, a névegyezés második védvonalként megfogja a duplikációt —
     * a szerveren nem lesz kétszer ugyanaz a csatorna —, de a rendszer
     * minden futáskor ÚJRA örökbe fogadná a saját objektumait, és onnantól
     * idegennek hinné őket. A gyári visszaállítás így soha nem takarítana
     * ki semmit.
     *
     * A második futásnak tehát `skipped`-nek kell lennie, nem
     * `adopted`-nek: ez méri, hogy tényleg a registry döntött.
     */
    assert.equal(masodik.counts.adopted ?? 0, 0,
      'a második futás újra örökbe fogadta a saját objektumait — a registry nem döntött')
  })

  it('a registry minden objektumot nyilvántart', async () => {
    await setup.apply(GUILD, 'setup', null)
    const sorok = await registry.list(GUILD)
    const varhato = structure.CATEGORIES.length + structure.allChannels().length +
      structure.ROLES.length + structure.PERSISTENT_MESSAGES.length
    assert.equal(sorok.length, varhato)
    assert.ok(sorok.every(s => s.created_by_yume), 'valamit nem magunkénak jelölt')
  })

  // ---- örökbefogadás ----

  /*
   * AZONOS NEVŰ, DE IDEGEN OBJEKTUM. Nem hozunk létre másodikat — az
   * duplikáció volna —, de nem is tekintjük a sajátunknak.
   */
  it('az azonos nevű meglévő csatornát örökbe fogadja, nem duplikálja', async () => {
    const idegenId = '600000000000000001'
    allapot.channels.push({ id: idegenId, name: '💬・altalanos', type: 0, position: 0, parent_id: null })

    const terv = await setup.plan(GUILD)
    const lepes = terv.steps.find(s => s.key === 'channel:altalanos')
    assert.equal(lepes?.action, 'adopt')

    await setup.apply(GUILD, 'setup', null)
    assert.equal(allapot.channels.filter(c => c.name === '💬・altalanos').length, 1,
      'második, azonos nevű csatorna jött létre')

    const sor = await registry.get(GUILD, 'channel', 'channel:altalanos')
    assert.equal(sor?.discord_object_id, idegenId)
    assert.equal(sor?.created_by_yume, false, 'sajátjaként vette nyilvántartásba egy idegen csatornát')
  })

  it('az örökbe fogadott objektumot a GYÁRI VISSZAÁLLÍTÁS SEM törli', async () => {
    const idegenId = '600000000000000002'
    allapot.channels.push({ id: idegenId, name: '💬・altalanos', type: 0, position: 0, parent_id: null })
    await setup.apply(GUILD, 'setup', null)

    const celok = await setup.resetTargets(GUILD)
    assert.ok(!celok.deletable.some(t => t.objectId === idegenId), 'törlendőnek jelölte az idegen csatornát')
    assert.ok(celok.protected.some(t => t.objectId === idegenId), 'nem jelölte védettnek')

    await setup.factoryReset(GUILD, null)
    assert.ok(allapot.channels.some(c => c.id === idegenId),
      'A GYÁRI VISSZAÁLLÍTÁS TÖRÖLT EGY IDEGEN CSATORNÁT')
  })

  // ---- jogosultság és hierarchia ----

  it('jogosultság nélkül blokkoltnak jelöl, nem próbálkozik', async () => {
    // A bot rangjából elvesszük a csatornakezelést.
    allapot.roles[1]!.permissions = String(1n << 28n)
    const terv = await setup.plan(GUILD)
    assert.equal(terv.blocked, true)
    assert.ok(terv.missingPermissions.includes('Csatornák kezelése'))
    assert.ok(terv.steps.filter(s => s.type === 'channel').every(s => s.action === 'blocked'))

    allapot.calls.length = 0
    const e = await setup.apply(GUILD, 'setup', null)
    assert.ok(!allapot.calls.some(c => c === `POST /guilds/${GUILD}/channels`),
      'blokkolt lépésnél is próbált létrehozni')
    assert.notEqual(e.status, 'ok')
  })

  /*
   * A RANGSORREND KEMÉNY KORLÁT. A Discord nem engedi, hogy a bot a sajátja
   * fölötti rangot módosítsa — és ezt előre megnézzük, mert különben a hiba
   * egy értelmezhetetlen „hiányzó jogosultság" lenne.
   */
  it('a bot fölötti rangot nem próbálja módosítani', async () => {
    allapot.roles.push({
      id: '600000000000000003', name: 'YUME Moderator', color: 0,
      position: BOT_ROLE_POS + 10, managed: false, permissions: '0'
    })
    const terv = await setup.plan(GUILD)
    const lepes = terv.steps.find(s => s.key === 'role:moderator')
    assert.equal(lepes?.action, 'blocked')
    assert.match(String(lepes?.reason), /fölött/)
  })

  it('egy elbukott lépés nem állítja meg a többit', async () => {
    // A rangok létrehozását tiltjuk; a csatornáknak menniük kell.
    allapot.deny.add(`POST /guilds/${GUILD}/roles`)
    const e = await setup.apply(GUILD, 'setup', null)
    assert.equal(e.status, 'partial', JSON.stringify(e.counts))
    assert.ok((e.counts.created ?? 0) > 0, 'semmi nem jött létre')
    assert.equal(e.counts.failed, structure.ROLES.length)
    assert.equal(allapot.channels.filter(c => c.type === 0).length, structure.allChannels().length)
  })

  // ---- eltűnt objektum ----

  it('a Discordból kézzel törölt objektumot újra létrehozza', async () => {
    await setup.apply(GUILD, 'setup', null)
    const sor = await registry.get(GUILD, 'channel', 'channel:statisztika')
    const regiId = sor!.discord_object_id!
    allapot.channels = allapot.channels.filter(c => c.id !== regiId)

    const terv = await setup.plan(GUILD)
    assert.equal(terv.steps.find(s => s.key === 'channel:statisztika')?.action, 'recreate')

    await setup.apply(GUILD, 'repair', null)
    const uj = await registry.get(GUILD, 'channel', 'channel:statisztika')
    assert.ok(uj?.discord_object_id && uj.discord_object_id !== regiId, 'nem jött létre újra')
  })

  it('az újraszinkronizálás felismeri az eltűnt objektumot', async () => {
    await setup.apply(GUILD, 'setup', null)
    const sor = await registry.get(GUILD, 'role', 'role:verified')
    allapot.roles = allapot.roles.filter(r => r.id !== sor!.discord_object_id)

    const eredmeny = await setup.resync(GUILD, null)
    assert.ok(eredmeny.orphaned.includes('role:verified'))
    // A SOR MEGMARAD, csak az azonosítót engedi el: így marad meg az, hogy
    // ez a MI objektumunk volt.
    const utana = await registry.get(GUILD, 'role', 'role:verified')
    assert.ok(utana, 'a sor eltűnt')
    assert.equal(utana?.discord_object_id, null)
  })

  // ---- gyári visszaállítás ----

  it('csak azt törli, amit ő hozott létre', async () => {
    const idegenCsatorna = '600000000000000004'
    const idegenRang = '600000000000000005'
    allapot.channels.push({ id: idegenCsatorna, name: 'valaki-mase', type: 0, position: 0, parent_id: null })
    allapot.roles.push({ id: idegenRang, name: 'Más Bot', color: 0, position: 1, managed: true, permissions: '0' })

    await setup.apply(GUILD, 'setup', null)
    await setup.factoryReset(GUILD, null)

    assert.ok(allapot.channels.some(c => c.id === idegenCsatorna), 'idegen csatornát törölt')
    assert.ok(allapot.roles.some(r => r.id === idegenRang), 'idegen rangot törölt')
    // Az `@everyone` SOHA.
    assert.ok(allapot.roles.some(r => r.id === GUILD), 'az @everyone rangot törölte')
    // A sajátjaiból viszont semmi nem maradt.
    assert.equal(allapot.channels.filter(c => c.name.includes('・')).length, 0, 'saját csatorna maradt')
  })

  it('a takarítás után a registry lezárul', async () => {
    await setup.apply(GUILD, 'setup', null)
    await setup.factoryReset(GUILD, null)
    const sorok = await registry.list(GUILD)
    assert.equal(sorok.length, 0, `${sorok.length} élő sor maradt`)
    // A történet viszont megmarad.
    const naplo = await registry.history(GUILD, 500)
    assert.ok(naplo.some(e => e.action === 'deleted'), 'nincs törlési bejegyzés a naplóban')
  })

  // ---- megerősítő jegy ----

  it('a jegy EGYSZER használható', async () => {
    await setup.apply(GUILD, 'setup', null)
    const celok = await setup.resetTargets(GUILD)
    const hash = setup.targetsHash(celok.deletable)
    const { rows } = await db.pool.query<{ id: string }>('SELECT id FROM users LIMIT 1')
    if (!rows[0]) return
    const jegy = await setup.issueConfirmation(GUILD, rows[0].id, 'factory_reset', hash)

    assert.equal(await setup.consumeConfirmation(jegy, GUILD, rows[0].id, 'factory_reset', hash), true)
    assert.equal(await setup.consumeConfirmation(jegy, GUILD, rows[0].id, 'factory_reset', hash), false,
      'másodszor is beváltható volt')
  })

  /*
   * A JEGY A LISTÁHOZ VAN KÖTVE. Ha az előnézet óta változott a törlendők
   * köre — mert közben valaki lefuttatta a setupot —, a megerősítés már nem
   * arra vonatkozik, amit a felhasználó látott.
   */
  it('a jegy érvénytelen, ha közben változott a törlendők listája', async () => {
    await setup.apply(GUILD, 'setup', null)
    const { rows } = await db.pool.query<{ id: string }>('SELECT id FROM users LIMIT 1')
    if (!rows[0]) return
    const regi = setup.targetsHash((await setup.resetTargets(GUILD)).deletable)
    const jegy = await setup.issueConfirmation(GUILD, rows[0].id, 'factory_reset', regi)

    // Közben eltűnik egy objektum → más lista, más ujjlenyomat.
    const sor = await registry.get(GUILD, 'channel', 'channel:altalanos')
    await registry.close(sor!.id)
    const uj = setup.targetsHash((await setup.resetTargets(GUILD)).deletable)

    assert.notEqual(regi, uj)
    assert.equal(await setup.consumeConfirmation(jegy, GUILD, rows[0].id, 'factory_reset', uj), false)
  })

  it('más felhasználó jegyét nem fogadja el', async () => {
    const { rows } = await db.pool.query<{ id: string }>('SELECT id FROM users LIMIT 2')
    if (rows.length < 2) return
    const hash = 'proba-hash'
    const jegy = await setup.issueConfirmation(GUILD, rows[0]!.id, 'factory_reset', hash)
    assert.equal(await setup.consumeConfirmation(jegy, GUILD, rows[1]!.id, 'factory_reset', hash), false)
  })

  it('rövid vagy hiányzó jegyet elutasít', async () => {
    for (const rossz of ['', 'rovid', 'x'.repeat(19)]) {
      assert.equal(await setup.consumeConfirmation(rossz, GUILD, '00000000-0000-0000-0000-000000000000', 'factory_reset', 'h'), false)
    }
  })

  // ---- a struktúra épsége ----

  it('egyetlen rang sem kap adminisztrátori jogot', async () => {
    const ADMIN = 1n << 3n
    for (const r of structure.ROLES) {
      const bits = BigInt(structure.permissionBits(r))
      assert.equal(bits & ADMIN, 0n, `${r.name} adminisztrátori jogot kapna`)
    }
  })

  it('a YUME Verified semmilyen jogot nem ad', async () => {
    const v = structure.ROLES.find(r => r.key === 'role:verified')!
    assert.equal(structure.permissionBits(v), '0')
  })

  it('a logikai kulcsok egyediek', () => {
    const kulcsok = [
      ...structure.CATEGORIES.map(c => c.key),
      ...structure.allChannels().map(c => c.key),
      ...structure.ROLES.map(r => r.key),
      ...structure.PERSISTENT_MESSAGES.map(p => p.key)
    ]
    assert.equal(new Set(kulcsok).size, kulcsok.length, 'ütköző logikai kulcs van a leírásban')
  })

  it('minden tartós üzenet létező csatornába mutat', () => {
    const csatornak = new Set(structure.allChannels().map(c => c.key))
    for (const pm of structure.PERSISTENT_MESSAGES) {
      assert.ok(csatornak.has(pm.channelKey), `${pm.key} nem létező csatornára mutat: ${pm.channelKey}`)
    }
  })
})
