// A Discord gateway — a PROTOKOLL DÖNTÉSEI, valódi kapcsolat nélkül.
//
// MIÉRT ÍGY MÉRHETŐ CSAK. A gateway nehéz része nem a WebSocket, hanem négy
// döntés: mikor folytatunk és mikor azonosítunk újra, meddig várunk egy
// szakadás után, mit teszünk elmaradt szívverés-nyugtánál, és melyik
// lezárásnál NEM szabad újrapróbálni. Ezeket egy éles kapcsolaton nem lehet
// megrendelni — nem lehet azt mondani a Discordnak, hogy „most szakadj meg
// folytatható módon".
//
// AMIT EZ A KÉSZLET NEM ÁLLÍT: hogy a bot tényleg csatlakozik. Ahhoz futó
// gateway kell, és az a bekapcsolás után mérhető, élesben.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'discord-gateway-secret-long-enough-0123456789'

let gw: typeof import('../src/modules/discord/gateway.ts')
let db: typeof import('../src/infrastructure/database/index.ts')

const GUILD = 'gw-teszt-' + randomBytes(3).toString('hex')

describe('a gateway protokollja', () => {
  before(async () => { gw = await import('../src/modules/discord/gateway.ts') })

  // ---- intentek ----

  /*
   * A PRIVILEGIZÁLT INTENTET NEM KÉRJÜK ALAPBÓL, és ez nem óvatoskodás: ha a
   * fejlesztői portálon nincs engedélyezve, a Discord a CSATLAKOZÁST
   * utasítja vissza (4014) — nem kevesebb adatot kapnánk, hanem NULLÁT.
   */
  it('alapból nem kér privilegizált intentet', () => {
    const bits = gw.intentsFromEnv({})
    assert.equal(bits & gw.INTENTS.GUILD_MEMBERS, 0, 'privilegizált intentet kér alapból')
    assert.equal(bits & gw.INTENTS.MESSAGE_CONTENT, 0, 'üzenettartalmat kér — arra nincs szükség a számoláshoz')
    assert.ok(bits & gw.INTENTS.GUILDS)
    assert.ok(bits & gw.INTENTS.GUILD_MESSAGES)
  })

  it('a taglista intentje kifejezett kapcsolóra jön', () => {
    const bits = gw.intentsFromEnv({ DISCORD_GUILD_MEMBERS_INTENT: 'true' })
    assert.ok(bits & gw.INTENTS.GUILD_MEMBERS)
    // Az üzenettartalom AKKOR SEM: azt sosem kérjük.
    assert.equal(bits & gw.INTENTS.MESSAGE_CONTENT, 0)
  })

  // ---- folytatás vagy azonosítás ----

  it('hiányos állapottal nem folytat, hanem azonosít', () => {
    const s = gw.ujAllapot()
    assert.equal(gw.folytathato(s), false)
    s.sessionId = 'abc'
    assert.equal(gw.folytathato(s), false, 'cím és sorszám nélkül is folytatna')
    s.resumeUrl = 'wss://x'
    assert.equal(gw.folytathato(s), false, 'sorszám nélkül is folytatna')
    s.sequence = 5
    assert.equal(gw.folytathato(s), true)
  })

  // ---- várakozás ----

  /*
   * AZ ELSŐ SZAKADÁS UTÁN AZONNAL. A leggyakoribb eset egy pillanatnyi
   * hálózati zökkenő; ott egy másodperc várakozás fölösleges kiesés.
   */
  it('exponenciálisan vár, de korlátosan', () => {
    assert.equal(gw.ujraVaras(0), 0)
    assert.equal(gw.ujraVaras(1), 1000)
    assert.equal(gw.ujraVaras(2), 2000)
    assert.equal(gw.ujraVaras(3), 4000)
    assert.equal(gw.ujraVaras(20), 60_000, 'nincs felső korlát')
  })

  /*
   * AZ ELSŐ SZÍVVERÉS VÉLETLEN KÉSLELTETÉSSEL. A Discord külön kéri:
   * enélkül egy nagy leállás után minden bot egyszerre kezdene szívverni.
   */
  it('az első szívverés az intervallumon belülre esik', () => {
    assert.equal(gw.elsoSzivveres(40_000, 0), 0)
    assert.equal(gw.elsoSzivveres(40_000, 1), 40_000)
    assert.equal(gw.elsoSzivveres(40_000, 0.5), 20_000)
    // Szórás nélkül is az intervallumon belül marad.
    for (let i = 0; i < 20; i++) {
      const v = gw.elsoSzivveres(40_000)
      assert.ok(v >= 0 && v <= 40_000, `kilógott: ${v}`)
    }
  })

  // ---- lezárási kódok ----

  /*
   * A BEÁLLÍTÁSI HIBA NEM ÜZEMZAVAR. Egy rossz token vagy egy nem
   * engedélyezett privilegizált intent újracsatlakozással SOSEM javul meg; a
   * végtelen próbálkozás csak forgalmat gyárt, és elfedi az igazi okot.
   */
  it('a beállítási hibáknál nem próbálkozik újra', () => {
    for (const kod of [4004, 4013, 4014]) {
      assert.equal(gw.vegzetes(kod), true, `${kod} újrapróbálható lenne`)
    }
    for (const kod of [1000, 1006, 4000, 4008, 4009]) {
      assert.equal(gw.vegzetes(kod), false, `${kod} végzetesnek számít`)
    }
  })

  it('a 4014-re érthető magyarázatot ad', () => {
    assert.match(gw.kodMagyarazat(4014), /privilegizált/)
    assert.match(gw.kodMagyarazat(4004), /token/)
  })

  // ---- események ----

  it('a DM-et nem számolja szerverstatisztikába', () => {
    // Nincs `guild_id` — ez privát üzenet, és egy szerver statisztikájába
    // semmi köze.
    assert.equal(gw.esemenyBol('MESSAGE_CREATE', { channel_id: '1', author: {} }), null)
  })

  it('a bot üzenetét megkülönbözteti', () => {
    const e = gw.esemenyBol('MESSAGE_CREATE', { guild_id: 'g', channel_id: 'c', author: { bot: true } })
    assert.deepEqual(e, { kind: 'message', guildId: 'g', channelId: 'c', bot: true })
  })

  it('a nem érdekes eseményt eldobja', () => {
    for (const t of ['PRESENCE_UPDATE', 'TYPING_START', 'VOICE_STATE_UPDATE', 'MESSAGE_REACTION_ADD']) {
      assert.equal(gw.esemenyBol(t, { guild_id: 'g' }), null, `${t} nem lett eldobva`)
    }
  })

  it('a GUILD_CREATE-ből taglétszám lesz', () => {
    assert.deepEqual(gw.esemenyBol('GUILD_CREATE', { id: 'g', member_count: 42 }),
      { kind: 'memberCount', guildId: 'g', memberCount: 42 })
    // Létszám nélkül is érvényes esemény — de a szám NULL, nem nulla.
    assert.deepEqual(gw.esemenyBol('GUILD_CREATE', { id: 'g' }),
      { kind: 'memberCount', guildId: 'g', memberCount: null })
  })

  // ---- élőség ----

  /*
   * A `status` MEZŐ ÖNMAGÁBAN NEM BIZONYÍT SEMMIT. Egy lefagyott folyamat
   * `ready` állapotban hagyja a sort, és onnantól a felület örökké azt
   * hinné, hogy gyűjtünk. Az utolsó esemény ideje a valódi jel.
   */
  it('a lefagyott kapcsolatot nem tekinti élőnek', () => {
    const most = Date.now()
    assert.equal(gw.elo({ status: 'ready', last_event_at: new Date(most - 1000).toISOString() }, most), true)
    assert.equal(gw.elo({ status: 'ready', last_event_at: new Date(most - 10 * 60_000).toISOString() }, most), false,
      'tíz perce nem jött esemény, mégis élőnek mondja')
    assert.equal(gw.elo({ status: 'disconnected', last_event_at: new Date(most).toISOString() }, most), false)
    assert.equal(gw.elo(undefined, most), false)
  })
})

