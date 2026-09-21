// A Discord szondái a rendszerállapotban.
//
// KÉT KÜLÖN DOLGOT MÉRNEK, és ez a lényeg: a `discord` szonda azt, hogy a
// Discord él-e és érvényes-e a tokenünk; a `discord-messages` azt, hogy a MI
// üzeneteink mennek-e ki. A kettő külön romlik el — a Discord lehet
// tökéletesen elérhető, miközben minden üzenetünk jogosultsági hibán áll.
//
// TOKEN NÉLKÜL `not_configured`, NEM `red`. Ugyanaz az elv, mint a Redisnél:
// egy szándékosan be nem kapcsolt függőség nem hiba. Pirosra festve a panel
// folyamatosan riasztana egy működő rendszerre.

import assert from 'node:assert/strict'
import { before, describe, it, mock } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'discord-probes-test-secret-long-enough-0123456789'

let probes: typeof import('../src/infrastructure/observability/probes.ts')
let db: typeof import('../src/infrastructure/database/index.ts')

const TITOK = 'probe-proba-token-NEM-VALODI-0123456789'

const nelkul = async <T>(fn: () => Promise<T>): Promise<T> => {
  const elozo = process.env.DISCORD_BOT_TOKEN
  delete process.env.DISCORD_BOT_TOKEN
  try { return await fn() } finally {
    if (elozo !== undefined) process.env.DISCORD_BOT_TOKEN = elozo
  }
}
const tokennel = async <T>(fn: () => Promise<T>): Promise<T> => {
  const elozo = process.env.DISCORD_BOT_TOKEN
  process.env.DISCORD_BOT_TOKEN = TITOK
  try { return await fn() } finally {
    if (elozo === undefined) delete process.env.DISCORD_BOT_TOKEN
    else process.env.DISCORD_BOT_TOKEN = elozo
  }
}

const szonda = async (nev: string) => (await probes.probeAll()).find(p => p.service === nev)

describe('a Discord szondái', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    probes = await import('../src/infrastructure/observability/probes.ts')
    db = await import('../src/infrastructure/database/index.ts')
  })

  it('token nélkül NEM hibát jelent, hanem hogy nincs bekapcsolva', async () => {
    await nelkul(async () => {
      const d = await szonda('discord')
      assert.equal(d?.status, 'not_configured',
        'token nélkül riasztana — pedig a bot szándékosan nincs bekapcsolva')
      assert.equal((await szonda('discord-messages'))?.status, 'not_configured')
    })
  })

  /*
   * AZ ÉRVÉNYTELEN TOKEN KÜLÖN ESET. Ez nem „a Discord nem elérhető", hanem
   * „a mi tokenünk rossz" — és az üzemeltetőnek egészen más a teendője.
   */
  it('a 401-et a token hibájaként jelenti, nem elérhetetlenségként', async () => {
    await tokennel(async () => {
      mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401, json: async () => ({}) }))
      try {
        const d = await szonda('discord')
        assert.equal(d?.status, 'red')
        assert.match(String(d?.detail), /token/i)
      } finally { mock.restoreAll() }
    })
  })

  it('a rate limit sárga, nem piros', async () => {
    await tokennel(async () => {
      mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 429, json: async () => ({}) }))
      try {
        assert.equal((await szonda('discord'))?.status, 'yellow',
          'a korlátozás nem leállás — pirosra festve riasztana egy működő rendszerre')
      } finally { mock.restoreAll() }
    })
  })

  it('sikeres válaszra zöld', async () => {
    await tokennel(async () => {
      mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ id: '1' }) }))
      try {
        const d = await szonda('discord')
        assert.ok(d?.status === 'green' || d?.status === 'yellow', `állapot: ${d?.status}`)
      } finally { mock.restoreAll() }
    })
  })

  /*
   * A TOKEN NEM SZIVÁROGHAT A `detail` MEZŐBE. Az a mező kimegy az
   * adminfelületre és a Discord-embedbe is.
   */
  it('a token soha nem jelenik meg a részletekben', async () => {
    await tokennel(async () => {
      for (const valasz of [
        async () => { throw new Error(`hiba: Bot ${TITOK}`) },
        async () => ({ ok: false, status: 500, json: async () => ({}) })
      ]) {
        mock.method(globalThis, 'fetch', valasz as never)
        try {
          const mind = await probes.probeAll()
          const szoveg = JSON.stringify(mind)
          assert.ok(!szoveg.includes(TITOK), 'a token kiszivárgott a szonda eredményébe')
        } finally { mock.restoreAll() }
      }
    })
  })

  describe('a tartós üzenetek szondája', () => {
    const GUILD = '900000000000000999'
    const takarit = async () => await db.query('DELETE FROM persistent_messages WHERE guild_id = $1', [GUILD])

    it('beállított üzenet nélkül nem riaszt', async () => {
      await tokennel(async () => {
        await takarit()
        mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({}) }))
        try {
          const m = await szonda('discord-messages')
          assert.equal(m?.status, 'not_configured')
        } finally { mock.restoreAll() }
      })
    })

    it('elakadt üzenetre pirosat jelent, és megmondja hányat', async () => {
      await tokennel(async () => {
        await takarit()
        await db.query(
          `INSERT INTO persistent_messages (guild_id, channel_id, message_type, failure_count)
           VALUES ($1, '200000000000000001', 'yume_statistics', 9)`, [GUILD])
        mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({}) }))
        try {
          const m = await szonda('discord-messages')
          assert.equal(m?.status, 'red')
          assert.match(String(m?.detail), /elakadt/)
        } finally { mock.restoreAll(); await takarit() }
      })
    })

    it('régen frissült üzenetre sárgát jelent', async () => {
      await tokennel(async () => {
        await takarit()
        await db.query(
          `INSERT INTO persistent_messages (guild_id, channel_id, message_type, last_success_at)
           VALUES ($1, '200000000000000001', 'system_health', now() - interval '3 hours')`, [GUILD])
        mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({}) }))
        try {
          const m = await szonda('discord-messages')
          assert.equal(m?.status, 'yellow')
          assert.match(String(m?.detail), /nem frissült/)
        } finally { mock.restoreAll(); await takarit() }
      })
    })

    it('frissen sikeres üzenetre zöld', async () => {
      await tokennel(async () => {
        await takarit()
        await db.query(
          `INSERT INTO persistent_messages (guild_id, channel_id, message_type, last_success_at)
           VALUES ($1, '200000000000000001', 'provider_status', now())`, [GUILD])
        mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({}) }))
        try {
          const m = await szonda('discord-messages')
          assert.ok(m?.status === 'green' || m?.status === 'yellow', `állapot: ${m?.status}`)
          assert.notEqual(m?.status, 'red')
        } finally { mock.restoreAll(); await takarit() }
      })
    })
  })

  /*
   * A `not_configured` NEM SZÁMÍT BELE AZ ÖSSZESÍTETT ÍTÉLETBE. Enélkül egy
   * bot nélküli telepítés örökre „DEGRADED" lenne.
   */
  it('a be nem kapcsolt Discord nem rontja az összesített állapotot', async () => {
    await nelkul(async () => {
      const mind = await probes.probeAll()
      const itelet = probes.overall(mind)
      assert.notEqual(itelet, 'UNHEALTHY')
    })
  })
})
