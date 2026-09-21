// Tartós Discord-üzenetek — a motor.
//
// HAMIS DISCORD-KLIENSSEL, ÉS EZ NEM KOMPROMISSZUM. A motor nehéz része nem
// a HTTP-hívás, hanem a négy hibaeset: ne küldjön feleslegesen, ne
// duplikáljon, ne próbálkozzon végtelenül, és egy törölt üzenetet
// kontrolláltan hozzon vissza. Ezek MIND kikényszeríthetők egy hamis
// klienssel — és csak azzal: egy valódi Discordon nem lehet megrendelni, hogy
// „most adj rate limitet".
//
// A YUME-nak MA NINCS Discord bot tokenje. Ez a készlet pontosan azt méri,
// ami token nélkül is igaz, és nem állítja, hogy a valódi Discorddal
// kipróbálta.

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'discord-pm-test-secret-long-enough-0123456789'

let pm: typeof import('../src/modules/discord/persistent-messages.ts')
let db: typeof import('../src/infrastructure/database/index.ts')

const GUILD = 'teszt-guild-' + Math.random().toString(36).slice(2, 8)

/** Hamis kliens, megmondható viselkedéssel. */
let ujAzonosito = 0

function fakeClient (viselkedes: {
  sendFails?: Error
  editFails?: Error
  canPost?: boolean
  /** Ha meg van adva, a `send` MEGVÁRJA ezt — így a hívó benn tartja a zárat. */
  sendGate?: Promise<void>
  removeFails?: Error
} = {}) {
  const hivasok: string[] = []
  return {
    hivasok,
    client: {
      async send (channelId: string) {
        hivasok.push(`send:${channelId}`)
        if (viselkedes.sendGate) await viselkedes.sendGate
        if (viselkedes.sendFails) throw viselkedes.sendFails
        // GLOBÁLISAN egyedi azonosító. Példányonkénti számlálóval két külön
        // kliens ugyanazt az `msg-1`-et adná, és egy „új azonosítót mentett-e"
        // állítás önmagát mérné.
        return { id: `msg-${++ujAzonosito}` }
      },
      async edit (channelId: string, messageId: string) {
        hivasok.push(`edit:${messageId}`)
        if (viselkedes.editFails) throw viselkedes.editFails
        return { id: messageId }
      },
      async fetch () { hivasok.push('fetch'); return null },
      async canPost () { hivasok.push('canPost'); return viselkedes.canPost !== false },
      async remove (channelId: string, messageId: string) {
        hivasok.push(`remove:${messageId}`)
        if (viselkedes.removeFails) throw viselkedes.removeFails
      }
    }
  }
}

/** Egy Discord-hiba megadott fajtával. */
function hiba (kind: string, message = 'próba'): Error {
  const e = new Error(message) as Error & { kind: string }
  e.kind = kind
  return e
}

