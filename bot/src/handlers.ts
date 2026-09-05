// One function per command. Each returns the interaction response object.
//
// Everything personal or administrative is ephemeral: a staff command whose
// output lands in a public channel is an information leak with a friendly
// face, and `/search` results in #general are fine while somebody's watch
// history is not.

import { config } from './config.ts'
import { BLUEPRINT, allChannels } from './blueprint.ts'
import { inviteUrl, provision } from './provision.ts'
import { Rest } from './discord/rest.ts'
import { yume } from './yume.ts'
import { EPHEMERAL, ResponseType, actorOf, optionValue, reply, replyEmbed, subCommand, type Interaction } from './interactions.ts'

const BRAND = 0xE91E63
const started = Date.now()

const duration = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ')
}

/** A moderation action's audit line, sent to the API so it lands in audit_logs. */
async function audit (action: string, actor: string, subject: string, detail: Record<string, unknown>): Promise<void> {
  if (!config.serviceToken) return
  await fetch(`${config.apiUrl}/v1/integrations/discord/audit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Token': config.serviceToken },
    body: JSON.stringify({ action, actor, subject, detail }),
    signal: AbortSignal.timeout(5000)
  }).catch(() => {})   // an unaudited action still happened; losing the log must not undo it
}

export type Handler = (interaction: Interaction, rest: Rest) => Promise<unknown>

export const handlers: Record<string, Handler> = {
  async help () {
    return replyEmbed({
      title: 'Yume',
      color: BRAND,
      description: 'Catalogue and status commands. Server management needs Manage Server.',
      fields: [
        { name: 'Catalogue', value: '`/search` `/anime` `/schedule` `/releases` `/watch`', inline: false },
        { name: 'Status', value: '`/status` `/uptime` `/website`', inline: false },
        { name: 'Server', value: '`/yume setup` `/yume verify` `/yume health`', inline: false },
        { name: 'Moderation', value: '`/warn` `/timeout` `/kick` `/ban` `/purge` `/slowmode`', inline: false }
      ]
    })
  },

  async website () {
    return reply(config.siteUrl)
  },

  async uptime () {
    const health = await yume.health()
    return replyEmbed({
      title: 'Uptime',
      color: BRAND,
      fields: [
        { name: 'Bot', value: duration(Date.now() - started), inline: true },
        { name: 'API', value: health.ok ? '🟢 reachable' : '🔴 unreachable', inline: true }
      ]
    })
  },

  async status () {
    const [health, ready] = await Promise.all([yume.health(), yume.ready()])
    const services = ready && typeof ready === 'object' ? ready : {}
    const lines = Object.entries(services)
      .filter(([, value]) => typeof value === 'string' || typeof value === 'boolean')
      .map(([name, value]) => `${value === true || value === 'ok' || value === 'up' ? '🟢' : '🔴'} ${name}`)
    return replyEmbed({
      title: 'Yume status',
      color: health.ok ? 0x2ECC71 : 0xE74C3C,
      description: health.ok ? (lines.join('\n') || '🟢 API reachable') : '🔴 The API is not reachable from the bot.',
      url: config.siteUrl
    })
  },

  async search (interaction) {
    const query = optionValue(interaction, 'query') ?? ''
    const results = await yume.search(query)
    if (!results.length) return reply(`Nothing found for **${query}**.`, true)
    return replyEmbed({
      title: `Results for “${query}”`,
      color: BRAND,
      description: results.map(r => `**[${r.canonical_title}](${yume.link(r)})** — ${r.format ?? '?'}${r.season_year ? ` · ${r.season_year}` : ''}${r.average_score ? ` · ★ ${r.average_score}` : ''}`).join('\n')
    })
  },

  async anime (interaction) {
    const query = optionValue(interaction, 'query') ?? ''
    const [first] = await yume.search(query, 1)
    if (!first) return reply(`Nothing found for **${query}**.`, true)
    return replyEmbed({
      title: first.canonical_title,
      url: yume.link(first),
      color: BRAND,
      ...(first.cover_key?.startsWith('http') ? { thumbnail: { url: first.cover_key } } : {}),
      fields: [
        { name: 'Format', value: String(first.format ?? '—'), inline: true },
        { name: 'Episodes', value: String(first.episode_count ?? '—'), inline: true },
        { name: 'Score', value: first.average_score ? `★ ${first.average_score}` : '—', inline: true }
      ]
    })
  },

  async schedule () {
    const rows = await yume.schedule()
    if (!rows.length) return reply('Nothing scheduled in the next seven days.', true)
    return replyEmbed({
      title: 'Airing this week',
      color: BRAND,
      description: rows.slice(0, 15)
        .map(r => `**${r.canonical_title}** — ep ${r.number} · <t:${Math.floor(new Date(r.air_date).getTime() / 1000)}:R>`)
        .join('\n')
    })
  },

  async releases () {
    const rows = await yume.recent()
    if (!rows.length) return reply('No releases to show.', true)
    return replyEmbed({
      title: 'Latest',
      color: BRAND,
      description: rows.map(r => `**[${r.canonical_title}](${yume.link(r)})**`).join('\n')
    })
  },

  async watch (interaction) {
    const query = optionValue(interaction, 'query') ?? ''
    const episode = Number(optionValue(interaction, 'episode') ?? 1)
    const [first] = await yume.search(query, 1)
    if (!first) return reply(`Nothing found for **${query}**.`, true)
    return {
      type: ResponseType.ChannelMessage,
      data: {
        embeds: [{ title: first.canonical_title, description: `Episode ${episode}`, color: BRAND }],
        components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Watch on Yume', url: yume.link(first, episode) }] }]
      }
    }
  },

  // ---- server management ---------------------------------------------------

  async yume (interaction, rest) {
    const sub = subCommand(interaction)
    const guildId = interaction.guild_id
    if (!guildId) return reply('This command only works inside a server.', true)

    if (sub === 'health') {
      const [health, ready] = await Promise.all([yume.health(), yume.ready()])
      const flag = (ok: boolean): string => ok ? '🟢' : '🔴'
      const services = (ready ?? {}) as Record<string, unknown>
      return replyEmbed({
        title: 'YUME SYSTEM STATUS',
        color: health.ok ? 0x2ECC71 : 0xE74C3C,
        description: [
          `Website   ${flag(health.ok)}`,
          `API       ${flag(health.ok)}`,
          `Database  ${flag(services.database === 'ok' || services.db === 'ok' || health.ok)}`,
          `Discord   🟢`
        ].join('\n'),
        footer: { text: 'Detailed metrics live in the admin panel.' }
      }, true)
    }

    // setup and verify share the provisioner; only `apply` writes.
    const apply = sub === 'setup' && optionValue(interaction, 'mode') === 'apply'
    const actor = actorOf(interaction)
    const report = await provision({
      rest,
      guildId,
      dryRun: !apply,
      onAction: async (action, outcome, detail) => {
        await audit(`discord.${action.kind}`, actor?.id ?? 'unknown', `${action.name}`, { outcome, reason: action.reason, ...(detail ? { detail } : {}) })
      }
    })

    const tick = (n: number): string => n === 0 ? '✓' : `${n} to create`
    const counts = (kind: string): number => report.planned.filter(a => a.kind.startsWith(kind)).length
    const lines = [
      `Roles .............. ${tick(counts('role'))}`,
      `Categories ......... ${tick(counts('category'))}`,
      `Channels ........... ${tick(counts('channel'))}`,
      `Webhooks ........... ${tick(counts('webhook'))}`,
      `Unchanged .......... ${report.skipped}`
    ]
    if (report.failed.length) lines.push(`Failed ............. ${report.failed.length}`)

    return replyEmbed({
      title: apply ? 'YUME DISCORD SETUP' : 'YUME DISCORD SETUP — plan only',
      color: report.ready ? 0x2ECC71 : 0xE67E22,
      description: '```\n' + lines.join('\n') + '\n```',
      fields: [
        ...(report.warnings.length ? [{ name: 'Warnings', value: report.warnings.slice(0, 3).join('\n').slice(0, 1000) }] : []),
        ...(Object.keys(report.webhooks).length
          // Webhook URLs are credentials. They are not printed into a channel,
          // even a staff one — the CLI prints them once, on the server.
          ? [{ name: 'Webhooks', value: `${Object.keys(report.webhooks).length} created. Their URLs were printed by the server console; put them in .env.` }]
          : []),
        ...(!apply ? [{ name: 'Nothing was changed', value: 'Run `/yume setup mode:apply` to apply this plan.' }] : [])
      ],
      footer: { text: report.ready ? 'Status: READY' : 'Status: INCOMPLETE' }
    }, true)
  },

  // ---- moderation ----------------------------------------------------------

  async warn (interaction) {
    const target = optionValue(interaction, 'member')
    const reason = optionValue(interaction, 'reason') ?? ''
    await audit('discord.warn', actorOf(interaction)?.id ?? 'unknown', target ?? 'unknown', { reason })
    return reply(`Warned <@${target}>: ${reason}`, true)
  },

  async timeout (interaction, rest) {
    const target = optionValue(interaction, 'member')
    const minutes = Math.min(40320, Math.max(1, Number(optionValue(interaction, 'minutes') ?? 10)))
    const reason = optionValue(interaction, 'reason') ?? ''
    const until = new Date(Date.now() + minutes * 60_000).toISOString()
    await rest.patch(`/guilds/${interaction.guild_id}/members/${target}`, { communication_disabled_until: until })
    await audit('discord.timeout', actorOf(interaction)?.id ?? 'unknown', target ?? 'unknown', { minutes, reason })
    return reply(`<@${target}> timed out for ${minutes} minute(s).`, true)
  },

  async kick (interaction, rest) {
    const target = optionValue(interaction, 'member')
    const reason = optionValue(interaction, 'reason') ?? ''
    await rest.delete(`/guilds/${interaction.guild_id}/members/${target}`)
    await audit('discord.kick', actorOf(interaction)?.id ?? 'unknown', target ?? 'unknown', { reason })
    return reply(`<@${target}> kicked.`, true)
  },

  async ban (interaction, rest) {
    const target = optionValue(interaction, 'member')
    const reason = optionValue(interaction, 'reason') ?? ''
    const days = Math.min(7, Math.max(0, Number(optionValue(interaction, 'delete_days') ?? 0)))
    await rest.put(`/guilds/${interaction.guild_id}/bans/${target}`, { delete_message_seconds: days * 86400 })
    await audit('discord.ban', actorOf(interaction)?.id ?? 'unknown', target ?? 'unknown', { reason, deleteDays: days })
    return reply(`<@${target}> banned.`, true)
  },

  async purge (interaction, rest) {
    const count = Math.min(100, Math.max(2, Number(optionValue(interaction, 'count') ?? 10)))
    const messages = await rest.get<Array<{ id: string, timestamp: string }>>(`/channels/${interaction.channel_id}/messages?limit=${count}`)
    // Discord refuses to bulk-delete anything older than two weeks, and the
    // whole call fails if one message is too old — so they are filtered here
    // rather than discovered as a 400.
    const cutoff = Date.now() - 14 * 24 * 3600 * 1000
    const ids = messages.filter(m => new Date(m.timestamp).getTime() > cutoff).map(m => m.id)
    if (ids.length < 2) return reply('Nothing recent enough to bulk-delete (Discord refuses messages older than 14 days).', true)
    await rest.post(`/channels/${interaction.channel_id}/messages/bulk-delete`, { messages: ids })
    await audit('discord.purge', actorOf(interaction)?.id ?? 'unknown', interaction.channel_id ?? '', { deleted: ids.length })
    return reply(`Deleted ${ids.length} message(s).`, true)
  },

  async slowmode (interaction, rest) {
    const seconds = Math.min(21600, Math.max(0, Number(optionValue(interaction, 'seconds') ?? 0)))
    await rest.patch(`/channels/${interaction.channel_id}`, { rate_limit_per_user: seconds })
    await audit('discord.slowmode', actorOf(interaction)?.id ?? 'unknown', interaction.channel_id ?? '', { seconds })
    return reply(seconds ? `Slowmode set to ${seconds}s.` : 'Slowmode off.', true)
  }
}

/** Everything the blueprint would build, for `invite`/docs output. */
export const blueprintSummary = (): string => {
  const channels = allChannels()
  return `${BLUEPRINT.roles.length} roles, ${BLUEPRINT.categories.length} categories, ${channels.length} channels`
}

export { inviteUrl, EPHEMERAL }
