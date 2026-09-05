// Apply the blueprint to a Discord guild, as many times as you like.
//
// ---------------------------------------------------------------------------
// Idempotent means something specific here
// ---------------------------------------------------------------------------
// Not "safe to run twice" as an aspiration — *nothing is created that already
// exists, by name, in its scope*. Roles are matched by name in the guild;
// categories by name among the guild's categories; channels by name within
// their category. A second run of a finished server performs zero writes and
// says so.
//
// The consequence, stated because it is the sharp edge: renaming an entry in
// the blueprint creates a new object and leaves the old one behind. The
// provisioner never deletes anything — a run that removed channels because
// somebody edited a file would be a catastrophe waiting for its first typo.
// Removal is a human decision, made in Discord.
//
// ---------------------------------------------------------------------------
// Plan, then apply
// ---------------------------------------------------------------------------
// Every run computes the full list of actions first and can stop there
// (`dryRun`). That is what makes this reviewable before it touches a live
// server, and it is how the admin panel shows what "Sync" would do.

import { BLUEPRINT, allChannels, type Blueprint, type ChannelSpec } from './blueprint.ts'
import { CHANNEL_TYPES, type Channel, type Guild, type Role, type Rest, type Webhook } from './discord/rest.ts'
import { BOT_REQUIRED, has, toBits } from './discord/permissions.ts'

export type ActionKind =
  | 'role.create' | 'role.update'
  | 'category.create'
  | 'channel.create' | 'channel.update'
  | 'webhook.create'

export interface PlannedAction {
  kind: ActionKind
  key: string
  name: string
  /** Why this action is in the plan — shown in the report and the audit log. */
  reason: string
}

export interface ProvisionReport {
  guild: { id: string, name: string }
  dryRun: boolean
  planned: PlannedAction[]
  applied: PlannedAction[]
  skipped: number
  failed: Array<{ action: PlannedAction, error: string }>
  webhooks: Record<string, string>
  warnings: string[]
  ready: boolean
}

const byName = <T extends { name: string }>(items: T[], name: string): T | undefined =>
  items.find(item => item.name === name)

/**
 * Build the permission overwrites for one channel.
 *
 * Two independent questions, and conflating them is the usual bug:
 *   - who can *see* it     → ViewChannel
 *   - who can *post* in it → SendMessages
 *
 * A channel with `visibleTo` denies ViewChannel to @everyone and grants it back
 * to the listed roles. A channel with `postableBy` denies SendMessages to
 * @everyone and grants it back — everyone can still read it, which is what an
 * announcement channel is.
 */
export function overwritesFor (spec: ChannelSpec, categoryVisibleTo: string[] | undefined, roleIds: Map<string, string>, everyoneId: string): Array<Record<string, string>> {
  const overwrites: Array<Record<string, string>> = []
  const visibleTo = spec.visibleTo ?? categoryVisibleTo

  const denyEveryone: string[] = []
  if (visibleTo?.length) denyEveryone.push('ViewChannel')
  if (spec.postableBy?.length) denyEveryone.push('SendMessages')
  if (denyEveryone.length) {
    overwrites.push({ id: everyoneId, type: '0', allow: '0', deny: toBits(denyEveryone) })
  }

  // One overwrite per role, merging the two grants so a role that both sees
  // and posts gets a single entry rather than two that overwrite each other.
  const grants = new Map<string, string[]>()
  for (const key of visibleTo ?? []) grants.set(key, [...(grants.get(key) ?? []), 'ViewChannel', 'ReadMessageHistory'])
  for (const key of spec.postableBy ?? []) grants.set(key, [...(grants.get(key) ?? []), 'SendMessages', 'ViewChannel'])

  for (const [key, permissions] of grants) {
    const id = roleIds.get(key)
    if (!id) continue        // a role that failed to create is reported elsewhere
    overwrites.push({ id, type: '0', allow: toBits([...new Set(permissions)]), deny: '0' })
  }
  return overwrites
}