describe('a gateway gyűjtője', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    gw = await import('../src/modules/discord/gateway.ts')
    db = await import('../src/infrastructure/database/index.ts')
  })

  beforeEach(async () => {
    await db.query('DELETE FROM discord_message_stats_daily WHERE guild_id = $1', [GUILD])
    await db.query('DELETE FROM discord_member_stats_daily WHERE guild_id = $1', [GUILD])
  })

  after(async () => {
    await db.query('DELETE FROM discord_message_stats_daily WHERE guild_id = $1', [GUILD])
    await db.query('DELETE FROM discord_member_stats_daily WHERE guild_id = $1', [GUILD])
  })

  it('csatornánként számol, és a botot külön', async () => {
    const gy = new gw.Gyujto()
    gy.uzenet({ guildId: GUILD, channelId: 'a', bot: false })
    gy.uzenet({ guildId: GUILD, channelId: 'a', bot: false })
    gy.uzenet({ guildId: GUILD, channelId: 'a', bot: true })
    gy.uzenet({ guildId: GUILD, channelId: 'b', bot: false })
    await gy.kiir()

    const sorok = await db.query<{ channel_id: string, messages: string, bot_messages: string }>(
      'SELECT channel_id, messages, bot_messages FROM discord_message_stats_daily WHERE guild_id = $1 ORDER BY channel_id',
      [GUILD])
    assert.equal(sorok.length, 2)
    assert.equal(Number(sorok[0]!.messages), 2)
    assert.equal(Number(sorok[0]!.bot_messages), 1, 'a bot üzenete az emberekhez számolódott')
    assert.equal(Number(sorok[1]!.messages), 1)
  })

  /*
   * A PUFFER A KIÍRÁS ELŐTT ÜRÜL — a duplázás rosszabb hiba, mint a
   * hiányzás. Egy hiányzó köteg csak pontatlan; egy duplázott HAZUDIK.
   */
  it('a kiírás után nem írja ki mégegyszer ugyanazt', async () => {
    const gy = new gw.Gyujto()
    gy.uzenet({ guildId: GUILD, channelId: 'a', bot: false })
    await gy.kiir()
    assert.equal(gy.fuggoben(), 0, 'a puffer nem ürült ki')
    await gy.kiir()

    const sor = await db.queryOne<{ messages: string }>(
      'SELECT messages FROM discord_message_stats_daily WHERE guild_id = $1', [GUILD])
    assert.equal(Number(sor?.messages), 1, 'duplán számolt')
  })

  it('az ismételt kiírás HOZZÁAD, nem felülír', async () => {
    const gy = new gw.Gyujto()
    gy.uzenet({ guildId: GUILD, channelId: 'a', bot: false })
    await gy.kiir()
    gy.uzenet({ guildId: GUILD, channelId: 'a', bot: false })
    await gy.kiir()
    const sor = await db.queryOne<{ messages: string }>(
      'SELECT messages FROM discord_message_stats_daily WHERE guild_id = $1', [GUILD])
    assert.equal(Number(sor?.messages), 2)
  })

  /*
   * A LÉTSZÁM NEM ÖSSZEADÓDÓ MENNYISÉG. Ha hozzáadnánk, egy naponta
   * ötvenszer érkező `GUILD_CREATE` ötvenszeres szervert mutatna.
   */
  it('a taglétszám FELÜLÍRÓDIK, nem összeadódik', async () => {
    const gy = new gw.Gyujto()
    gy.tagletszam(GUILD, 100)
    await gy.kiir()
    gy.tagletszam(GUILD, 102)
    await gy.kiir()
    const sor = await db.queryOne<{ member_count: number }>(
      'SELECT member_count FROM discord_member_stats_daily WHERE guild_id = $1', [GUILD])
    assert.equal(sor?.member_count, 102)
  })

  it('a hiányzó létszám nem ír nullát', async () => {
    const gy = new gw.Gyujto()
    gy.tagletszam(GUILD, null)
    await gy.kiir()
    const sorok = await db.query('SELECT 1 FROM discord_member_stats_daily WHERE guild_id = $1', [GUILD])
    assert.equal(sorok.length, 0, 'ismeretlen létszámra is írt sort')
  })

  it('a csatlakozás és a kilépés összeadódik', async () => {
    const gy = new gw.Gyujto()
    gy.mozgott(GUILD, 'join')
    gy.mozgott(GUILD, 'join')
    gy.mozgott(GUILD, 'leave')
    await gy.kiir()
    const sor = await db.queryOne<{ joins: number, leaves: number, member_count: number | null }>(
      'SELECT joins, leaves, member_count FROM discord_member_stats_daily WHERE guild_id = $1', [GUILD])
    assert.equal(sor?.joins, 2)
    assert.equal(sor?.leaves, 1)
    // A LÉTSZÁM ÉS A MOZGÁS KÜLÖN ÚTON JÖN: a mozgás írása nem találhat ki
    // létszámot.
    assert.equal(sor?.member_count, null)
  })

  it('semmilyen szöveget vagy szerzőt nem tárol', async () => {
    const oszlopok = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name IN ('discord_message_stats_daily', 'discord_member_stats_daily')`)
    const nevek = oszlopok.map(o => o.column_name)
    for (const tiltott of ['content', 'author', 'author_id', 'user_id', 'message_id', 'username']) {
      assert.ok(!nevek.includes(tiltott), `a séma tárolna ilyet: ${tiltott}`)
    }
  })

  it('az állapotsor egyetlen', async () => {
    const sorok = await db.query('SELECT id FROM discord_gateway_state')
    assert.equal(sorok.length, 1, 'egynél több gateway-állapotsor van')
  })
})
