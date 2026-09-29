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

describe('az állapotsor írója', () => {
  before(async () => { gw = await import('../src/modules/discord/gateway.ts') })

  type Mezok = import('../src/modules/discord/gateway.ts').AllapotMezok
  const var_ = async (ms: number): Promise<void> => { await new Promise(resolve => setTimeout(resolve, ms)) }

  it('az összevonásban a később jött nyer, a számláló összeadódik', () => {
    const m = gw.osszevon(
      gw.osszevon(null, { status: 'connecting', sequence: 4, reconnect: true }),
      { status: 'ready', event: true, reconnect: true, lastError: null })
    assert.deepEqual(m, { status: 'ready', sequence: 4, reconnect: 2, event: true, lastError: null })
  })

  it('a körútidő-minták összeadódnak, a csúcs a nagyobbik, a legutóbbi marad', () => {
    const m = gw.osszevon(gw.osszevon(null, { event: true, rtt: 100 }), { event: true, rtt: 300 })
    assert.deepEqual(m, { event: true, rtt: 300, rttMinta: { sum: 400, count: 2, max: 300 } })
    // Egy már összevont bejegyzés mintája nem számolódik kétszer.
    const tovabb = gw.osszevon(m, gw.osszevon(null, { rtt: 50 }))
    assert.deepEqual(tovabb.rttMinta, { sum: 450, count: 3, max: 300 })
  })

  it('a folytatás és az új munkamenet is összeadódik', () => {
    const m = gw.osszevon(gw.osszevon(null, { identified: 1 }), { resumed: 1, identified: 1 })
    assert.equal(m.identified, 2)
    assert.equal(m.resumed, 1)
  })

  // A nyugta ~41 másodpercenként jön; a körútideje nem ok arra, hogy
  // azonnal írjunk — az eseményekkel együtt, ritkítva megy.
  it('a körútidő nem sürgős: a nyugta nem ír azonnal', async () => {
    const irasok: Mezok[] = []
    const iro = new gw.AllapotIro(async m => { irasok.push(m) }, 60_000)
    iro.jelez({ event: true })
    await var_(20)
    iro.jelez({ event: true, rtt: 87 })
    await var_(30)
    assert.equal(irasok.length, 1, 'a körútidő azonnali írást váltott ki')
  })

  /*
   * EDDIG MINDEN ESEMÉNY EGY ÍRÁS VOLT. Egy forgalmas szerveren ez
   * másodpercenként tucatnyi UPDATE ugyanarra a sorra.
   */
  it('sok eseményből egy írás lesz, a legutolsó sorszámmal', async () => {
    const irasok: Mezok[] = []
    const iro = new gw.AllapotIro(async m => { irasok.push(m) }, 60_000)
    for (let s = 1; s <= 100; s++) iro.jelez({ event: true, sequence: s })
    await var_(30)
    assert.equal(irasok.length, 1, `${irasok.length} írás 100 eseményre`)
    assert.equal(irasok[0]!.sequence, 100)
    // Az intervallumon belül jövő esemény vár — nem ír azonnal.
    iro.jelez({ event: true, sequence: 101 })
    await var_(30)
    assert.equal(irasok.length, 1, 'az intervallumon belül is írt')
  })

  it('az állapotváltás azonnal megy, a függő eseménnyel együtt', async () => {
    const irasok: Mezok[] = []
    const iro = new gw.AllapotIro(async m => { irasok.push(m) }, 60_000)
    iro.jelez({ event: true, sequence: 1 })
    await var_(20)
    iro.jelez({ event: true, sequence: 2 })
    iro.jelez({ status: 'disconnected', reconnect: true, lastError: 'lezárva (1006)' })
    await var_(20)
    assert.equal(irasok.length, 2, 'az állapotváltás az intervallum végére várt')
    assert.deepEqual(irasok[1], { event: true, sequence: 2, status: 'disconnected', reconnect: 1, lastError: 'lezárva (1006)' })
  })

  /*
   * A `void`-dal indított írások versenyeztek: egy később célba érő, régebbi
   * írás a tárolt sorszámot visszaléptethette.
   */
  it('egyszerre egy írás fut, és a sorszám nem lép vissza', async () => {
    const sorszamok: number[] = []
    let fut = 0
    let legtobb = 0
    const iro = new gw.AllapotIro(async m => {
      fut++
      legtobb = Math.max(legtobb, fut)
      await var_(8)
      if (typeof m.sequence === 'number') sorszamok.push(m.sequence)
      fut--
    }, 0)
    for (let s = 1; s <= 40; s++) {
      iro.jelez({ event: true, sequence: s })
      await var_(1)
    }
    await iro.kiurit()
    assert.equal(legtobb, 1, 'két írás futott egyszerre')
    assert.deepEqual(sorszamok, [...sorszamok].sort((a, b) => a - b), `a sorszám visszalépett: ${sorszamok.join(',')}`)
    assert.equal(sorszamok.at(-1), 40)
  })

  it('az elbukott írás mezői nem vesznek el, és a frissebb nyer', async () => {
    const irasok: Mezok[] = []
    let hibak = 0
    const iro = new gw.AllapotIro(async m => {
      if (hibak++ === 0) throw new Error('az adatbázis most nem érhető el')
      irasok.push(m)
    }, 20)
    iro.jelez({ status: 'disconnected', reconnect: true })
    await var_(5)
    iro.jelez({ status: 'connecting', reconnect: true })
    await var_(60)
    assert.equal(irasok.length, 1)
    assert.deepEqual(irasok[0], { status: 'connecting', reconnect: 2 }, 'az elbukott írás újracsatlakozása elveszett')
  })

  it('leálláskor kiír — és egy elérhetetlen adatbázison sem akad el', async () => {
    let hivas = 0
    const iro = new gw.AllapotIro(async () => { hivas++; throw new Error('nincs adatbázis') }, 20)
    iro.jelez({ status: 'disconnected' })
    await iro.kiurit()
    assert.equal(hivas, 1)
    await var_(60)
    assert.equal(hivas, 1, 'leállás után is újrapróbálkozott')
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

  // ---- az állapotsor és a napi sor ----
  //
  // A két tétel az EGYETLEN állapotsort és a mai napi sort írja; előtte
  // mindkettőt eltesszük, utána visszaállítjuk.

  type Napi = { reconnects: number, resumed: number, identified: number, rtt_sum_ms: string, rtt_count: number, rtt_max_ms: number | null }
  const MA = () => new Date().toISOString().slice(0, 10)
  const napiSor = async (): Promise<Napi | undefined> => (await db.query<Napi>(
    'SELECT reconnects, resumed, identified, rtt_sum_ms, rtt_count, rtt_max_ms FROM discord_gateway_daily WHERE day = $1', [MA()]))[0]
  const megorizve = async (fn: () => Promise<void>): Promise<void> => {
    const allapot = (await db.query<{ reconnects: string, heartbeat_rtt_ms: number | null }>(
      'SELECT reconnects, heartbeat_rtt_ms FROM discord_gateway_state WHERE id = 1'))[0]!
    const napi = await napiSor()
    try {
      await fn()
    } finally {
      await db.query('UPDATE discord_gateway_state SET reconnects = $1, heartbeat_rtt_ms = $2 WHERE id = 1',
        [allapot.reconnects, allapot.heartbeat_rtt_ms])
      if (napi) {
        await db.query(
          `UPDATE discord_gateway_daily SET reconnects = $2, resumed = $3, identified = $4, rtt_sum_ms = $5, rtt_count = $6, rtt_max_ms = $7
            WHERE day = $1`,
          [MA(), napi.reconnects, napi.resumed, napi.identified, napi.rtt_sum_ms, napi.rtt_count, napi.rtt_max_ms])
      } else {
        await db.query('DELETE FROM discord_gateway_daily WHERE day = $1', [MA()])
      }
    }
  }

  // Az összevont írás több újracsatlakozást visz egyszerre — egy sem veszhet el.
  it('az újracsatlakozások száma összeadódik, nem csak eggyel nő', async () => {
    await megorizve(async () => {
      const alap = Number((await db.query<{ reconnects: string }>('SELECT reconnects FROM discord_gateway_state WHERE id = 1'))[0]!.reconnects)
      await gw.allapotIr({ reconnect: 3 })
      await gw.allapotIr({ reconnect: true })
      const utana = await db.query<{ reconnects: string }>('SELECT reconnects FROM discord_gateway_state WHERE id = 1')
      assert.equal(Number(utana[0]!.reconnects), alap + 4)
    })
  })

  /*
   * A NAPI SOR: szakadás, folytatás, új munkamenet és a körútidő — ugyanabban
   * az utasításban, mint az állapotsor, hogy egy újrapróbált írás se
   * számoljon kétszer.
   */
  it('a napi sor a szakadást, a folytatást, az új munkamenetet és a körútidőt is gyűjti', async () => {
    await megorizve(async () => {
      const elotte = await napiSor()
      await gw.allapotIr({ reconnect: 2, resumed: 1, identified: 1, rtt: 120, rttMinta: { sum: 300, count: 2, max: 180 } })
      const utana = (await napiSor())!
      assert.equal(utana.reconnects - (elotte?.reconnects ?? 0), 2)
      assert.equal(utana.resumed - (elotte?.resumed ?? 0), 1)
      assert.equal(utana.identified - (elotte?.identified ?? 0), 1)
      assert.equal(Number(utana.rtt_sum_ms) - Number(elotte?.rtt_sum_ms ?? 0), 300)
      assert.equal(utana.rtt_count - (elotte?.rtt_count ?? 0), 2)
      assert.ok(Number(utana.rtt_max_ms) >= 180)
      const allapot = await db.query<{ heartbeat_rtt_ms: number }>('SELECT heartbeat_rtt_ms FROM discord_gateway_state WHERE id = 1')
      assert.equal(allapot[0]!.heartbeat_rtt_ms, 120, 'a legutóbbi körútidő nem került az állapotsorba')
    })
  })

  it('egy puszta esemény nem ír napi sort', async () => {
    await megorizve(async () => {
      const elotte = await napiSor()
      await gw.allapotIr({ event: true, sequence: 7 })
      assert.deepEqual(await napiSor(), elotte)
    })
  })
})
