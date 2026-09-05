// The provisioner, against a Discord that only exists in this file.
//
// The property worth testing is the one the whole design rests on: run it
// twice and the second run writes nothing. A fake API makes that assertion
// exact — every write is recorded, so "wrote nothing" is a number, not an
// impression. Testing it against a real guild would be slower, rate-limited,
// and could only ever check one server's particular state.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { BLUEPRINT, allChannels } from '../src/blueprint.ts'
import { CHANNEL_TYPES, Rest } from '../src/discord/rest.ts'
import { PERMISSIONS, has, toBits } from '../src/discord/permissions.ts'
import { overwritesFor, provision, inviteUrl } from '../src/provision.ts'

/** A Discord guild that remembers what was created in it. */
function fakeDiscord (options: { botPermissions?: string[] } = {}): { rest: Rest, writes: string[], state: { roles: Array<{ id: string, name: string, permissions: string, position: number, color: number }>, channels: Array<{ id: string, name: string, type: number, parent_id: string | null }>, webhooks: Map<string, Array<{ id: string, name: string, channel_id: string, url: string }>> } } {
  let seq = 0
  const next = (): string => `id${++seq}`
  const state = {
    roles: [{ id: 'guild-1', name: '@everyone', permissions: '0', position: 0, color: 0 }],
    channels: [] as Array<{ id: string, name: string, type: number, parent_id: string | null }>,
    webhooks: new Map<string, Array<{ id: string, name: string, channel_id: string, url: string }>>()
  }
  const writes: string[] = []

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace('https://discord.com/api/v10', '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    const ok = (payload: unknown): Response => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })

    if (method === 'GET' && /^\/guilds\/[^/]+$/.test(path)) return ok({ id: 'guild-1', name: 'Yume', owner_id: 'owner' })
    if (method === 'GET' && path.endsWith('/members/@me')) {
      return ok({ roles: ['bot-role'] })
    }
    if (method === 'GET' && path.endsWith('/roles')) {
      const bot = { id: 'bot-role', name: 'YumeBot', permissions: toBits(options.botPermissions ?? ['Administrator']), position: 99, color: 0 }
      return ok([...state.roles, bot])
    }
    if (method === 'POST' && path.endsWith('/roles')) {
      writes.push(`role:${String(body.name)}`)
      const role = { id: next(), name: String(body.name), permissions: String(body.permissions), position: state.roles.length, color: Number(body.color ?? 0) }
      state.roles.push(role)
      return ok(role)
    }
    if (method === 'PATCH' && /\/roles\/[^/]+$/.test(path)) {
      writes.push(`role-update:${path}`)
      return ok({})
    }
    if (method === 'GET' && path.endsWith('/channels')) return ok(state.channels)
    if (method === 'POST' && path.endsWith('/channels')) {
      writes.push(`channel:${String(body.name)}`)
      const channel = { id: next(), name: String(body.name), type: Number(body.type), parent_id: (body.parent_id as string) ?? null }
      state.channels.push(channel)
      return ok(channel)
    }
    if (method === 'GET' && path.endsWith('/webhooks')) {
      const channelId = path.split('/')[2] ?? ''
      return ok(state.webhooks.get(channelId) ?? [])
    }
    if (method === 'POST' && path.endsWith('/webhooks')) {
      const channelId = path.split('/')[2] ?? ''
      writes.push(`webhook:${String(body.name)}`)
      const hook = { id: next(), name: String(body.name), channel_id: channelId, url: `https://discord.com/api/webhooks/${next()}/secret` }
      state.webhooks.set(channelId, [...(state.webhooks.get(channelId) ?? []), hook])
      return ok(hook)
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch

  return { rest: new Rest({ token: 'test', fetchImpl }), writes, state }
}

describe('the blueprint', () => {
  test('gives Administrator to exactly the two roles that are meant to have it', () => {
    // The rule the brief states and the reason it matters: a moderator who can
    // delete a message does not need to be able to delete the server.
    const admins = BLUEPRINT.roles.filter(r => r.permissions.includes('Administrator')).map(r => r.key)
    assert.deepEqual(admins, ['owner', 'admin'])
  })

  test('no crew role carries any permission at all', () => {
    // Crew roles are labels. Their access comes from channel overwrites, which
    // is where it can be seen and changed.
    for (const key of ['translator', 'proofreader', 'timer', 'typesetter', 'karaoke', 'qc', 'encoder']) {
      const role = BLUEPRINT.roles.find(r => r.key === key)
      assert.deepEqual(role?.permissions, [], key)
    }
  })

  test('the moderator cannot restructure the server or hand out roles', () => {
    const moderator = BLUEPRINT.roles.find(r => r.key === 'moderator')!
    for (const forbidden of ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels']) {
      assert.ok(!moderator.permissions.includes(forbidden), `moderator must not have ${forbidden}`)
    }
    assert.ok(moderator.permissions.includes('ModerateMembers'))
  })

  test('every key is unique and every permission name is real', () => {
    const keys = [...BLUEPRINT.roles.map(r => r.key), ...allChannels().map(c => c.channel.key)]
    assert.equal(new Set(keys).size, keys.length, 'duplicate keys')
    for (const role of BLUEPRINT.roles) {
      for (const name of role.permissions) assert.ok(PERMISSIONS[name] !== undefined, `unknown permission ${name}`)
    }
  })

  test('the staff and security categories are not visible to everyone', () => {
    for (const key of ['staff', 'security', 'system', 'analytics']) {
      const category = BLUEPRINT.categories.find(c => c.key === key)
      assert.ok(category?.visibleTo?.length, `${key} must be restricted`)
    }
  })
})

describe('channel overwrites', () => {
  const roleIds = new Map([['owner', 'r-owner'], ['bot', 'r-bot']])

  test('a restricted channel hides itself from @everyone and opens for the listed roles', () => {
    const overwrites = overwritesFor(
      { key: 'x', name: 'x', kind: 'text', visibleTo: ['owner'] }, undefined, roleIds, 'everyone')
    const everyone = overwrites.find(o => o.id === 'everyone')!
    assert.ok(has(everyone.deny!, ['ViewChannel']))
    const owner = overwrites.find(o => o.id === 'r-owner')!
    assert.ok(has(owner.allow!, ['ViewChannel']))
  })

  test('an announcement channel stays readable but not postable', () => {
    // The distinction the two fields exist for: deny SendMessages, not
    // ViewChannel, or nobody can read the announcements.
    const overwrites = overwritesFor(
      { key: 'a', name: 'announcements', kind: 'text', postableBy: ['owner'] }, undefined, roleIds, 'everyone')
    const everyone = overwrites.find(o => o.id === 'everyone')!
    assert.ok(has(everyone.deny!, ['SendMessages']))
    assert.ok(!has(BigInt(everyone.deny!), ['ViewChannel']), 'everyone must still be able to read it')
  })

  test('a role that both sees and posts gets one merged overwrite', () => {
    const overwrites = overwritesFor(
      { key: 'm', name: 'mod-log', kind: 'text', visibleTo: ['owner'], postableBy: ['owner'] }, undefined, roleIds, 'everyone')
    const owner = overwrites.filter(o => o.id === 'r-owner')
    assert.equal(owner.length, 1, 'two overwrites for one role would fight')
    assert.ok(has(owner[0]!.allow!, ['ViewChannel', 'SendMessages']))
  })
})

describe('provisioning', () => {
  test('a dry run writes nothing and still reports the full plan', async () => {
    const { rest, writes } = fakeDiscord()
    const report = await provision({ rest, guildId: 'guild-1', dryRun: true })
    assert.deepEqual(writes, [], 'a plan must not touch the server')
    assert.equal(report.applied.length, 0)
    assert.equal(
      report.planned.length,
      BLUEPRINT.roles.length + BLUEPRINT.categories.length + allChannels().length,
      'the plan must cover every role, category and channel'
    )
  })

  test('a first run creates the whole server', async () => {
    const { rest, writes, state } = fakeDiscord()
    const report = await provision({ rest, guildId: 'guild-1' })
    assert.equal(report.failed.length, 0, JSON.stringify(report.failed))
    assert.equal(state.roles.length, BLUEPRINT.roles.length + 1, 'every role, plus @everyone')
    assert.equal(
      state.channels.filter(c => c.type === CHANNEL_TYPES.category).length,
      BLUEPRINT.categories.length
    )
    assert.ok(writes.some(w => w.startsWith('webhook:')), 'the declared webhooks are created')
    assert.ok(report.ready)
  })

  test('the second run writes nothing at all', async () => {
    // The whole reason this module exists. Anything else and re-running the
    // setup command doubles the server.
    const discord = fakeDiscord()
    await provision({ rest: discord.rest, guildId: 'guild-1' })
    const afterFirst = discord.writes.length
    assert.ok(afterFirst > 0)

    discord.writes.length = 0
    const second = await provision({ rest: discord.rest, guildId: 'guild-1' })
    assert.deepEqual(discord.writes, [], 'a completed server must be left alone')
    assert.equal(second.applied.length, 0)
    assert.ok(second.skipped > 0)
  })

  test('a role somebody widened by hand is corrected, not duplicated', async () => {
    const discord = fakeDiscord()
    await provision({ rest: discord.rest, guildId: 'guild-1' })
    const moderator = discord.state.roles.find(r => r.name === '🧑‍💻 Moderator')!
    moderator.permissions = toBits(['Administrator'])   // somebody was helpful

    discord.writes.length = 0
    await provision({ rest: discord.rest, guildId: 'guild-1' })
    assert.equal(discord.writes.filter(w => w.startsWith('role:')).length, 0, 'no new role')
    assert.ok(discord.writes.some(w => w.startsWith('role-update:')), 'the drift must be corrected')
  })

  test('a bot invited without the right permissions is told before anything is written', async () => {
    const { rest } = fakeDiscord({ botPermissions: ['SendMessages'] })
    const report = await provision({ rest, guildId: 'guild-1', dryRun: true })
    assert.ok(report.warnings.some(w => w.includes('ManageRoles')), report.warnings.join('; '))
  })

  test('every applied action is offered to the audit hook', async () => {
    const seen: string[] = []
    const { rest } = fakeDiscord()
    await provision({ rest, guildId: 'guild-1', onAction: action => { seen.push(action.kind) } })
    assert.ok(seen.includes('role.create'))
    assert.ok(seen.includes('channel.create'))
    assert.ok(seen.includes('webhook.create'))
  })
})

describe('the invite link', () => {
  test('asks for what the provisioner needs and not Administrator', () => {
    const url = new URL(inviteUrl('123'))
    const permissions = BigInt(url.searchParams.get('permissions') ?? '0')
    assert.ok(has(permissions & ~PERMISSIONS.Administrator!, ['ManageRoles', 'ManageChannels', 'ManageWebhooks']))
    assert.equal(permissions & PERMISSIONS.Administrator!, 0n, 'the invite must not ask for Administrator')
    assert.equal(url.searchParams.get('scope'), 'bot applications.commands')
  })
})
