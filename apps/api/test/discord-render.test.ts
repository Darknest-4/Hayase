// A tartós üzenetek tartalma.
//
// A KÉSZLET LEGFONTOSABB ÁLLÍTÁSA: ugyanaz az adat ugyanazt az ujjlenyomatot
// adja. Ez nem elméleti szépség — ezen múlik, hogy a motor kihagyja-e a
// felesleges módosítást.
//
// MÉRT HIBA, ÉLESBEN. Minden embed `timestamp: new Date()` mezőt kapott,
// amitől a tartalom MINDEN renderelésnél másnak látszott. A napló csupa
// `edited` volt, egyetlen `skipped` nélkül: három üzenet, percenkénti kör,
// naponta 4320 fölösleges Discord-hívás — pontosan az a forgalom, ami ellen
// az ujjlenyomat készült. Ez a fajta hiba CSAK működés közben derül ki:
// minden teszt zöld volt, az embed helyesnek látszott, és a szám mégis ment.

import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'discord-render-test-secret-long-enough-0123456789'

let render: typeof import('../src/modules/discord/render.ts')
let pm: typeof import('../src/modules/discord/persistent-messages.ts')

const CTX = { guildId: '100000000000000001', configuration: {} }

/*
 * A `server_statistics` AZ EGYETLEN TÍPUS, AMI HÁLÓZATRA MENNE — a
 * taglétszám nem a mi adatunk. Token nélkül meg sem próbálja, és ez a
 * készlet pontosan ezt az állást méri: a tesztek nem hívják a Discordot.
 */
delete process.env.DISCORD_BOT_TOKEN

/**
 * A NYOLC TÍPUS KÉZZEL FELSOROLVA, ÉS EZ SZÁNDÉKOS.
 *
 * A lista a `before()` előtt kell, hogy a `describe` törzse ciklust
 * írhasson rá — de ha csak a modul listáját másolnánk, egy elfelejtett
 * renderelő is „átmenne", mert magával a hibás listával hasonlítanánk. A két
 * lista egyezését ezért külön állítás méri, lent.
 */
const TIPUSOK = [
  'yume_statistics', 'latest_releases', 'provider_status', 'system_health',
  'server_statistics', 'anime_schedule', 'popular_anime', 'bot_status'
] as const

describe('a tartós üzenetek tartalma', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    render = await import('../src/modules/discord/render.ts')
    pm = await import('../src/modules/discord/persistent-messages.ts')
  })

  /*
   * EZ AZ EGÉSZ KÉSZLET LÉNYEGE. Ha két egymás utáni renderelés különböző
   * ujjlenyomatot ad, a motor minden körben módosítást küld — és a hash
   * összehasonlítás semmit nem ér.
   */
  for (const type of TIPUSOK) {
    it(`a(z) ${type} két renderelése AZONOS ujjlenyomatot ad`, async () => {
      const a = await render.renderMessage(type, CTX)
      const b = await render.renderMessage(type, CTX)
      assert.equal(pm.contentHash(a), pm.contentHash(b),
        `a tartalom renderelésenként változik — a motor minden körben módosítást küldene`)
    })

    it(`a(z) ${type} nem tartalmaz rendereléskori időbélyeget`, async () => {
      const szoveg = JSON.stringify(await render.renderMessage(type, CTX))
      const maiEv = String(new Date().getUTCFullYear())
      // Egy ISO-időbélyeg a mai évvel: ez az, ami minden körben más lenne.
      assert.ok(!new RegExp(`"timestamp":"${maiEv}-`).test(szoveg),
        'rendereléskori időbélyeg került az embedbe')
    })

    it(`a(z) ${type} érvényes embedet ad`, async () => {
      const p = await render.renderMessage(type, CTX) as { embeds: Array<Record<string, unknown>> }
      assert.ok(Array.isArray(p.embeds) && p.embeds.length === 1)
      assert.equal(typeof p.embeds[0]!.title, 'string')
      assert.ok(String(p.embeds[0]!.title).length > 0)
    })
  }

  /*
   * A NULLA ÉS A „NINCS ADAT" NEM UGYANAZ. Egy friss telepítésen a
   * „0 megtekintés" azt állítaná, hogy mérünk és senki nem jött — pedig még
   * nem mérünk. A 16. pont ezt külön kimondja.
   */
  it('a hiányzó adatra „—" kerül, nem nulla', async () => {
    const p = await render.renderMessage('yume_statistics', CTX) as {
      embeds: Array<{ fields: Array<{ name: string, value: string }> }>
    }
    for (const f of p.embeds[0]!.fields) {
      assert.notEqual(f.value, 'null', `null szövegként: ${f.name}`)
      assert.notEqual(f.value, 'undefined', `undefined szövegként: ${f.name}`)
      assert.ok(f.value.length > 0, `üres mező: ${f.name}`)
    }
  })

  it('ismeretlen típusra kivétel, nem üres üzenet', async () => {
    // Egy üres embed kimenne a Discordra, és a csatornában néma doboz
    // maradna — a hiba pedig sehol nem látszana.
    await assert.rejects(() => render.renderMessage('nincs_ilyen', CTX), /ismeretlen üzenettípus/)
  })

  it('a típuslista és a renderelő nem csúszhat szét', async () => {
    for (const type of render.MESSAGE_TYPES) {
      await render.renderMessage(type, CTX) // nem dobhat
    }
  })

  it('a készlet minden típust mér, nem csak a régieket', () => {
    assert.deepEqual([...render.MESSAGE_TYPES].sort(), [...TIPUSOK].sort(),
      'új üzenettípus került a rendszerbe, de ez a készlet nem méri')
  })

  /*
   * A TAGLÉTSZÁM NEM TALÁLHATÓ KI. Token nélkül a Discordtól semmit nem
   * tudunk — ilyenkor „—" jár, nem nulla. A nulla azt állítaná, hogy a
   * szervernek nincs egyetlen tagja sem.
   */
  it('a szerverstatisztika token nélkül „—"-t ír, nem nullát', async () => {
    const p = await render.renderMessage('server_statistics', CTX) as {
      embeds: Array<{ fields: Array<{ name: string, value: string }>, footer: { text: string } }>
    }
    const tagok = p.embeds[0]!.fields.find(f => f.name === 'Tagok')
    assert.equal(tagok?.value, '—')
    assert.match(p.embeds[0]!.footer.text, /nem érhetők el/)
  })

  /*
   * A BOT ÁLLAPOTA A SAJÁT FRISSÍTÉSEIRŐL SZÁMOL BE. Ha kiírná, mikor
   * frissült utoljára, a tartalma minden körben megváltozna — az üzenet
   * önmagát hajtaná, percenként, örökké.
   */
  it('a bot állapota nem tartalmaz időpontot', async () => {
    const szoveg = JSON.stringify(await render.renderMessage('bot_status', CTX))
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(szoveg), 'időbélyeg került a bot-állapotba')
  })

  it('a beállítás korlátozza a lista hosszát', async () => {
    const sok = await render.renderMessage('anime_schedule',
      { ...CTX, configuration: { limit: 999 } }) as { embeds: Array<{ description: string }> }
    const sorok = sok.embeds[0]!.description.split('\n').filter(s => s.startsWith('•'))
    assert.ok(sorok.length <= 15, `a felső korlát nem érvényesült: ${sorok.length} sor`)
  })
})
