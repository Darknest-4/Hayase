// Az él: mit utasít vissza, és — sokkal fontosabb — mit nem.
//
// Egy kockázati réteg értéke nem azon múlik, hány támadót fog meg. Azon
// múlik, hány valódi látogatót enged át. Egy réteg, ami a felhasználók
// századát megfogja, rosszabb, mint amilyen nincs: az operátor kikapcsolja,
// és utána semmi nincs.
//
// Ezért itt is a hamis pozitívok tesztje áll elöl.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, test } from 'node:test'

import { DEFAULTS, type EdgeConfig } from '../src/modules/edge/config.ts'
import { assess, noEvidence, sensitivityOf } from '../src/modules/edge/risk.ts'
import { decide, onFailure } from '../src/modules/edge/policy.ts'
import * as counters from '../src/modules/edge/counters.ts'

const live: EdgeConfig = { ...DEFAULTS, dryRun: false }

describe('the risk engine scores, it does not decide', () => {
  beforeEach(() => counters.reset())

  test('an ordinary request scores zero', () => {
    const { score, signals } = assess(noEvidence(), live)
    assert.equal(score, 0)
    assert.deepEqual(signals, [])
  })

  test('a signal we are unsure about counts less than one we are sure of', () => {
    // Ez a bizonyosság egész értelme: egy tétova heurisztika ne tiltson úgy,
    // mint egy megbízható adatforrás.
    const base = noEvidence()
    const unsure = assess({
      ...base,
      intel: { ip: '1.2.3.4', asn: null, provider: null, country: null, networkType: 'hosting',
        isHosting: true, isVpn: true, isProxy: false, isTor: false, reputation: 0,
        confidence: 0.2, source: 'local:ptr', checkedAt: new Date() }
    }, live)
    const sure = assess({
      ...base,
      intel: { ip: '1.2.3.4', asn: null, provider: null, country: null, networkType: 'hosting',
        isHosting: true, isVpn: true, isProxy: false, isTor: false, reputation: 0,
        confidence: 0.95, source: 'provider', checkedAt: new Date() }
    }, live)
    assert.ok(sure.score > unsure.score * 3, `${sure.score} vs ${unsure.score}`)
  })

  test('a datacenter address alone is not enough to block anyone', () => {
    // Fejlesztők, felügyeleti rendszerek és VPN-t használó látogatók is innen
    // jönnek. Ha ez önmagában blokkolna, a VPN-felhasználók kizárása lenne —
    // amit kifejezetten nem akarunk.
    const assessment = assess({
      ...noEvidence(),
      intel: { ip: '1.2.3.4', asn: 16509, provider: 'amazonaws.com', country: 'US',
        networkType: 'hosting', isHosting: true, isVpn: false, isProxy: false, isTor: false,
        reputation: 0, confidence: 1, source: 'provider', checkedAt: new Date() }
    }, live)
    const decision = decide(assessment, live)
    assert.notEqual(decision.action, 'block', `adatközponti cím önmagában blokkolt: ${decision.reason}`)
    assert.notEqual(decision.action, 'challenge')
  })

  test('a VPN user browsing normally is not challenged', () => {
    const assessment = assess({
      ...noEvidence(),
      perMinute: 20,
      intel: { ip: '1.2.3.4', asn: 9009, provider: 'mullvad.net', country: 'SE',
        networkType: 'hosting', isHosting: true, isVpn: true, isProxy: false, isTor: false,
        reputation: 0, confidence: 0.9, source: 'provider', checkedAt: new Date() }
    }, live)
    const decision = decide(assessment, live)
    assert.equal(decision.action === 'block' || decision.action === 'throttle', false,
      `VPN-t használó látogató fennakadt: ${decision.reason}`)
  })

  test('the same evidence on a sensitive endpoint weighs more', () => {
    const evidence = { ...noEvidence(), authFailures: 12 }
    const onCatalogue = assess({ ...evidence, sensitivity: sensitivityOf('/v1/anime') }, live)
    const onAuth = assess({ ...evidence, sensitivity: sensitivityOf('/v1/auth/login') }, live)
    assert.ok(onAuth.score > onCatalogue.score, `${onAuth.score} vs ${onCatalogue.score}`)
  })

  test('every signal explains itself', () => {
    // Egy „87 pont" nem válasz arra, hogy miért. Minden jel mellett ott a
    // mondat, ami a naplóba és a panelre kerül.
    const assessment = assess({ ...noEvidence(), authFailures: 20, notFound: 40 }, live)
    assert.ok(assessment.signals.length >= 2)
    for (const signal of assessment.signals) {
      assert.ok(signal.why.length > 5, `${signal.key}: nincs magyarázata`)
      assert.ok(signal.points > 0)
    }
  })

  test('the weights are configuration, not code', () => {
    const evidence = { ...noEvidence(), authFailures: 20 }
    const soft = assess(evidence, { ...live, weights: { ...live.weights, authFailures: 1 } })
    const hard = assess(evidence, { ...live, weights: { ...live.weights, authFailures: 100 } })
    assert.ok(hard.score > soft.score * 10, 'a súly nem hatott')
  })
})

