// What happens when somebody joins.
//
// Three things, and each is off unless it is configured — a bot that starts
// pinging strangers the moment it is installed is not a good first impression:
//
//   1. a message in #welcome, mentioning them
//   2. the 🌸 Member role, if WELCOME_ROLE is on
//   3. nothing else
//
// ---------------------------------------------------------------------------
// What is deliberately not sent
// ---------------------------------------------------------------------------
// No DM. Unsolicited DMs from a bot are indistinguishable from the scams
// Discord users are trained to ignore, and a server that DMs on join gets
// reported for it.
//
// No account information. The brief says "account information" in the welcome,
// and the answer is no: at join time the bot knows a Discord id and nothing
// else. It has no linked Yume account to describe, and inventing a personal
// section that says "not linked" for everybody is noise. Linking is a command
// the person runs when they want it.
//
// Bots that join are ignored entirely. Welcoming a webhook integration into
// the community is a small thing that makes a server look unattended.

import { BLUEPRINT } from './blueprint.ts'
import { config } from './config.ts'
import type { Rest, Role } from './discord/rest.ts'
import type { GatewayMember } from './gateway.ts'
import { channelMap } from './sync.ts'

const BRAND = 0xE91E63

/** The join message. A greeting and two links — not a wall of rules. */
export function welcomeMessage (userId: string, channels: { rules?: string | undefined, faq?: string | undefined, general?: string | undefined }): Record<string, unknown> {
  const mention = (id?: string): string => id ? `<#${id}>` : ''
  const lines = [
    `Welcome, <@${userId}> 🌸`,
    '',
    channels.rules ? `Read ${mention(channels.rules)} first — it is short.` : null,
    channels.general ? `Then say hello in ${mention(channels.general)}.` : null,
    channels.faq ? `${mention(channels.faq)} answers most things.` : null
  ].filter(Boolean)

  return {
    // The mention is in `content` rather than the embed because Discord only
    // pings from content. An embed-only mention is silent, which is the
    // opposite of what a welcome is for.
    content: lines.join('\n'),
    embeds: [{
      title: 'Yume',
      url: config.siteUrl,
      color: BRAND,
      description: 'Anime streaming, a catalogue, and a player that works with the extensions you choose.',
      fields: [{ name: 'Verification', value: 'Nothing to verify — post when you are ready. The bot answers `/help`.' }]
    }],
    // Only this user is pinged. Without this, a name containing `@everyone`
    // would be enough to make the bot mention the whole server.
    allowed_mentions: { parse: [], users: [userId] }
  }
}

/**
 * Handle one join.
 *
 * Every failure is logged and swallowed: a member joining must not depend on
 * Discord accepting our message, and half a welcome is better than an
 * exception in a socket handler.
 */
export async function onMemberJoin (rest: Rest, member: GatewayMember): Promise<void> {
  if (member.bot) return
  if (config.guildId && member.guildId !== config.guildId) return

  const channels = await channelMap(rest, member.guildId).catch(() => new Map<string, string>())
  const welcomeChannel = channels.get('welcome')

  if (welcomeChannel) {
    await rest.post(`/channels/${welcomeChannel}/messages`, welcomeMessage(member.userId, {
      rules: channels.get('rules'),
      faq: channels.get('faq'),
      general: channels.get('general')
    })).catch(err => console.warn(`[yume-bot] welcome message failed: ${(err as Error).message}`))
  } else {
    console.warn('[yume-bot] no #welcome channel — run provisioning first')
  }

  if (process.env.WELCOME_ROLE === 'true') {
    const spec = BLUEPRINT.roles.find(r => r.key === 'member')
    const roles = await rest.get<Role[]>(`/guilds/${member.guildId}/roles`).catch(() => [])
    const role = roles.find(r => r.name === spec?.name)
    if (role) {
      await rest.put(`/guilds/${member.guildId}/members/${member.userId}/roles/${role.id}`)
        .catch(err => console.warn(`[yume-bot] member role failed: ${(err as Error).message}`))
    } else {
      console.warn('[yume-bot] WELCOME_ROLE is on but the Member role does not exist — run provisioning first')
    }
  }
}
