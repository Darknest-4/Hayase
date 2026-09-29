// Trusted Types: minden HTML- és szkriptcím-nyelő a trusted.js szabályain megy át.
//
// A szerver CSP-je `require-trusted-types-for 'script'`-et kér, tehát
// Chromiumban egy nyers `el.innerHTML = '…'` nem XSS-rés, hanem KIVÉTEL: az a
// képernyő egyszerűen nem rajzolódik ki. Ez a teszt azt fogja meg, hogy egy új
// nyelő nyersen kerüljön a kódba — már a lint-lépésnél, nem egy felhasználó
// böngészőjében. A Firefox és a Safari nem kényszeríti ki, ott a hiba csak ebből
// a tesztből derülne ki.
//
// A szabály maga nem tisztít: a hívók SAJÁT sablonokat adnak át, a külső adat
// bennük escape()-elve vagy utólag textContent-ként kerül. Ezt az ígéretet az
// átnézés tartja; ez a teszt azt, hogy ne lehessen a szabályt megkerülni.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
// A Discord-vezérlőpult külön alkalmazás, de UGYANAZ a szerver szolgálja ki,
// ugyanazzal a CSP-vel — egy nyers nyelő ott is az egész lapot állítja meg (az
// E2E így fogta meg: „Nem indult el").
const DISCORD = fileURLToPath(new URL('../../discord/src/', import.meta.url))

function * sources (dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== 'vendor') yield * sources(path)
    } else if (name.endsWith('.js')) {
      yield path
    }
  }
}

/** A kód sorai megjegyzések nélkül — a trusted.js fejléce idéz nyelőket. */
function codeLines (path) {
  return readFileSync(path, 'utf8').split('\n')
    .map((text, index) => ({ text, line: index + 1 }))
    .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text))
}

describe('Trusted Types sinks', () => {
  const offences = []
  for (const path of [...sources(SRC), ...sources(DISCORD)]) {
    const file = relative(join(SRC, '..', '..'), path)
    for (const { text, line } of codeLines(path)) {
      const at = `${file}:${line}`
      if (/\.innerHTML\s*=/.test(text) && !/\.innerHTML\s*=\s*trustedHTML\(/.test(text)) offences.push(`${at} innerHTML without trustedHTML()`)
      if (/parseFromString\(/.test(text) && !/parseFromString\(inertHTML\(/.test(text)) offences.push(`${at} DOMParser without inertHTML()`)
      if (/\bscript\.src\s*=/.test(text) && !/script\.src\s*=\s*trustedScriptURL\(/.test(text)) offences.push(`${at} script.src without trustedScriptURL()`)
      if (/insertAdjacentHTML|\.outerHTML\s*=|document\.write\(|\.srcdoc\s*=|new Function\(|\beval\(/.test(text)) offences.push(`${at} a sink with no policy at all`)
    }
  }

  it('all go through trusted.js', () => {
    assert.deepEqual(offences, [], 'raw sinks break the page in Chromium under the CSP')
  })

  it('the list is not empty because the scan found nothing', () => {
    // Ha a keresés elcsúszna (rossz könyvtár, átnevezett fájlok), a fenti állítás
    // semmit keresve menne át. A dom.js `html` kulcsa biztosan nyelő.
    const dom = readFileSync(join(SRC, 'shared/lib/dom.js'), 'utf8')
    assert.match(dom, /node\.innerHTML = trustedHTML\(value\)/)
    const dashboard = readFileSync(join(DISCORD, 'dom.js'), 'utf8')
    assert.match(dashboard, /node\.innerHTML = trustedHTML\(path\)/)
  })
})

describe('the policies', () => {
  const created = []
  const SHARED = Symbol.for('yume.trusted-types')
  afterEach(() => {
    delete globalThis.trustedTypes
    delete globalThis[SHARED]
  })

  const withTrustedTypes = async () => {
    created.length = 0
    delete globalThis[SHARED]
    globalThis.trustedTypes = {
      createPolicy (name, rules) {
        // Mint a böngésző `'allow-duplicates'` nélkül: egy név egyszer.
        if (created.includes(name)) throw new TypeError(`Policy "${name}" disallowed.`)
        created.push(name)
        return {
          createHTML: html => ({ trusted: 'html', value: rules.createHTML(html) }),
          createScriptURL: url => ({ trusted: 'url', value: rules.createScriptURL(url) })
        }
      }
    }
    globalThis.location ??= { href: 'https://animehub.hu/' }
    return import(`../src/shared/lib/trusted.js?tt=${Math.random()}`)
  }

  it('are created under the names the server allows', async () => {
    const trusted = await withTrustedTypes()
    assert.deepEqual(created, trusted.POLICY_NAMES)
    assert.deepEqual(trusted.POLICY_NAMES, ['yume', 'yume-inert'])
  })

  it('wrap templates and inert text as trusted values', async () => {
    const trusted = await withTrustedTypes()
    assert.deepEqual(trusted.trustedHTML('<b>x</b>'), { trusted: 'html', value: '<b>x</b>' })
    assert.deepEqual(trusted.inertHTML('<i>y</i>'), { trusted: 'html', value: '<i>y</i>' })
  })

  it('let a script come only from the Turnstile origin', async () => {
    const trusted = await withTrustedTypes()
    const ok = trusted.trustedScriptURL('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit')
    assert.equal(ok.trusted, 'url')
    assert.throws(() => trusted.trustedScriptURL('https://evil.example/x.js'), TypeError)
    assert.throws(() => trusted.trustedScriptURL('/src/app/main.js'), TypeError, 'not even our own origin — nothing needs it')
  })

  it('survive the module being loaded twice under two URLs', async () => {
    // Az oldal a /b/<bélyeg>/ alól, egy próbapad a /src/ alól tölti: két példány,
    // de a második nem hozhat létre új szabályt — az elsőét kell használnia.
    const first = await withTrustedTypes()
    const second = await import(`../src/shared/lib/trusted.js?second=${Math.random()}`)
    assert.deepEqual(created, ['yume', 'yume-inert'], 'each name is created once')
    assert.deepEqual(first.trustedHTML('<b>1</b>'), { trusted: 'html', value: '<b>1</b>' })
    assert.deepEqual(second.trustedHTML('<b>2</b>'), { trusted: 'html', value: '<b>2</b>' })
  })

  it('check the origin even where the browser has no Trusted Types', async () => {
    const trusted = await import(`../src/shared/lib/trusted.js?plain=${Math.random()}`)
    assert.equal(trusted.trustedHTML('<b>x</b>'), '<b>x</b>')
    assert.throws(() => trusted.trustedScriptURL('https://evil.example/x.js'), TypeError)
  })
})
