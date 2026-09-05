// Joining, and the slowmode the setup is supposed to set.
//
// Two features that both fail quietly when they are wrong: a welcome that
// pings the whole server, and a blueprint that describes only the day it was
// applied.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { BLUEPRINT, allChannels } from '../src/blueprint.ts'
import { CHANNEL_TYPES, Rest, type Channel } from '../src/discord/rest.ts'
import { provision } from '../src/provision.ts'
import { welcomeMessage } from '../src/welcome.ts'

describe('the welcome message', () => {
  test('pings the person who joined and nobody else', () => {
    // Without an explicit allow-list, a username containing @everyone is
    // enough to make the bot mention the whole server.
    const message = welcomeMessage('42', { rules: 'r', faq: 'f', general: 'g' }) as {
      content: string, allowed_mentions: { parse: string[], users: string[] }
    }
    assert.match(message.content, /<@42>/)
    assert.deepEqual(message.allowed_mentions.parse, [], 'no role or @everyone mentions')
    assert.deepEqual(message.allowed_mentions.users, ['42'])
  })

  test('puts the mention in content, where Discord actually pings from', () => {
    // An embed-only mention is silent, which is the opposite of a welcome.
    const message = welcomeMessage('42', {}) as { content: string, embeds: unknown[] }
    assert.ok(message.content.includes('<@42>'))
    assert.ok(!JSON.stringify(message.embeds).includes('<@42>'))
  })

  test('leaves out links to channels that do not exist yet', () => {
    const message = welcomeMessage('42', { rules: 'r' }) as { content: string }
    assert.match(message.content, /<#r>/)
    assert.ok(!message.content.includes('<#undefined>'), message.content)
  })

  test('carries no personal data', () => {
    // At join time the bot knows a Discord id and nothing else. There is no
    // linked account to describe, and a section saying "not linked" for
    // everybody is noise.
    // Scanned over the *values*, not the serialised object: the JSON key
    // "description" contains "ip", and a blunt substring check over the whole
    // payload fails on that rather than on anything real.
    const collect = (value: unknown, out: string[] = []): string[] => {
      if (typeof value === 'string') out.push(value.toLowerCase())
      else if (Array.isArray(value)) for (const v of value) collect(v, out)
      else if (value && typeof value === 'object') for (const v of Object.values(value)) collect(v, out)
      return out
    }
    const text = collect(welcomeMessage('42', { rules: 'r' })).join(' ')
    for (const word of ['email', 'password', 'token', 'ip address', '@gmail']) {
      assert.ok(!text.includes(word), `welcome must not mention ${word}`)
    }
  })
})

describe('slowmode in the blueprint', () => {
  test('is set on the channels that attract spam and left off elsewhere', () => {
    const slow = new Map(allChannels().map(({ channel }) => [channel.key, channel.slowmodeSeconds]))
    for (const key of ['general', 'memes', 'bot_commands', 'help', 'bug_reports']) {
      assert.ok((slow.get(key) ?? 0) > 0, `${key} should have slowmode`)
    }
    // Staff talking to each other is not spam, and a gap there costs an
    // incident response real time.
    for (const key of ['staff_chat', 'security_alerts', 'mod_log']) {
      assert.equal(slow.get(key), undefined, `${key} must not be throttled`)
    }
  })

  test('never sets a gap long enough to break a conversation', () => {
    for (const { channel } of allChannels()) {
      assert.ok((channel.slowmodeSeconds ?? 0) <= 30, `${channel.key} is too slow to talk in`)
    }
  })
})

describe('setup corrects drift on channels that already exist', () => {
  /** A guild already carrying the whole blueprint, with per-channel overrides. */
  function established (overrides: Record<string, Partial<Channel>> = {}): { rest: Rest, patches: Array<{ id: string, body: Record<string, unknown> }> } {
    const patches: Array<{ id: string, body: Record<string, unknown> }> = []
    const channels: Channel[] = []
    let seq = 0

    for (const category of BLUEPRINT.categories) {
      const categoryId = `cat${++seq}`
      channels.push({ id: categoryId, name: category.name, type: CHANNEL_TYPES.category, parent_id: null })
      for (const channel of category.channels) {
        channels.push({
          id: `ch-${channel.key}`,
          name: channel.name,
          type: CHANNEL_TYPES[channel.kind],
          parent_id: categoryId,
          topic: channel.topic ?? null,
          rate_limit_per_user: channel.slowmodeSeconds ?? 0,
          ...overrides[channel.key]
        })
      }
    }

    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const path = String(url).replace('https://discord.com/api/v10', '')
      const method = init?.method ?? 'GET'
      const ok = (payload: unknown): Response => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })

      if (method === 'GET' && /^\/guilds\/[^/]+$/.test(path)) return ok({ id: 'g1', name: 'Yume', owner_id: 'o' })
      if (method === 'GET' && path.endsWith('/members/@me')) return ok({ roles: ['bot'] })
      if (method === 'GET' && path.endsWith('/roles')) {
        return ok([
          { id: 'g1', name: '@everyone', permissions: '0', position: 0, color: 0 },
          { id: 'bot', name: 'B', permissions: (1n << 3n).toString(), position: 9, color: 0 },
          ...BLUEPRINT.roles.map((r, i) => ({ id: `r${i}`, name: r.name, permissions: '0', position: i, color: 0 }))
        ])
      }
      if (method === 'GET' && path.endsWith('/channels')) return ok(channels)
      if (method === 'GET' && path.endsWith('/webhooks')) return ok([])
      if (method === 'PATCH' && /^\/channels\/[^/]+$/.test(path)) {
        patches.push({ id: path.split('/')[2] ?? '', body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
        return ok({})
      }
      if (method === 'PATCH' || method === 'POST') return ok({ id: `new${++seq}` })
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch

    return { rest: new Rest({ token: 't', fetchImpl }), patches }
  }

  test('a server already matching the blueprint is not touched', async () => {
    const { rest, patches } = established()
    await provision({ rest, guildId: 'g1' })
    assert.deepEqual(patches, [], 'nothing has drifted, so nothing may be written')
  })

  test('slowmode turned off by hand is turned back on', async () => {
    // The case this exists for: somebody disables it during a quiet week and
    // nobody remembers to restore it.
    const { rest, patches } = established({ general: { rate_limit_per_user: 0 } })
    await provision({ rest, guildId: 'g1' })
    const patch = patches.find(p => p.id === 'ch-general')
    assert.ok(patch, 'the drift must be corrected: ' + JSON.stringify(patches))
    assert.equal(patch.body.rate_limit_per_user, 2)
  })

  test('slowmode raised by hand is brought back to the blueprint', async () => {
    const { rest, patches } = established({ memes: { rate_limit_per_user: 600 } })
    await provision({ rest, guildId: 'g1' })
    assert.equal(patches.find(p => p.id === 'ch-memes')?.body.rate_limit_per_user, 5)
  })

  test('a channel the blueprint says nothing about is left alone', async () => {
    // Silence in the blueprint means "not my business", not "must be zero".
    // Forcing it would undo a moderator's decision on every setup run.
    const { rest, patches } = established({ manga: { rate_limit_per_user: 120 } })
    await provision({ rest, guildId: 'g1' })
    assert.equal(patches.find(p => p.id === 'ch-manga'), undefined)
  })

  test('a cleared topic is restored', async () => {
    const { rest, patches } = established({ general: { topic: '' } })
    await provision({ rest, guildId: 'g1' })
    assert.equal(patches.find(p => p.id === 'ch-general')?.body.topic, 'General chat')
  })

  test('the correction is reported as an action, not silently', async () => {
    const { rest } = established({ general: { rate_limit_per_user: 0 } })
    const report = await provision({ rest, guildId: 'g1' })
    const update = report.applied.find(a => a.kind === 'channel.update')
    assert.ok(update, 'an operator must be able to see what was changed')
    assert.match(update.reason, /slowmode/)
  })

  test('a plan shows the correction without making it', async () => {
    const { rest, patches } = established({ general: { rate_limit_per_user: 0 } })
    const report = await provision({ rest, guildId: 'g1', dryRun: true })
    assert.deepEqual(patches, [])
    assert.ok(report.planned.some(a => a.kind === 'channel.update' && a.key === 'general'))
  })
})
