// Does the client call anything that is not there?
//
// The Notifications route was dead. `PageNotifications.render()` awaited
// `YumeAPI.notifications({ limit: 50 })`, that method did not exist, the call
// threw "is not a function", and the router's catch painted the error state —
// so a top-level route in the sidebar had never worked. The admin panel's bell
// called the same missing method through optional chaining, failed silently,
// and always showed the local count.
//
// Both endpoints were on the server the whole time. Nothing connected them.
//
// This is the check that would have caught it, and it is cheap: the client is
// plain scripts with no build step and no type checker, so a call to a method
// nobody wrote is a runtime error on the page and nothing before it. The
// syntax check in CI parses each file in isolation and cannot see across them.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'src')
const api = readFileSync(join(SRC, 'shared/api/yume.js'), 'utf8')

/** Every client script except the vendored third-party ones. */
function scripts (dir = SRC, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'vendor') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) scripts(path, out)
    else if (entry.name.endsWith('.js')) out.push(path)
  }
  return out
}

/**
 * Members declared in an object-literal body.
 *
 * Both spellings the file uses: `name (args) {` methods and `name: value`
 * properties. Indentation-anchored because the alternative is parsing
 * JavaScript, which is a dependency this repository does not otherwise need.
 */
const members = block =>
  new Set([...block.matchAll(/^\s{2,8}(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:\(|:)/gm)].map(m => m[1]))

/** Body of the object literal opened at `openIndex` (index of its `{`). */
function objectBody (source, openIndex) {
  let depth = 0
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(openIndex + 1, i)
  }
  return ''
}

const top = members(api)
const namespaces = {}
for (const m of api.matchAll(/^\s{2,6}([A-Za-z_$][\w$]*)\s*:\s*\{/gm)) {
  namespaces[m[1]] = members(objectBody(api, m.index + m[0].lastIndexOf('{')))
}

describe('the client only calls API methods that exist', () => {
  const files = scripts().filter(f => !f.endsWith('yume-api.js'))

  it('reads the API surface at all', () => {
    // Without this the assertions below would pass by finding nothing: a
    // renamed file or a changed object shape must fail loudly, not quietly.
    assert.ok(top.size > 50, `only ${top.size} members parsed out of yume-api.js`)
    assert.ok(Object.keys(namespaces).length > 3, 'no namespaces parsed')
    assert.ok(top.has('admin') && namespaces.admin?.size > 10, 'the admin namespace did not parse')
  })

  it('calls no top-level method that is missing', () => {
    const missing = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\bYumeAPI\.([A-Za-z_$][\w$]*)/g)) {
        if (top.has(m[1])) continue
        missing.push(`YumeAPI.${m[1]} — ${file.slice(file.indexOf('/web/') + 1)}:${text.slice(0, m.index).split('\n').length}`)
      }
    }
    assert.deepEqual([...new Set(missing)], [])
  })

  it('calls no namespaced method that is missing', () => {
    // `YumeAPI.admin.badges()` and the like. Only namespaces this file could
    // read are checked, so a deeper nesting it cannot parse is skipped rather
    // than reported as absent.
    const missing = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\bYumeAPI\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
        const ns = namespaces[m[1]]
        if (!ns || ns.has(m[2])) continue
        missing.push(`YumeAPI.${m[1]}.${m[2]} — ${file.slice(file.indexOf('/web/') + 1)}:${text.slice(0, m.index).split('\n').length}`)
      }
    }
    assert.deepEqual([...new Set(missing)], [])
  })

  it('still has the two the notifications route needs', () => {
    // Named rather than left to the sweep above: this is the pair whose
    // absence took a whole route down, and a regression here should say so.
    assert.ok(top.has('notifications'), 'YumeAPI.notifications is gone again')
    assert.ok(top.has('markNotificationsRead'), 'YumeAPI.markNotificationsRead is gone again')
  })
})
