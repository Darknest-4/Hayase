// A mentés leállását észre kell venni.
//
// Ez volt az egyetlen rendszer a platformon, aminek a megállásáról semmi nem
// szólt: a mentés éjszakánként futott, ellenőrizte magát, és ha egy éjjel
// kimaradt, arról pontosan addig nem szerzett tudomást senki, amíg vissza nem
// kellett állítani valamit. A panel megmutatta, mi van a lemezen — de csak
// annak, aki odanézett.
//
// Most mérőszám, ugyanazzal a küszöbbel, riasztással és állapotjelzéssel,
// mint a processzor vagy a memória. A fájl azt köti ki, ami ezt használhatóvá
// teszi:
//
//   * a hiányzó mentés NEM nulla óra — egy friss telepítés ne riasszon;
//   * a nem ellenőrzött mentés nem számít mentésnek;
//   * és a küszöb ott van, ahol egy kimaradt éjszaka még nem, kettő már igen.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

describe('a backup that stopped is noticed', () => {
  test('the threshold answers "one missed night" and "two"', async () => {
    const { DEFAULTS, compare } = await import('../src/modules/system/thresholds.ts')
    const t = DEFAULTS['backup.age_hours']

    // Egy napi futás ±néhány óra: 26 óra még rendben van.
    assert.equal(compare(26, t), 'green', 'egy késve induló futás hamis riasztást adott')
    // Egy kimaradt éjszaka.
    assert.equal(compare(31, t), 'yellow')
    // Kettő már nem késés.
    assert.equal(compare(50, t), 'red')
  })

  test('a missing backup is a missing reading, not zero hours', async () => {
    const { toSamples } = await import('../src/modules/system/monitor-worker.ts')
    const host = {
      cpuUsagePct: 5, cores: 4, load1: 0.1, load5: 0.1, load15: 0.1, loadPerCore: 0.025,
      uptimeSec: 1000,
      memory: { usedPct: 20, usedBytes: 1, totalBytes: 2, swapUsedPct: 0 },
      disk: { usedPct: 10, usedBytes: 1, totalBytes: 2 },
      diskIo: { readBps: 0, writeBps: 0, iops: 0, awaitMs: 0 },
      network: { rxBps: 0, txBps: 0, dropPct: 0 },
      netLatencyMs: 10
    } as never

    const without = toSamples(host, [], { pending: 0, dead: 0 }, null)
    assert.equal(without.find(s => s.metric === 'backup.age_hours'), undefined,
      'a hiányzó mentés mintaként jelent meg — egy friss telepítés ezzel azonnal riasztana')

    const with_ = toSamples(host, [], { pending: 0, dead: 0 }, 12.5)
    const sample = with_.find(s => s.metric === 'backup.age_hours')
    assert.equal(sample?.value, 12.5)
    assert.equal(sample?.unit, 'hours')
  })

  test('the metric is one the alerting actually reads', async () => {
    // A `toReadings` csak azokat a mintákat alakítja riasztássá, amiknek van
    // küszöbük. Küszöb nélkül a mérőszám csendben elveszne: rögzülne, és soha
    // nem szólna — ami pontosan az az állapot, amiből ez a munka indult.
    const { DEFAULTS } = await import('../src/modules/system/thresholds.ts')
    assert.ok('backup.age_hours' in DEFAULTS, 'nincs küszöb, tehát a riasztás sosem fut le rá')
  })
})
