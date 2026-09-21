// A Player 2.0 kapcsolója — a bevezetés biztosítéka.
//
// A `featureOn` szándékosan MEGENGEDŐ: amiről a kapcsolótábla nem tud, azt
// átengedi. Egy új gombnál ez helyes; egy teljes lejátszócserénél viszont azt
// jelentené, hogy a hiányzó sor mellett az ÚJ lejátszó indul el mindenkinél —
// az első éles kérésnél, mérés nélkül.
//
// Ez a készlet azt rögzíti, hogy a nézőoldal KÉT dolgot kérdez meg, és mindkét
// válasznak igennek kell lennie.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { install } from './support/browser.mjs'

const here = dirname(fileURLToPath(import.meta.url))
install()

const { configure, featureOn, flagDeclared } = await import('../src/shared/lib/site-config.js')

const withFlags = (flags, permissions = []) =>
  configure({ config: { site: {}, flags }, permissions, signedIn: () => true })

describe('a kapcsoló megengedő alapértelmezése', () => {
  it('ismeretlen kapcsolót átenged — ez a szándék a többi funkciónál', () => {
    withFlags({})
    assert.equal(featureOn('valami_uj'), true)
  })

  it('…de a lejátszócserénél ez lenne a rossz irány', () => {
    // Sor nélkül a `featureOn` igazat mond. A `flagDeclared` az, ami nemet.
    withFlags({})
    assert.equal(featureOn('player2'), true, 'a megengedő viselkedés megváltozott')
    assert.equal(flagDeclared('feature.player2'), false)
  })
})

describe('a nézőoldal kapuja', () => {
  const gate = () => flagDeclared('feature.player2') && featureOn('player2')

  it('hiányzó sor: a régi lejátszó megy', () => {
    withFlags({})
    assert.equal(gate(), false)
  })

  it('kikapcsolt sor: a régi lejátszó megy', () => {
    withFlags({ 'feature.player2': { enabled: false, access: 'public' } })
    assert.equal(gate(), false)
  })

  it('bekapcsolt sor: az új lejátszó megy', () => {
    withFlags({ 'feature.player2': { enabled: true, access: 'public' } })
    assert.equal(gate(), true)
  })

  it('jogosultsághoz kötve csak annak, aki bírja', () => {
    // A fokozatos bevezetés útja: előbb csak az üzemeltetőnek.
    const limited = { 'feature.player2': { enabled: true, access: 'permission', permission: 'admin.settings.manage' } }
    withFlags(limited, [])
    assert.equal(gate(), false, 'jogosultság nélkül is átengedte')

    withFlags(limited, ['admin.settings.manage'])
    assert.equal(gate(), true)
  })
})

describe('a nézőoldal tényleg ezt a kaput használja', () => {
  it('a watch.js mindkét kérdést felteszi', () => {
    // Forráskódra állítás, mert a lap betöltése az egész alkalmazást
    // behúzná. Amit itt bizonyítunk, az az, hogy a kapu nem egyszerűsödött
    // vissza egyetlen `featureOn`-ra egy későbbi szerkesztésben.
    const source = readFileSync(join(here, '../src/pages/watch.js'), 'utf8')
    assert.match(source, /flagDeclared\('feature\.player2'\)\s*&&\s*featureOn\('player2'\)/,
      'a kapu már nem kér kettős igazolást')
    assert.ok(source.includes('mountPlayer2'), 'nincs bekötve az új lejátszó')
  })

  it('az áttérés kikapcsolva hozza létre a sort', () => {
    const sql = readFileSync(join(here, '../../../database/migrations/0058_player2_flag.sql'), 'utf8')
    assert.match(sql, /'feature\.player2'[\s\S]{0,80}false/, 'a kapcsoló nem kikapcsolva jön létre')
    assert.ok(sql.includes('ON CONFLICT'), 'az áttérés nem ismételhető')
  })
})
