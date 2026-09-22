// A tartós üzenetek frissítő feladata.
//
// AMIT ŐRIZ: egy elromlott üzenet nem foghatja meg a többit, a token hiánya
// nem tiltja le az összeset, és egy futás nem próbálja feldolgozni a teljes
// állományt.
//
// A HARMADIK A LEGKEVÉSBÉ NYILVÁNVALÓ. Száz guild négy-négy üzenete egyetlen
// körben négyszáz Discord-kérés lenne: a korlátba futnánk, és a sor végén
// lévők soha nem frissülnének. Kötegenként megy, a legrégebben frissített
// szerint haladva.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'discord-worker-test-secret-long-enough-0123456789'

let worker: typeof import('../src/modules/discord/worker.ts')
let db: typeof import('../src/infrastructure/database/index.ts')
let pmod: typeof import('../src/modules/discord/persistent-messages.ts')

const GUILD = '900000000000000' + Math.floor(Math.random() * 900 + 100)

describe('a tartós üzenetek frissítő feladata', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    worker = await import('../src/modules/discord/worker.ts')
    db = await import('../src/infrastructure/database/index.ts')
    pmod = await import('../src/modules/discord/persistent-messages.ts')
  })
  beforeEach(async () => {
    await db.query('DELETE FROM persistent_messages WHERE guild_id = $1', [GUILD])
  })
  after(async () => {
    await db.query('DELETE FROM persistent_messages WHERE guild_id = $1', [GUILD])
  })

  const felvesz = async (type: string, extra = '') => await db.queryOne<{ id: string }>(
    `INSERT INTO persistent_messages (guild_id, channel_id, message_type, enabled)
     VALUES ($1, '200000000000000001', $2, true) RETURNING id`,
    [GUILD, type + extra])

  const tokenNelkul = async <T>(fn: () => Promise<T>): Promise<T> => {
    const elozo = process.env.DISCORD_BOT_TOKEN
    delete process.env.DISCORD_BOT_TOKEN
    try { return await fn() } finally {
      if (elozo !== undefined) process.env.DISCORD_BOT_TOKEN = elozo
    }
  }

  /*
   * TOKEN NÉLKÜL NEM HAZUDIK SIKERT — ÉS NEM IS BÜNTET.
   *
   * Ez a fontosabb fele: ha a feladat token nélkül végigmenne az üzeneteken,
   * mindegyiknél kudarcot számolna, és pár perc alatt MINDET letiltaná — egy
   * olyan hiba miatt, aminek semmi köze az üzenetekhez. A helyreállítás
   * utána kézi munka lenne minden egyes rekordon.
   */
  it('token nélkül nem dolgoz fel és nem büntet', async () => {
    const sor = await felvesz('yume_statistics')
    const eredmeny = await tokenNelkul(() => worker.syncDueMessages())

    assert.equal(eredmeny.processed, 0)
    assert.match(String(eredmeny.skippedReason), /token/)

    const utana = await pmod.findById(sor!.id)
    assert.equal(utana!.failure_count, 0, 'a hiányzó token kudarcot számolt az üzenetre')
    assert.equal(utana!.last_error, null)
  })

  it('a nyesés a régi eseményeket törli, az újakat nem', async () => {
    const sor = await felvesz('system_health')
    await db.query(
      `INSERT INTO persistent_message_events (message_id, event, at) VALUES
        ($1, 'edited', now() - interval '400 days'),
        ($1, 'edited', now())`, [sor!.id])

    const torolt = await worker.pruneEvents()
    assert.ok(torolt >= 1, 'egyetlen régi eseményt sem törölt')

    const maradt = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM persistent_message_events WHERE message_id = $1', [sor!.id])
    assert.equal(maradt[0]!.n, 1, 'a friss eseményt is törölte')
  })

  /*
   * A KÖTEGMÉRET KORLÁTOZ. A `due()` a `LIMIT`-tel dolgozik; ez a teszt azt
   * méri, hogy a korlát tényleg hat — enélkül egy nagy állomány egyetlen
   * körben menne ki a Discordra.
   */
  it('egy futás nem viszi el az egész állományt', async () => {
    for (let i = 0; i < 6; i++) await felvesz('yume_statistics', `_${i}`)
    const koteg = await pmod.due(3)
    assert.ok(koteg.length <= 3, `a köteg ${koteg.length} elemű, pedig a korlát 3`)
  })

  it('a legrégebben frissített megy előre', async () => {
    const a = await felvesz('yume_statistics', '_regi')
    const b = await felvesz('yume_statistics', '_uj')
    await db.query("UPDATE persistent_messages SET last_updated_at = now() - interval '10 days' WHERE id = $1", [a!.id])
    await db.query("UPDATE persistent_messages SET last_updated_at = now() - interval '2 days' WHERE id = $1", [b!.id])

    const koteg = await pmod.due(10)
    const sajatok = koteg.filter(r => r.guild_id === GUILD)
    assert.equal(sajatok[0]?.id, a!.id, 'nem a legrégebben frissített ment előre')
  })

  it('a letiltott és a kimerült rekord nem kerül sorra', async () => {
    const tiltott = await felvesz('yume_statistics', '_tiltott')
    const kimerult = await felvesz('yume_statistics', '_kimerult')
    await db.query('UPDATE persistent_messages SET enabled = false WHERE id = $1', [tiltott!.id])
    await db.query('UPDATE persistent_messages SET failure_count = $2 WHERE id = $1',
      [kimerult!.id, pmod.MAX_FAILURES])

    const koteg = await pmod.due(50)
    const idk = koteg.map(r => r.id)
    assert.ok(!idk.includes(tiltott!.id), 'letiltott rekord került sorra')
    assert.ok(!idk.includes(kimerult!.id), 'kimerült kudarcszámlálójú rekord került sorra')
  })

  /*
   * A ZÁROLT REKORD SEM. Ha egy másik példány épp dolgozik rajta, a `due()`
   * ki is hagyja — enélkül minden kör újra nekifutna, és a zár csak a
   * kérésekre pazarolt időt fedné el.
   */
  it('a zárolt rekord nem kerül sorra', async () => {
    const sor = await felvesz('yume_statistics', '_zart')
    await pmod.acquireLock(sor!.id, 'masik-peldany')
    const koteg = await pmod.due(50)
    assert.ok(!koteg.map(r => r.id).includes(sor!.id), 'zárolt rekord került sorra')
  })
})