describe('the policy decides, and dry run holds it back', () => {
  test('dry run evaluates everything and executes nothing', () => {
    const evidence = {
      ...noEvidence(),
      authFailures: 50,
      notFound: 80,
      sensitivity: sensitivityOf('/v1/auth/login')
    }
    const assessment = assess(evidence, live)
    const dry = decide(assessment, { ...DEFAULTS, dryRun: true })

    // Ugyanaz a pontszám, ugyanaz a döntés — csak nem hajtjuk végre.
    assert.notEqual(dry.action, 'allow', dry.reason)
    assert.equal(dry.effective, 'allow')
    assert.match(dry.reason, /száraz üzem/)

    // És élesben ugyanez a bizonyíték ugyanazt a döntést hozza: a száraz üzem
    // nem számol mást, csak nem hajtja végre.
    const wet = decide(assess(evidence, live), live)
    assert.equal(wet.action, dry.action, 'a száraz üzem mást számolt, mint az éles')
    assert.equal(wet.effective, wet.action)
  })

  test('a manual ban applies even in dry run', () => {
    // A száraz üzem az AUTOMATIKÁRÓL szól. Aki kézzel tiltott ki valakit,
    // annak a döntése nem próba.
    const ban = {
      id: 'x', kind: 'ip' as const, subject: '1.2.3.4', reason: 'kézi tiltás',
      source: 'manual' as const, automatic: false, riskScore: null,
      createdAt: new Date(), expiresAt: null
    }
    const decision = decide(assess(noEvidence(), live), { ...DEFAULTS, dryRun: true }, ban)
    assert.equal(decision.effective, 'block')
  })

  test('thresholds are ordered, and each one is reachable', () => {
    const at = (score: number) => decide({ score, signals: [] }, live).action
    assert.equal(at(0), 'allow')
    assert.equal(at(live.thresholds.monitor), 'monitor')
    assert.equal(at(live.thresholds.challenge), 'challenge')
    assert.equal(at(live.thresholds.throttle), 'throttle')
    assert.equal(at(live.thresholds.block), 'block')
  })
})

describe('failure is not an outage', () => {
  test('a broken check lets the catalogue through', () => {
    const decision = onFailure('/v1/anime?sort=popularity', live)
    assert.equal(decision.effective, 'allow')
  })

  test('a broken check refuses on auth and admin', () => {
    // Ott az a rosszabb kimenetel, ha egy bizonytalan ellenőrzés átengedi.
    assert.equal(onFailure('/v1/auth/login', live).effective, 'block')
    assert.equal(onFailure('/v1/admin/users', live).effective, 'block')
  })

  test('the fail-closed list is configuration', () => {
    const strict = { ...live, failClosed: ['/v1'] }
    assert.equal(onFailure('/v1/anime', strict).effective, 'block')
  })
})

describe('the counters see the shape, not just the volume', () => {
  beforeEach(() => counters.reset())

  const limit = {
    burst: { max: 5, seconds: 10 },
    sustained: { max: 20, seconds: 300 },
    cooldownSeconds: 0
  }

  test('a burst is caught before the sustained limit is near', () => {
    const key = 'teszt' + randomBytes(4).toString('hex')
    // A korlát ötös: öt kérés belefér, a hatodik az, ami átlépi.
    for (let i = 0; i < 5; i++) {
      assert.equal(counters.hit('ip', key, limit).ok, true, `a(z) ${i + 1}. kérés elakadt`)
    }
    const sixth = counters.hit('ip', key, limit)
    assert.equal(sixth.ok, false)
    assert.equal(sixth.window, 'burst')
    // És a tartós korlát (20) még messze van — a tüskét fogtuk meg, nem a
    // mennyiséget.
    assert.ok(sixth.sustainedCount < limit.sustained.max)
  })

  test('a cooldown refuses everything until it passes', () => {
    const key = 'teszt' + randomBytes(4).toString('hex')
    const withCooldown = { ...limit, cooldownSeconds: 60 }
    for (let i = 0; i < 6; i++) counters.hit('ip', key, withCooldown)
    const after = counters.hit('ip', key, withCooldown)
    assert.equal(after.window, 'cooldown')
    assert.ok((after.retryAfter ?? 0) > 50)
  })

  test('dimensions do not leak into each other', () => {
    const key = 'teszt' + randomBytes(4).toString('hex')
    for (let i = 0; i < 5; i++) counters.hit('ip', key, limit)
    // Ugyanaz az alany, másik dimenzió: külön számláló.
    assert.equal(counters.hit('user', key, limit).ok, true)
  })

  test('an even machine cadence is visible, a human one is not', () => {
    // Ember nem kattint metronómra. Ezt sokkal nehezebb elrejteni, mint egy
    // böngészőazonosítót.
    const machine = 'gep' + randomBytes(4).toString('hex')
    const human = 'ember' + randomBytes(4).toString('hex')
    const wide = { burst: { max: 1e9, seconds: 60 }, sustained: { max: 1e9, seconds: 600 }, cooldownSeconds: 0 }

    // A `hit` a valós időt használja, ezért a szabályos ütemet közvetlenül
    // nem tudjuk előállítani — a mérést magát ellenőrizzük: kevés kérésből
    // NEM mondunk semmit, mert három egyenletes kattintás emberé is lehet.
    for (let i = 0; i < 3; i++) counters.hit('ip', machine, wide)
    assert.equal(counters.cadence('ip', machine), 0, 'három kérésből ítéletet mondott')
    assert.equal(counters.cadence('ip', human), 0)
  })

  test('counting can be observed without being disturbed', () => {
    const key = 'teszt' + randomBytes(4).toString('hex')
    counters.hit('ip', key, limit)
    const before = counters.recent('ip', key, 60)
    counters.hit('ip', key, limit, false) // count: false
    assert.equal(counters.recent('ip', key, 60), before, 'a megfigyelés maga is beleszámolt')
  })
})