export interface ProvisionOptions {
  rest: Rest
  guildId: string
  blueprint?: Blueprint
  dryRun?: boolean
  /** Called for every applied action, for the audit trail. */
  onAction?: (action: PlannedAction, outcome: 'applied' | 'failed', detail?: string) => void | Promise<void>
}

export async function provision (options: ProvisionOptions): Promise<ProvisionReport> {
  const { rest, guildId, dryRun = false } = options
  const blueprint = options.blueprint ?? BLUEPRINT

  const guild = await rest.get<Guild>(`/guilds/${guildId}`)
  const report: ProvisionReport = {
    guild: { id: guild.id, name: guild.name },
    dryRun,
    planned: [],
    applied: [],
    skipped: 0,
    failed: [],
    webhooks: {},
    warnings: [],
    ready: false
  }

  const record = async (action: PlannedAction, run: () => Promise<void>): Promise<void> => {
    report.planned.push(action)
    if (dryRun) return
    try {
      await run()
      report.applied.push(action)
      await options.onAction?.(action, 'applied')
    } catch (err) {
      const message = (err as Error).message
      report.failed.push({ action, error: message })
      await options.onAction?.(action, 'failed', message)
    }
  }

  // ---- can we even do this? ------------------------------------------------
  // Checked before any write, so a half-provisioned server is not the way an
  // operator finds out the invite was missing a permission.
  const me = await rest.get<{ roles: string[] }>(`/guilds/${guildId}/members/@me`).catch(() => null)
  const existingRoles = await rest.get<Role[]>(`/guilds/${guildId}/roles`)
  if (me) {
    const mine = existingRoles.filter(r => me.roles.includes(r.id))
    const bits = mine.reduce((acc, r) => acc | BigInt(r.permissions || '0'), 0n)
    const missing = BOT_REQUIRED.filter(p => !has(bits, [p]))
    if (missing.length) {
      report.warnings.push(`the bot is missing Discord permissions: ${missing.join(', ')} — re-invite it with the link from \`yume-discord invite\``)
    }
  }

  // ---- roles ---------------------------------------------------------------
  const everyone = existingRoles.find(r => r.name === '@everyone')
  const everyoneId = everyone?.id ?? guildId    // @everyone's id is the guild id
  const roleIds = new Map<string, string>()

  for (const spec of blueprint.roles) {
    const found = byName(existingRoles, spec.name)
    if (found) {
      roleIds.set(spec.key, found.id)
      // A role that exists but has drifted — somebody widened it by hand, or
      // the blueprint changed — is corrected, not duplicated.
      const wanted = toBits(spec.permissions)
      if (found.permissions !== wanted && !found.managed) {
        await record({ kind: 'role.update', key: spec.key, name: spec.name, reason: 'permissions differ from the blueprint' }, async () => {
          await rest.patch(`/guilds/${guildId}/roles/${found.id}`, { permissions: wanted })
        })
      } else {
        report.skipped++
      }
      continue
    }

    await record({ kind: 'role.create', key: spec.key, name: spec.name, reason: 'no role with this name' }, async () => {
      const created = await rest.post<Role>(`/guilds/${guildId}/roles`, {
        name: spec.name,
        permissions: toBits(spec.permissions),
        color: spec.color ?? 0,
        hoist: spec.hoist ?? false,
        mentionable: spec.mentionable ?? false
      })
      roleIds.set(spec.key, created.id)
    })
    // In a dry run nothing was created, so later steps have no id to reference;
    // a placeholder keeps the plan complete instead of silently short.
    if (dryRun) roleIds.set(spec.key, `(new:${spec.key})`)
  }

  // ---- categories and channels --------------------------------------------
  const existingChannels = await rest.get<Channel[]>(`/guilds/${guildId}/channels`)
  const categoryIds = new Map<string, string>()

  for (const category of blueprint.categories) {
    const found = existingChannels.find(c => c.type === CHANNEL_TYPES.category && c.name === category.name)
    if (found) {
      categoryIds.set(category.key, found.id)
      report.skipped++
    } else {
      await record({ kind: 'category.create', key: category.key, name: category.name, reason: 'no category with this name' }, async () => {
        const created = await rest.post<Channel>(`/guilds/${guildId}/channels`, {
          name: category.name,
          type: CHANNEL_TYPES.category,
          permission_overwrites: category.visibleTo?.length
            ? overwritesFor({ key: category.key, name: category.name, kind: 'text', visibleTo: category.visibleTo }, undefined, roleIds, everyoneId)
            : []
        })
        categoryIds.set(category.key, created.id)
      })
      if (dryRun) categoryIds.set(category.key, `(new:${category.key})`)
    }
  }

  const webhookChannels: Array<{ kind: string, channelId: string, channelName: string }> = []

  for (const { category, channel } of allChannels(blueprint)) {
    const parentId = categoryIds.get(category.key)
    // A channel is matched inside its own category: two categories may each
    // hold a #general, and they are different channels.
    const found = existingChannels.find(c =>
      c.name === channel.name && c.type !== CHANNEL_TYPES.category &&
      (parentId?.startsWith('(new:') ? true : c.parent_id === parentId))

    if (found) {
      report.skipped++
      if (channel.webhook) webhookChannels.push({ kind: channel.webhook, channelId: found.id, channelName: channel.name })
      continue
    }

    await record({ kind: 'channel.create', key: channel.key, name: channel.name, reason: `not present in ${category.name}` }, async () => {
      const created = await rest.post<Channel>(`/guilds/${guildId}/channels`, {
        name: channel.name,
        type: CHANNEL_TYPES[channel.kind],
        parent_id: parentId,
        ...(channel.topic ? { topic: channel.topic } : {}),
        ...(channel.nsfw ? { nsfw: true } : {}),
        ...(channel.slowmodeSeconds ? { rate_limit_per_user: channel.slowmodeSeconds } : {}),
        permission_overwrites: overwritesFor(channel, category.visibleTo, roleIds, everyoneId)
      })
      if (channel.webhook) webhookChannels.push({ kind: channel.webhook, channelId: created.id, channelName: channel.name })
    })
  }

  // ---- webhooks ------------------------------------------------------------
  // Created last, because they need their channel to exist. The URL is
  // returned to the caller once and never stored: it is a credential, and
  // `docs/discord-telepites.md` says to put it in the environment.
  for (const target of webhookChannels) {
    const name = `Yume ${target.kind}`
    const existing = await rest.get<Webhook[]>(`/channels/${target.channelId}/webhooks`).catch(() => [])
    const found = byName(existing, name)
    if (found) {
      report.skipped++
      // An existing webhook's token is not returned by the list endpoint, so
      // the URL cannot be reconstructed. Saying so beats printing a broken one.
      report.warnings.push(`webhook "${name}" already exists in #${target.channelName}; its URL is only shown at creation — delete it in Discord and re-run to get a fresh one`)
      continue
    }
    await record({ kind: 'webhook.create', key: target.kind, name, reason: `no webhook named ${name} in #${target.channelName}` }, async () => {
      const created = await rest.post<Webhook>(`/channels/${target.channelId}/webhooks`, { name })
      if (created.url) report.webhooks[target.kind] = created.url
      else if (created.token) report.webhooks[target.kind] = `https://discord.com/api/webhooks/${created.id}/${created.token}`
    })
  }

  report.ready = report.failed.length === 0
  return report
}

/** The invite URL that asks for exactly the permissions the provisioner needs. */
export function inviteUrl (applicationId: string): string {
  const params = new URLSearchParams({
    client_id: applicationId,
    scope: 'bot applications.commands',
    permissions: toBits(BOT_REQUIRED)
  })
  return `https://discord.com/oauth2/authorize?${params.toString()}`
}
