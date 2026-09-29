// A Trusted Types visszaléptethető telepítés nélkül: CSP_TRUSTED_TYPES=report.
//
// Jelentő módban a követelmény a Content-Security-Policy-Report-Only fejlécbe
// kerül — a böngésző konzolja jelez, de semmi nem áll meg —, a kikényszerített
// CSP-ből pedig kimarad. Ez az üzemeltető vészkijárata, ha egy harmadik féltől
// jövő szkript nem viseli el a kikényszerítést. `off` mellett egyik sincs.
//
// Külön fájl, mert a CSP a modul betöltésekor épül: a változónak az import
// ELŐTT kell ott lennie, és a node --test fájlonként külön folyamatot indít.
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

process.env.JWT_SECRET ??= 'test-secret-for-unit-tests-only'
process.env.CSP_TRUSTED_TYPES = 'report'

const { buildApp } = await import('../src/app.ts')
const app = await buildApp()
after(() => app.close())

describe('Trusted Types in report mode', () => {
  it('moves the requirement to the report-only header', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' })
    const enforced = String(res.headers['content-security-policy'])
    const reported = String(res.headers['content-security-policy-report-only'])
    assert.doesNotMatch(enforced, /trusted-types/)
    assert.match(enforced, /script-src 'self'/, 'the rest of the policy stays enforced')
    assert.match(reported, /require-trusted-types-for 'script'/)
    assert.match(reported, /trusted-types yume yume-inert/)
  })
})
