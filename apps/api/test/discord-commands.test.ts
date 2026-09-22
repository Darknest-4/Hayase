// SLASH PARANCSOK — jogosultság, cooldown, bemenet, válasz.
//
// A KÉSZLET LEGFONTOSABB ÁLLÍTÁSA: az adminparancsokat a KISZOLGÁLÓ is
// ellenőrzi. A Discord `default_member_permissions` mezője csak ELREJTI a
// parancsot annak, akinek nincs joga — a kliens megkerülhető, a kiszolgáló
// nem. Aki csak az elrejtésre hagyatkozik, az egy `curl`-lel kinyitható
// adminfelületet épít.

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it, mock } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'discord-commands-secret-long-enough-0123456789'
process.env.DISCORD_BOT_TOKEN ??= 'teszt-bot-token-nem-valodi'

let commands: typeof import('../src/modules/discord/commands.ts')
let events: typeof import('../src/modules/analytics/events.ts')
let db: typeof import('../src/infrastructure/database/index.ts')

const GUILD = '400000000000000777'
const MANAGE_GUILD = String(1n << 5n)

function interakcio (extra: Partial<import('../src/modules/discord/commands.ts').Interaction> = {}): never {
  return {
    id: '500000000000000001',
    token: 'interakcio-token',
    type: 2,
    guildId: GUILD,
    channelId: '600000000000000001',
    userId: '700000000000000001',
    username: 'teszt',
    permissions: '0',
    command: 'help',
    sub: null,
    options: {},
    ...extra
  } as never
}