describe('a tartós üzenetek motorja', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    pm = await import('../src/modules/discord/persistent-messages.ts')
    db = await import('../src/infrastructure/database/index.ts')
  })
  beforeEach(async () => {
    await db.query('DELETE FROM persistent_messages WHERE guild_id LIKE $1', ['teszt-guild-%'])
  })
  after(async () => {
    await db.query('DELETE FROM persistent_messages WHERE guild_id LIKE $1', ['teszt-guild-%'])
  })

  /** Egy friss rekord, üzenet nélkül. */
  const ujRekord = async (extra: Record<string, unknown> = {}) => {
    const row = await db.queryOne<typeof pm.PersistentMessage>(
      `INSERT INTO persistent_messages (guild_id, channel_id, message_type, enabled)
       VALUES ($1, 'csatorna-1', $2, true) RETURNING *`,
      [GUILD, 'server_statistics_' + Math.random().toString(36).slice(2, 7)]) as never
    return { ...(row as object), ...extra } as never
  }

  // ---- ujjlenyomat ----

  it('az ujjlenyomat kulcssorrendtől független', () => {
    assert.equal(pm.contentHash({ a: 1, b: [2, { c: 3 }] }), pm.contentHash({ b: [2, { c: 3 }], a: 1 }))
  })

  it('az ujjlenyomat a tartalomra érzékeny', () => {
    assert.notEqual(pm.contentHash({ tagok: 10 }), pm.contentHash({ tagok: 11 }))
    // A tömb SORRENDJE viszont tartalom, nem rendezendő.
    assert.notEqual(pm.contentHash({ a: [1, 2] }), pm.contentHash({ a: [2, 1] }))
  })

  // ---- 1. ne küldjön feleslegesen ----

  /*
   * A LEGFONTOSABB MEGTAKARÍTÁS. Egy percenként frissülő statisztika napi
   * 1440 kérés helyett annyi, ahányszor tényleg változott valami.
   */
  it('változatlan tartalomnál MEG SEM SZÓLÍTJA a Discordot', async () => {
    const row = await ujRekord()
    const f1 = fakeClient()
    await pm.syncMessage(row, { client: f1.client as never, payload: { tagok: 10 }, force: true })

    const utana = await pm.findById((row as { id: string }).id)
    const f2 = fakeClient()
    const r = await pm.syncMessage(utana!, { client: f2.client as never, payload: { tagok: 10 }, force: false, now: new Date(Date.now() + 10 * 60_000) })

    assert.equal(r.outcome, 'skipped')
    assert.deepEqual(f2.hivasok, [], `hívta a Discordot: ${f2.hivasok.join(', ')}`)
  })

  it('változott tartalomnál MÓDOSÍT, nem küld újat', async () => {
    const row = await ujRekord()
    const f1 = fakeClient()
    await pm.syncMessage(row, { client: f1.client as never, payload: { tagok: 10 }, force: true })

    const utana = await pm.findById((row as { id: string }).id)
    const f2 = fakeClient()
    const r = await pm.syncMessage(utana!, { client: f2.client as never, payload: { tagok: 11 }, force: true })

    assert.equal(r.outcome, 'edited')
    assert.ok(f2.hivasok.some(h => h.startsWith('edit:')), 'nem módosított')
    assert.ok(!f2.hivasok.some(h => h.startsWith('send:')), 'ÚJ üzenetet küldött módosítás helyett')
  })

  it('a kihagyás is frissíti az időbélyeget, különben azonnal újra esedékes', async () => {
    const row = await ujRekord()
    const f = fakeClient()
    await pm.syncMessage(row, { client: f.client as never, payload: { a: 1 }, force: true })
    const elso = await pm.findById((row as { id: string }).id)

    const kesobb = new Date(Date.now() + 10 * 60_000)
    await pm.syncMessage(elso!, { client: f.client as never, payload: { a: 1 }, now: kesobb })
    const masodik = await pm.findById((row as { id: string }).id)

    assert.ok(new Date(masodik!.last_updated_at!).getTime() > new Date(elso!.last_updated_at!).getTime(),
      'a kihagyás után az időbélyeg nem frissült — a ciklus percenként újraszámolna')
  })

  // ---- 2. ne duplikáljon ----

  /*
   * TÖBB BOT-PÉLDÁNY. Két folyamat egyszerre próbálhatna üzenetet létrehozni
   * ugyanahhoz a rekordhoz — abból két üzenet lenne, és a második örökre
   * árván maradna.
   */
  it('két egyidejű futásból csak az egyik küld', async () => {
    const row = await ujRekord()
    /*
     * AZ ÁTFEDÉST MEG KELL TEREMTENI. Az első kísérletem azonnal válaszoló
     * hamis klienssel futott: az „A" példány teljesen lefutott és ELENGEDTE a
     * zárat, mielőtt „B" egyáltalán zárolt volna — a teszt így két egymás
     * utáni futást mért, és mindkettő küldött. A kapu benn tartja „A"-t a
     * kritikus szakaszban, amíg „B" próbálkozik.
     */
    let engedd: () => void = () => {}
    const kapu = new Promise<void>(resolve => { engedd = resolve })

    const a = fakeClient({ sendGate: kapu }); const b = fakeClient()
    const elso = pm.syncMessage(row, { client: a.client as never, payload: { x: 1 }, owner: 'A', force: true })
    // Megvárjuk, hogy „A" tényleg a küldésnél tartson — onnantól nála a zár.
    for (let i = 0; i < 200 && !a.hivasok.some(h => h.startsWith('send:')); i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const masodik = pm.syncMessage(row, { client: b.client as never, payload: { x: 1 }, owner: 'B', force: true })
    const r2elozetes = await masodik
    engedd()
    const r1 = await elso
    const r2 = r2elozetes
    const kimenetek = [r1.outcome, r2.outcome].sort()
    assert.deepEqual(kimenetek, ['created', 'locked_out'],
      `mindkét példány dolgozott: ${kimenetek.join(', ')}`)
    const kuldesek = [...a.hivasok, ...b.hivasok].filter(h => h.startsWith('send:'))
    assert.equal(kuldesek.length, 1, `${kuldesek.length} üzenet ment ki egy helyett`)
  })

  it('a zár felszabadul a futás után', async () => {
    const row = await ujRekord()
    const f = fakeClient()
    await pm.syncMessage(row, { client: f.client as never, payload: { x: 1 }, owner: 'A', force: true })
    const utana = await pm.findById((row as { id: string }).id)
    assert.equal(utana!.locked_until, null, 'a zár bent ragadt — a rekord örökre kizárva marad')
  })

  it('a zár hiba esetén is felszabadul', async () => {
    const row = await ujRekord()
    const f = fakeClient({ sendFails: hiba('transient', 'hálózat') })
    await pm.syncMessage(row, { client: f.client as never, payload: { x: 1 }, owner: 'A', force: true })
    const utana = await pm.findById((row as { id: string }).id)
    assert.equal(utana!.locked_until, null, 'hiba után bent ragadt a zár')
  })

  // ---- 3. ne próbálkozzon végtelenül ----

  it('a kudarcok számlálódnak, és a sikerrel nullázódnak', async () => {
    const row = await ujRekord()
    const rossz = fakeClient({ sendFails: hiba('transient') })
    await pm.syncMessage(row, { client: rossz.client as never, payload: { x: 1 }, force: true })
    let utana = await pm.findById((row as { id: string }).id)
    assert.equal(utana!.failure_count, 1)
    assert.ok(utana!.last_error)

    const jo = fakeClient()
    await pm.syncMessage(utana!, { client: jo.client as never, payload: { x: 1 }, force: true })
    utana = await pm.findById((row as { id: string }).id)
    assert.equal(utana!.failure_count, 0, 'a siker nem nullázta a számlálót')
    assert.equal(utana!.last_error, null)
  })

  /*
   * A NEM ÚJRAPRÓBÁLHATÓ HIBA AZONNAL LEÁLL. Egy jogosultsági hiba nem múlik
   * el attól, hogy ötször nekifutunk — csak a naplót tölti és a Discord
   * korlátait meríti.
   */
  it('jogosultsági hiba azonnal leállítja a próbálkozást', async () => {
    const row = await ujRekord()
    const f = fakeClient({ editFails: hiba('forbidden') })
    // előbb legyen üzenet, hogy a módosítási ág fusson
    await pm.syncMessage(row, { client: fakeClient().client as never, payload: { x: 1 }, force: true })
    const van = await pm.findById((row as { id: string }).id)

    await pm.syncMessage(van!, { client: f.client as never, payload: { x: 2 }, force: true })
    const utana = await pm.findById((row as { id: string }).id)
    assert.ok(utana!.failure_count >= pm.MAX_FAILURES,
      `a számláló ${utana!.failure_count} — egy jogosultsági hiba nem állította le`)
    assert.equal(pm.isDue(utana as never), false, 'még mindig esedékesnek számít')
  })

  it('az átmeneti hiba újrapróbálható marad', () => {
    assert.equal(pm.isRetryable('transient'), true)
    assert.equal(pm.isRetryable('rate_limited'), true)
    assert.equal(pm.isRetryable('forbidden'), false)
    assert.equal(pm.isRetryable('channel_not_found'), false)
    assert.equal(pm.isRetryable('message_not_found'), false)
  })

  it('a visszalépés exponenciális, felső korláttal', () => {
    assert.ok(pm.backoffMs(1) > pm.backoffMs(0))
    assert.ok(pm.backoffMs(2) > pm.backoffMs(1))
    assert.equal(pm.backoffMs(99), pm.BACKOFF_MAX_MS, 'nincs felső korlát')
  })

  /*
   * A DISCORD SAJÁT VÁRAKOZÁSI IDEJE ELSŐBBSÉGET ÉLVEZ. Az pontosabb, mint a
   * mi becslésünk, és figyelmen kívül hagyni egyenesen ellenséges.
   */
  it('a rate limit saját várakozási ideje felülírja a becslést', () => {
    assert.equal(pm.backoffMs(5, 2_000), 2_000)
    assert.equal(pm.backoffMs(0, 10 * 60 * 60_000), pm.BACKOFF_MAX_MS, 'a felső korlát itt is áll')
  })

  // ---- 4. törölt üzenet helyreállítása ----

  /*
   * A LEGVESZÉLYESEBB ÁG. Ha a „nincs meg" hibát rosszul osztályozzuk, a
   * rendszer percenként küld egy új üzenetet, és a csatorna megtelik.
   */
  it('törölt üzenetet ÚJRA létrehoz', async () => {
    const row = await ujRekord()
    await pm.syncMessage(row, { client: fakeClient().client as never, payload: { x: 1 }, force: true })
    const van = await pm.findById((row as { id: string }).id)
    const regiId = van!.message_id

    const f = fakeClient({ editFails: hiba('message_not_found') })
    const r = await pm.syncMessage(van!, { client: f.client as never, payload: { x: 2 }, force: true })

    assert.equal(r.outcome, 'recreated')
    const utana = await pm.findById((row as { id: string }).id)
    assert.notEqual(utana!.message_id, regiId, 'nem mentette el az új azonosítót')
    assert.equal(utana!.failure_count, 0, 'a helyreállítást kudarcnak vette')
  })

  it('a helyreállítás jogosultság nélkül NEM küld új üzenetet', async () => {
    const row = await ujRekord()
    await pm.syncMessage(row, { client: fakeClient().client as never, payload: { x: 1 }, force: true })
    const van = await pm.findById((row as { id: string }).id)

    const f = fakeClient({ editFails: hiba('message_not_found'), canPost: false })
    const r = await pm.syncMessage(van!, { client: f.client as never, payload: { x: 2 }, force: true })

    assert.equal(r.outcome, 'no_permission')
    assert.equal(f.hivasok.filter(h => h.startsWith('send:')).length, 0, 'jogosultság nélkül küldött')
  })

  /*
   * EGY JOGOSULTSÁGI HIBA NEM VEZETHET ÚJRALÉTREHOZÁSHOZ. Ez az a tévedés,
   * amitől a csatorna megtelik: minden futás küldene egy újat.
   */
  it('NEM hoz létre újat olyan hibára, ami nem törlés', async () => {
    for (const kind of ['forbidden', 'transient', 'rate_limited', 'channel_not_found', 'unknown']) {
      const row = await ujRekord()
      await pm.syncMessage(row, { client: fakeClient().client as never, payload: { x: 1 }, force: true })
      const van = await pm.findById((row as { id: string }).id)

      const f = fakeClient({ editFails: hiba(kind) })
      const r = await pm.syncMessage(van!, { client: f.client as never, payload: { x: 2 }, force: true })

      assert.notEqual(r.outcome, 'recreated', `${kind} hibára új üzenetet küldött`)
      assert.equal(f.hivasok.filter(h => h.startsWith('send:')).length, 0,
        `${kind} hibára küldést indított`)
    }
  })

  it('csatorna-jogosultság nélkül létre sem hozza az elsőt', async () => {
    const row = await ujRekord()
    const f = fakeClient({ canPost: false })
    const r = await pm.syncMessage(row, { client: f.client as never, payload: { x: 1 }, force: true })
    assert.equal(r.outcome, 'no_permission')
    assert.equal(f.hivasok.filter(h => h.startsWith('send:')).length, 0)
  })

  // ---- esedékesség ----

  it('a letiltott rekord soha nem esedékes', () => {
    assert.equal(pm.isDue({ enabled: false, failure_count: 0, last_updated_at: null }), false)
  })

  it('a kimerült kudarcszámláló leállítja az esedékességet', () => {
    assert.equal(pm.isDue({ enabled: true, failure_count: pm.MAX_FAILURES, last_updated_at: null }), false)
  })

  it('az első futás azonnal esedékes', () => {
    assert.equal(pm.isDue({ enabled: true, failure_count: 0, last_updated_at: null }), true)
  })

  it('a minimális időköz fékez', () => {
    const most = Date.now()
    assert.equal(pm.isDue({ enabled: true, failure_count: 0, last_updated_at: new Date(most) }, most + 1000), false)
    assert.equal(pm.isDue({ enabled: true, failure_count: 0, last_updated_at: new Date(most) }, most + pm.MIN_INTERVAL_MS + 1), true)
  })

  it('kudarc után hosszabban vár, mint a szokásos időköz', () => {
    const most = Date.now()
    const kesobb = most + pm.MIN_INTERVAL_MS + 1000
    assert.equal(pm.isDue({ enabled: true, failure_count: 2, last_updated_at: new Date(most) }, kesobb), false,
      'kudarc után is a rövid időközzel próbálkozik')
  })

  // ---- hibaosztályozás ----

  it('a megadott fajtát elhiszi, szövegre csak visszaesik', () => {
    assert.equal(pm.classifyError(hiba('forbidden', 'akármi')).kind, 'forbidden')
    assert.equal(pm.classifyError(new Error('Unknown Message')).kind, 'message_not_found')
    assert.equal(pm.classifyError(new Error('Unknown Channel')).kind, 'channel_not_found')
    assert.equal(pm.classifyError(new Error('Missing Permissions')).kind, 'forbidden')
    assert.equal(pm.classifyError(new Error('valami egészen más')).kind, 'unknown')
  })

  // ---- kézi újralétrehozás ----
  //
  // Ez nem ugyanaz, mint a törölt üzenet automatikus visszahozása. Ott az
  // üzenet MÁR NINCS MEG; itt megvan, csak rossz helyen — lejjebb csúszott,
  // vagy elrontott. A kérdés ezért más: marad-e KETTŐ a csatornában.

  it('a régi üzenetet TÖRLI, mielőtt újat küld', async () => {
    const row = await ujRekord()
    const f1 = fakeClient()
    const elso = await pm.syncMessage(row, { client: f1.client as never, payload: { x: 1 }, force: true })
    const regiId = elso.messageId as string

    const friss = await pm.findById((row as { id: string }).id)
    const f2 = fakeClient()
    const r = await pm.recreateMessage(friss as never, { client: f2.client as never, payload: { x: 1 } })

    assert.equal(r.outcome, 'created', 'nem új üzenet jött létre')
    assert.equal(r.removedOld, true)
    assert.notEqual(r.messageId, regiId, 'ugyanazt az azonosítót adta vissza')
    // A SORREND A LÉNYEG: előbb törlés, aztán küldés. Fordítva egy pillanatig
    // — vagy örökre — két üzenet állna a csatornában.
    assert.deepEqual(f2.hivasok.filter(h => h.startsWith('remove') || h.startsWith('send')),
      [`remove:${regiId}`, 'send:csatorna-1'])
  })

  it('üzenet nélküli rekordnál nincs mit törölni', async () => {
    const row = await ujRekord()
    const f = fakeClient()
    const r = await pm.recreateMessage(row, { client: f.client as never, payload: { x: 1 } })
    assert.equal(r.outcome, 'created')
    assert.equal(r.removedOld, null)
    assert.equal(f.hivasok.filter(h => h.startsWith('remove')).length, 0)
  })

  /*
   * A „MÁR NINCS MEG" NEM KUDARC. Pont az a végállapot, amit el akartunk
   * érni — ha ezt hibának vennénk, egy kézzel letörölt üzenetnél a felület
   * pánikot jelezne egy sikeres műveletre.
   */
  it('a már törölt üzenet törlése sikernek számít', async () => {
    const row = await ujRekord()
    const f1 = fakeClient()
    await pm.syncMessage(row, { client: f1.client as never, payload: { x: 1 }, force: true })
    const friss = await pm.findById((row as { id: string }).id)

    const f2 = fakeClient({ removeFails: hiba('message_not_found') })
    const r = await pm.recreateMessage(friss as never, { client: f2.client as never, payload: { x: 1 } })
    assert.equal(r.removedOld, true)
    assert.equal(r.outcome, 'created')
  })

  /*
   * A NYILVÁNTARTÁS AKKOR IS FELEJT, HA A KÜLDÉS ELHASAL. Enélkül a rekord
   * egy időközben TÖRÖLT üzenetre mutatna, és a következő kör azt próbálná
   * módosítani — egy olyan üzenetet, ami már nincs.
   */
  it('kudarcnál sem marad benn a régi üzenetazonosító', async () => {
    const row = await ujRekord()
    const f1 = fakeClient()
    await pm.syncMessage(row, { client: f1.client as never, payload: { x: 1 }, force: true })
    const friss = await pm.findById((row as { id: string }).id)

    const f2 = fakeClient({ sendFails: hiba('forbidden', 'nincs jog') })
    const r = await pm.recreateMessage(friss as never, { client: f2.client as never, payload: { x: 1 } })
    assert.equal(r.outcome, 'failed')

    const utana = await pm.findById((row as { id: string }).id)
    assert.equal((utana as { message_id: string | null }).message_id, null,
      'a rekord még mindig a törölt üzenetre mutat')
  })

  /*
   * A TÖRLÉS NEM KÖTELEZŐ A PORTON. Ahol nincs megvalósítva, ott az
   * újralétrehozás nem hasal el — de nem is állítja, hogy törölt.
   */
  it('törlés nélküli kliensnél nem állít valótlant', async () => {
    const row = await ujRekord()
    const f1 = fakeClient()
    await pm.syncMessage(row, { client: f1.client as never, payload: { x: 1 }, force: true })
    const friss = await pm.findById((row as { id: string }).id)

    const f2 = fakeClient()
    const { remove, ...torlesNelkul } = f2.client as Record<string, unknown>
    const r = await pm.recreateMessage(friss as never, { client: torlesNelkul as never, payload: { x: 1 } })
    assert.equal(r.outcome, 'created')
    assert.equal(r.removedOld, null, 'azt állította, hogy törölte, pedig nem tudta')
  })

  it('az újralétrehozás nyomot hagy az előzményben', async () => {
    const row = await ujRekord()
    const f = fakeClient()
    await pm.recreateMessage(row, { client: f.client as never, payload: { x: 1 } })
    const sorok = await db.query<{ event: string }>(
      'SELECT event FROM persistent_message_events WHERE message_id = $1 ORDER BY at',
      [(row as { id: string }).id])
    assert.ok(sorok.some(e => e.event === 'recreate_requested'), 'nincs bejegyzés a kézi újraküldésről')
  })
})
