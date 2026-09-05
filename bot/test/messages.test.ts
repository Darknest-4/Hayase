// Post once, edit thereafter.
//
// The four outcomes are the whole feature, and three of them are easy to get
// wrong in ways nobody notices until a channel has a thousand messages in it.
// The fake Discord here counts posts and edits separately, so "it edited
// instead of posting" is an assertion rather than an impression.

import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'

import { Rest } from '../src/discord/rest.ts'
import { hashPayload, syncMessage } from '../src/messages.ts'
import { blueprintBoard, releaseEmbed, staticPage, statusBoard } from '../src/content.ts'

// The record store is reached through the Yume API with the global fetch, so
// the harness stubs that too — otherwise every lookup misses and every sync
// looks like a first post.
process.env.YUME_SERVICE_TOKEN = 'test-token'

/** A Discord plus the record store the bot would reach through the API. */
function harness (options: { editFails?: number } = {}): {
  rest: Rest
  posts: Array<{ channel: string, body: unknown }>
  edits: Array<{ message: string, body: unknown }>
  store: Map<string, { guild_id: string, channel_id: string, message_id: string, content_hash: string, key: string }>
} {
  const posts: Array<{ channel: string, body: unknown }> = []
  const edits: Array<{ message: string, body: unknown }> = []
  const store = new Map<string, { guild_id: string, channel_id: string, message_id: string, content_hash: string, key: string }>()
  let seq = 0

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    const ok = (payload: unknown, status = 200): Response =>
      new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })

    // ---- the record store, standing in for the Yume API -------------------
    if (target.includes('/v1/integrations/discord/messages/')) {
      const key = decodeURIComponent(target.split('/messages/')[1] ?? '')
      if (method === 'GET') {
        const row = store.get(key)
        return row ? ok(row) : new Response('{}', { status: 404 })
      }
      if (method === 'PUT') {
        store.set(key, {
          key,
          guild_id: String(body.guildId),
          channel_id: String(body.channelId),
          message_id: String(body.messageId),
          content_hash: String(body.contentHash)
        })
        return ok({ key })
      }
      if (method === 'DELETE') { store.delete(key); return new Response(null, { status: 204 }) }
    }

    // ---- Discord ----------------------------------------------------------
    const path = target.replace('https://discord.com/api/v10', '')
    if (method === 'POST' && /^\/channels\/[^/]+\/messages$/.test(path)) {
      posts.push({ channel: path.split('/')[2] ?? '', body })
      return ok({ id: `m${++seq}` })
    }
    if (method === 'PATCH' && /\/messages\/[^/]+$/.test(path)) {
      if (options.editFails && edits.length < options.editFails) {
        edits.push({ message: path.split('/').pop() ?? '', body })
        // The message was deleted by a moderator between renders.
        return ok({ message: 'Unknown Message', code: 10008 }, 404)
      }
      edits.push({ message: path.split('/').pop() ?? '', body })
      return ok({ id: path.split('/').pop() })
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch

  // messages.ts talks to the record store through the global fetch.
  globalThis.fetch = fetchImpl
  return { rest: new Rest({ token: 't', fetchImpl }), posts, edits, store }
}

describe('the content hash', () => {
  test('is stable for the same payload', () => {
    assert.equal(hashPayload(staticPage('rules')), hashPayload(staticPage('rules')))
  })

  test('changes when anything visible changes', () => {
    const a = statusBoard([{ name: 'API', status: 'healthy' }])
    const b = statusBoard([{ name: 'API', status: 'down' }])
    assert.notEqual(hashPayload(a), hashPayload(b))
  })

  test('no managed message carries a clock', () => {
    // A timestamp in the body would change the hash every render and rewrite
    // the message forever. Discord already shows when it was last edited.
    for (const payload of [staticPage('welcome'), staticPage('rules'), staticPage('faq'), blueprintBoard(), statusBoard([{ name: 'API', status: 'healthy' }])]) {
      const rendered = JSON.stringify(payload)
      assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(rendered), 'an ISO timestamp would make this rewrite itself')
      assert.equal(hashPayload(payload), hashPayload(payload))
    }
  })
})