describe('a slash parancsok', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    commands = await import('../src/modules/discord/commands.ts')
    events = await import('../src/modules/analytics/events.ts')
    db = await import('../src/infrastructure/database/index.ts')
  })

  beforeEach(() => {
    commands.resetCooldowns()
    events.reset()
    mock.restoreAll()
  })

  after(async () => {
    events.reset()
    await db.query("DELETE FROM analytics_events WHERE event_type = 'discord.command.use' AND subject_id LIKE '%' AND visitor_key = $1",
      ['discord:700000000000000001'])
  })

  // ---- a leírás ----

  it('minden parancsnak van neve és leírása', () => {
    for (const d of commands.DEFINITIONS) {
      assert.ok(d.name.length > 0 && d.name.length <= 32, d.name)
      assert.ok(d.description.length > 0 && d.description.length <= 100, d.name)
      // A Discord csak kisbetűs nevet fogad el.
      assert.match(d.name, /^[a-z-]+$/, d.name)
    }
  })

  it('a parancsnevek egyediek', () => {
    const nevek = commands.DEFINITIONS.map(d => d.name)
    assert.equal(new Set(nevek).size, nevek.length)
  })

  /*
   * AZ ADMINPARANCSOK A DISCORDON IS EL VANNAK REJTVE. Ez kényelem — a
   * védelem a kezelőben van —, de a kettő együtt a helyes: aki nem
   * adminisztrátor, az ne is lássa.
   */
  it('az adminparancsok jogosultsághoz vannak kötve a leírásban is', () => {
    for (const nev of ['setup', 'config', 'announce', 'logs']) {
      const d = commands.DEFINITIONS.find(x => x.name === nev)!
      assert.ok('default_member_permissions' in d, `${nev}: nincs jogosultsági korlát`)
    }
  })

  // ---- bemenet ----

  it('a nyers interakcióból kiolvassa az alparancsot és a beállításokat', () => {
    const i = commands.parseInteraction({
      id: '1'.repeat(18),
      token: 'tok',
      type: 2,
      guild_id: GUILD,
      member: { permissions: MANAGE_GUILD, user: { id: '2'.repeat(18), username: 'a' } },
      data: {
        name: 'anime',
        options: [{ type: 1, name: 'search', options: [{ type: 3, name: 'cim', value: 'naruto' }] }]
      }
    })
    assert.equal(i?.command, 'anime')
    assert.equal(i?.sub, 'search')
    assert.equal(i?.options.cim, 'naruto')
    assert.equal(i?.permissions, MANAGE_GUILD)
  })

  it('hiányos interakciót elutasít', () => {
    assert.equal(commands.parseInteraction({}), null)
    assert.equal(commands.parseInteraction({ id: 'x', token: 't' }), null)
    assert.equal(commands.parseInteraction(null), null)
  })

  // ---- jogosultság ----

  it('adminparancs jogosultság nélkül elutasítva', async () => {
    for (const parancs of ['setup', 'config', 'announce', 'logs']) {
      const e = await commands.handle(interakcio({ command: parancs, permissions: '0' }))
      assert.equal(e.outcome, 'forbidden', `${parancs} átment jogosultság nélkül`)
    }
  })

  it('adminparancs MANAGE_GUILD-dal átmegy', async () => {
    const e = await commands.handle(interakcio({ command: 'setup', permissions: MANAGE_GUILD }))
    assert.equal(e.outcome, 'ok')
  })

  /*
   * A JOGOSULATLAN HÍVÁS NE KAPJON COOLDOWNT. Abból ki lehetne olvasni,
   * hogy a parancs létezik-e: a jogosulatlan válasz azonnal jön, a
   * cooldownos várakoztatva.
   */
  it('a jogosulatlan hívás nem állít cooldownt', async () => {
    await commands.handle(interakcio({ command: 'setup', permissions: '0' }))
    assert.equal(commands.cooldownLeft('700000000000000001', 'setup'), 0)
  })

  // ---- cooldown ----

  it('a gyors ismétlést visszatartja', async () => {
    const elso = await commands.handle(interakcio({ command: 'help' }))
    assert.equal(elso.outcome, 'ok')
    const masodik = await commands.handle(interakcio({ command: 'help' }))
    assert.equal(masodik.outcome, 'cooldown')
  })

  it('a cooldown parancsonként külön van', async () => {
    await commands.handle(interakcio({ command: 'help' }))
    const masik = await commands.handle(interakcio({ command: 'stats' }))
    assert.equal(masik.outcome, 'ok', 'egy másik parancs is cooldownba került')
  })

  it('a cooldown felhasználónként külön van', async () => {
    await commands.handle(interakcio({ command: 'help' }))
    const masik = await commands.handle(interakcio({ command: 'help', userId: '700000000000000002' }))
    assert.equal(masik.outcome, 'ok', 'másik felhasználót is visszatartott')
  })

  // ---- válaszok ----

  it('ismeretlen parancsra is válaszol', async () => {
    const e = await commands.handle(interakcio({ command: 'nincs-ilyen' }))
    assert.equal(e.outcome, 'unknown')
    assert.ok(e.response, 'nem adott választ — a Discord „nem válaszolt" hibát írna ki')
  })

  it('a válasz soha nem említ senkit', async () => {
    for (const parancs of ['help', 'stats', 'status']) {
      commands.resetCooldowns()
      const e = await commands.handle(interakcio({ command: parancs }))
      const data = (e.response as { data: { allowed_mentions: { parse: string[] } } }).data
      assert.deepEqual(data.allowed_mentions.parse, [], `${parancs}: említést engedne`)
    }
  })

  it('a /help felsorolja a parancsokat', async () => {
    const e = await commands.handle(interakcio({ command: 'help' }))
    const embed = (e.response as { data: { embeds: Array<{ description: string }> } }).data.embeds[0]!
    for (const nev of ['/status', '/stats', '/anime', '/profile']) {
      assert.ok(embed.description.includes(nev), `hiányzik a listából: ${nev}`)
    }
  })

  it('a /stats a katalógus VALÓDI számait adja', async () => {
    const e = await commands.handle(interakcio({ command: 'stats' }))
    const mezok = (e.response as { data: { embeds: Array<{ fields: Array<{ name: string, value: string }> }> } })
      .data.embeds[0]!.fields
    const anime = mezok.find(f => f.name === 'Animék')!
    const valodi = await db.queryOne<{ n: number }>(
      "SELECT count(*)::int AS n FROM anime WHERE visibility = 'public'")
    assert.equal(anime.value, String(valodi?.n ?? 0), 'nem a katalógusból jön a szám')
  })

  it('a rövid keresést elutasítja', async () => {
    const e = await commands.handle(interakcio({ command: 'anime', sub: 'search', options: { cim: 'a' } }))
    const tartalom = (e.response as { data: { content: string } }).data.content
    assert.match(tartalom, /két karakter/)
  })

  it('nem létező címre üres választ ad, nem hibát', async () => {
    const e = await commands.handle(interakcio({
      command: 'anime', sub: 'search', options: { cim: 'zzzz-biztosan-nincs-ilyen-cim-zzzz' }
    }))
    assert.equal(e.outcome, 'ok')
    assert.match((e.response as { data: { content: string } }).data.content, /Nincs találat/)
  })

  it('a /link a vezérlőpultra küld, nem tesz úgy, mintha összekötne', async () => {
    const e = await commands.handle(interakcio({ command: 'link' }))
    const tartalom = (e.response as { data: { content: string } }).data.content
    assert.match(tartalom, /discord\.animehub\.hu|settings/)
  })

  it('a szerveren kívüli használatot kezeli', async () => {
    const e = await commands.handle(interakcio({ command: 'notifications', guildId: null }))
    assert.match((e.response as { data: { content: string } }).data.content, /csak szerveren/)
  })

  // ---- analitika ----

  /*
   * A HASZNÁLAT A MEGLÉVŐ ESEMÉNYSÉMÁBA MEGY, nem külön táblába: ugyanolyan
   * „ki, mit, mikor" esemény, mint a többi, és a deduplikáció is kell rá.
   */
  it('a sikeres parancs eseményt ír', async () => {
    await commands.handle(interakcio({ command: 'help' }))
    assert.equal(events.pending(), 1, 'nem keletkezett esemény')
    await events.flush()
    const sor = await db.queryOne<{ subject_id: string }>(
      `SELECT subject_id FROM analytics_events
        WHERE event_type = 'discord.command.use' AND visitor_key = $1
        ORDER BY created_at DESC LIMIT 1`, ['discord:700000000000000001'])
    assert.equal(sor?.subject_id, 'help')
  })

  it('a jogosulatlan hívás NEM ír eseményt', async () => {
    await commands.handle(interakcio({ command: 'setup', permissions: '0' }))
    assert.equal(events.pending(), 0, 'jogosulatlan hívásra is mért')
  })

  it('az alparancs is bekerül az esemény alanyába', async () => {
    await commands.handle(interakcio({ command: 'anime', sub: 'latest' }))
    await events.flush()
    const sor = await db.queryOne<{ subject_id: string }>(
      `SELECT subject_id FROM analytics_events
        WHERE event_type = 'discord.command.use' AND visitor_key = $1
        ORDER BY created_at DESC LIMIT 1`, ['discord:700000000000000001'])
    assert.equal(sor?.subject_id, 'anime latest')
  })
})
