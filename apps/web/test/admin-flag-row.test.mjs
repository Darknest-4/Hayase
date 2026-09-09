// A switch must not show a state the server refused.
//
// The Site config screen wrote every change straight through: flip the toggle,
// PATCH the flag, toast whatever came back. When the PATCH failed — read-only
// mode answers 503 to writes, a permission can be taken away mid-session, a
// connection drops — the toast scrolled past and the switch stayed in its new
// position. The operator saw a screen of settings they had set and the server
// had not accepted, and only a reload told them otherwise.
//
// This is the check: after a refused save, every control is back where it was.

import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import { install } from './support/browser.mjs'

let PageAdmin, YumeAPI

before(async () => {
  install()
  ;({ PageAdmin } = await import('../src/pages/admin.js'))
  ;({ YumeAPI } = await import('../src/shared/api/yume.js'))
})

const FLAG = { key: 'page.community', label: 'Community', enabled: true, access: 'public', required_permission: null }

/** Depth-first walk of the node tree the stub DOM builds. */
function * walk (node) {
  yield node
  for (const child of node.children ?? []) if (child && typeof child === 'object') yield * walk(child)
}

const find = (root, test) => [...walk(root)].find(test)
const checkbox = root => find(root, n => n.getAttribute?.('type') === 'checkbox')
const dropdown = root => find(root, n => n.tagName === 'SELECT')

/** Run the row with a setFlag that either resolves or rejects. */
function row (outcome) {
  const calls = []
  YumeAPI.admin.setFlag = async (key, patch) => {
    calls.push({ key, patch })
    if (outcome === 'refused') throw new Error('This instance is in read-only mode and is not accepting changes right now')
  }
  return { node: PageAdmin.flagRow(FLAG, async () => {}), calls }
}

describe('a feature flag row', () => {
  it('sends the change when the save is accepted, and keeps it', async () => {
    const { node, calls } = row('accepted')
    const box = checkbox(node)
    box.checked = false
    await box.listeners.change({ target: box })
    assert.deepEqual(calls, [{ key: 'page.community', patch: { enabled: false } }])
    assert.equal(box.checked, false, 'an accepted change stays')
  })

  it('puts the toggle back when the save is refused', async () => {
    const { node } = row('refused')
    const box = checkbox(node)
    box.checked = false // the click already moved it
    await box.listeners.change({ target: box })
    assert.equal(box.checked, true, 'a refused change must not be left on screen')
  })

  it('puts the access dropdown back when the save is refused', async () => {
    const { node } = row('refused')
    const select = dropdown(node)
    select.value = 'auth'
    await select.listeners.change({ target: select })
    assert.equal(select.value, 'public', 'a refused access change must not be left on screen')
  })

  it('puts the permission field back when the save is refused', async () => {
    const { node } = row('refused')
    const field = find(node, n => n.className?.includes('flag-perm'))
    field.value = 'roles.manage'
    await field.listeners.change({ target: field })
    assert.equal(field.value, '', 'a refused permission change must not be left on screen')
  })
})
