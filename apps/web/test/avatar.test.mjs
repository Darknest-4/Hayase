// One face, eight places.
//
// The same picture has to appear in the sidebar, the mobile sheet, the profile
// header, the community feed, forum topics and posts, and every line of chat —
// and each of those places gets its row from a different source, spelling the
// same field four different ways: `avatar_key` on the profile row,
// `author_avatar` on an API row, `authorAvatar` from the socket, and `avatar`
// from the local store. The component reads all four so that no call site has
// to normalise, which only works if it keeps reading all four.
//
// The fallback matters as much as the picture. A CDN that fails must leave the
// initial rather than an empty square, and an emoji avatar — the old kind,
// still on every account that never chose a title — is text, not an image.

import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import { install } from './support/browser.mjs'

let C

before(async () => {
  install()
  ;({ C } = await import('../src/shared/ui/components.js'))
})

const img = node => node.children.find(child => child?.tagName === 'IMG')

describe('C.avatar', () => {
  it('reads the picture under any of the four spellings', () => {
    const url = 'https://cdn.example/one-piece.jpg'
    for (const person of [
      { name: 'A', avatar_key: url },
      { author: 'A', author_avatar: url },
      { author: 'A', authorAvatar: url },
      { name: 'A', avatar: url }
    ]) {
      const node = C.avatar(person)
      assert.equal(img(node)?.getAttribute('src'), url, JSON.stringify(person))
    }
  })

  it('keeps the initial underneath, so a dead image leaves a letter', () => {
    const node = C.avatar({ name: 'Darknest', avatar_key: 'https://cdn.example/x.jpg' })
    assert.equal(node.textContent, 'D')
    assert.match(node.className, /avatar-image/)
  })

  it('removes the image rather than showing a broken one', () => {
    const node = C.avatar({ name: 'Darknest', avatar_key: 'https://cdn.example/gone.jpg' })
    const picture = img(node)
    let removed = false
    picture.remove = () => { removed = true }
    picture.listeners.error?.({ target: picture })
    assert.ok(removed, 'the error handler must take the image out')
  })

  it('draws an emoji as text, not as an image', () => {
    const node = C.avatar({ name: 'Darknest', avatar_key: '🌙' })
    assert.equal(node.textContent, '🌙')
    assert.equal(img(node), undefined)
  })

  it('falls back to a letter with nothing to show', () => {
    assert.equal(C.avatar({ author: 'zoli' }).textContent, 'Z')
    assert.equal(C.avatar({}).textContent, '·')
    assert.equal(C.avatar(null).textContent, '·')
  })

  it('carries the size through, because chat and the profile header differ', () => {
    assert.match(C.avatar({ name: 'A' }, { size: 'xs' }).className, /avatar-xs/)
    assert.match(C.avatar({ name: 'A' }, { size: 'xl' }).className, /avatar-xl/)
  })
})
