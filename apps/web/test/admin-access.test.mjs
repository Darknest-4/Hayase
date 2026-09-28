// Az adminlink jogosultságlistája és a panel szakaszlistája — ugyanaz a halmaz.
//
// A router a könnyű `admin-access.js`-ből dönti el, látszik-e az
// „Adminisztráció" link; a panel az `admin-sections.js` szakaszaiból, mit
// mutat. Ha a kettő eltér, visszajön a régi hiba: az elemző látja a linket, és
// falba ütközik, vagy a moderátor nem látja, pedig van mit kezelnie.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { install } from './support/browser.mjs'

install()
const { ADMIN_PERMISSIONS } = await import('../src/shared/lib/admin-access.js')
const { ADMIN_SECTIONS } = await import('../src/shared/lib/admin-sections.js')

describe('az adminlink jogosultságai', () => {
  it('pontosan a szakaszok jogosultságai, se több, se kevesebb', () => {
    const fromSections = [...new Set(ADMIN_SECTIONS.map(s => s.perm).filter(Boolean))].sort()
    assert.deepEqual([...ADMIN_PERMISSIONS].sort(), fromSections)
  })

  it('a router a könnyű listát olvassa, nem a szakaszokat', () => {
    const router = readFileSync(new URL('../src/app/router.js', import.meta.url), 'utf8')
    assert.match(router, /from '\.\.\/shared\/lib\/admin-access\.js'/)
    assert.doesNotMatch(router, /(from|import\()\s*'[^']*admin-sections\.js'/)
  })
})