describe('syncMessage', () => {
  let h: ReturnType<typeof harness>
  beforeEach(() => { h = harness() })

  test('posts the first time', async () => {
    const outcome = await syncMessage(h.rest, 'static:rules', 'chan-1', staticPage('rules'), 'g1')
    assert.equal(outcome, 'created')
    assert.equal(h.posts.length, 1)
    assert.equal(h.edits.length, 0)
  })

  test('does nothing at all when the content has not changed', async () => {
    // The case that makes this usable: the boards re-render on a timer and
    // most ticks change nothing, so a quiet hour must be zero API calls.
    await syncMessage(h.rest, 'static:rules', 'chan-1', staticPage('rules'), 'g1')
    h.posts.length = 0

    for (let i = 0; i < 5; i++) {
      assert.equal(await syncMessage(h.rest, 'static:rules', 'chan-1', staticPage('rules'), 'g1'), 'unchanged')
    }
    assert.deepEqual(h.posts, [])
    assert.deepEqual(h.edits, [], 'an unchanged render must not even edit')
  })

  test('edits the same message when the content changes', async () => {
    await syncMessage(h.rest, 'board:status', 'chan-1', statusBoard([{ name: 'API', status: 'healthy' }]), 'g1')
    const posted = h.posts.length

    const outcome = await syncMessage(h.rest, 'board:status', 'chan-1', statusBoard([{ name: 'API', status: 'down' }]), 'g1')
    assert.equal(outcome, 'edited')
    assert.equal(h.posts.length, posted, 'nothing new may be posted')
    assert.equal(h.edits.length, 1)
    assert.equal(h.edits[0]!.message, 'm1', 'it must edit the message it already owns')
  })

  test('a release that gains a quality edits its own announcement', async () => {
    const base = { id: 'anime-1:ep-3', title: 'Test', episode: 3, url: 'https://y/x' }
    await syncMessage(h.rest, `release:${base.id}`, 'chan-1', releaseEmbed(base), 'g1')
    const outcome = await syncMessage(h.rest, `release:${base.id}`, 'chan-1', releaseEmbed({ ...base, quality: '1080p' }), 'g1')

    assert.equal(outcome, 'edited')
    assert.equal(h.posts.length, 1, 'one episode, one message')
    assert.match(JSON.stringify(h.edits[0]!.body), /1080p/)
  })

  test('re-posts when somebody deleted the message', async () => {
    // A moderator clearing a channel is normal. The bot noticing and replacing
    // the board beats the board being gone until setup is re-run.
    const deleting = harness({ editFails: 1 })
    await syncMessage(deleting.rest, 'board:status', 'chan-1', statusBoard([{ name: 'API', status: 'healthy' }]), 'g1')
    const outcome = await syncMessage(deleting.rest, 'board:status', 'chan-1', statusBoard([{ name: 'API', status: 'down' }]), 'g1')

    assert.equal(outcome, 'recreated')
    assert.equal(deleting.posts.length, 2)
    assert.equal(deleting.store.get('board:status')?.message_id, 'm2', 'the new id must be remembered')
  })

  test('re-posts when the channel changed under it', async () => {
    await syncMessage(h.rest, 'board:status', 'chan-1', blueprintBoard(), 'g1')
    const outcome = await syncMessage(h.rest, 'board:status', 'chan-2', blueprintBoard(), 'g1')
    assert.equal(outcome, 'recreated', 'a message in another channel is not ours to edit')
    assert.equal(h.store.get('board:status')?.channel_id, 'chan-2')
  })

  test('two keys are two messages', async () => {
    await syncMessage(h.rest, 'static:rules', 'chan-1', staticPage('rules'), 'g1')
    await syncMessage(h.rest, 'static:faq', 'chan-1', staticPage('faq'), 'g1')
    assert.equal(h.posts.length, 2)
    assert.equal(h.store.size, 2)
  })
})
