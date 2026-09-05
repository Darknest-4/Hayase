// What the managed messages say.
//
// Everything here is a pure function of its input, and that is a requirement
// rather than a style: `messages.ts` decides whether to edit by hashing the
// rendered payload, so anything non-deterministic — a clock, a random id, a
// "last updated" line — would make the message rewrite itself on every tick
// forever. The boards therefore carry no timestamp in their body. Discord
// already shows when a message was last edited.
//
// Static pages (welcome, rules, faq) are edited into place when this file
// changes, which means the server's copy is reviewable in a diff like
// everything else.

import { BLUEPRINT } from './blueprint.ts'
import { config } from './config.ts'
import type { MessagePayload } from './messages.ts'

const BRAND = 0xE91E63

/** Channels the static pages belong in, by blueprint key. */
export const STATIC_PAGES = ['welcome', 'rules', 'faq'] as const
export type StaticPage = typeof STATIC_PAGES[number]

export function staticPage (page: StaticPage): MessagePayload {
  const site = config.siteUrl

  if (page === 'welcome') {
    return {
      embeds: [{
        title: '🌸 Welcome to Yume',
        color: BRAND,
        description: [
          'Yume is an anime streaming platform — catalogue, player, watch-together and a subtitle pipeline.',
          '',
          `**Site** — ${site}`,
          '**Start here** — read <#rules>, then say hello in <#general>.',
          '',
          'The bot answers `/help` if you want to know what it can do.'
        ].join('\n'),
        footer: { text: 'This message is maintained by the bot and edited in place.' }
      }],
      components: [{
        type: 1,
        components: [{ type: 2, style: 5, label: 'Open Yume', url: site }]
      }]
    }
  }

  if (page === 'rules') {
    return {
      embeds: [{
        title: '📜 Rules',
        color: BRAND,
        // Numbered rather than bulleted so a moderator can point at "rule 4"
        // and everybody is looking at the same line.
        description: [
          '**1.** Be civil. Disagreement is fine; contempt is not.',
          '**2.** No harassment, hate speech or targeting anyone.',
          '**3.** Spoilers go behind `||spoiler tags||`, always.',
          '**4.** Keep NSFW out. This is not the place for it.',
          '**5.** No advertising or unsolicited DMs to members.',
          '**6.** English or Hungarian in the public channels.',
          '**7.** Bot commands in <#bot-commands>.',
          '**8.** Staff decisions are final here; appeal in DMs, not in channel.',
          '',
          'Breaking these gets a warning first, then a timeout, then a ban. Anything in rule 2 skips straight to the end.'
        ].join('\n')
      }]
    }
  }

  return {
    embeds: [{
      title: '❓ FAQ',
      color: BRAND,
      fields: [
        { name: 'Is Yume free?', value: 'Yes. There is no paywall and no account required to browse.' },
        { name: 'Do I need an account?', value: 'Only to keep a library, progress and preferences across devices.' },
        { name: 'Where do the videos come from?', value: 'Extensions you install yourself. Yume ships none by default — the platform resolves sources, it does not host them.' },
        { name: 'Hungarian subtitles?', value: 'The interface is fully Hungarian, and subtitle availability depends on the extensions you install.' },
        { name: 'Something is broken.', value: 'Post in <#bug-reports> with what you did and what happened.' },
        { name: 'How do I help?', value: 'Translating, timing, typesetting and QC — say so in <#general>.' }
      ],
      footer: { text: `${site} · maintained by the bot` }
    }]
  }
}

// ---------------------------------------------------------------------------
// Live boards
// ---------------------------------------------------------------------------

export interface ServiceState { name: string, status: 'healthy' | 'degraded' | 'down' | 'unknown' }

const ICON: Record<ServiceState['status'], string> = {
  healthy: '🟢', degraded: '🟡', down: '🔴', unknown: '⚪'
}

/**
 * The system status board.
 *
 * One message in #server-status, edited as things change. Deliberately without
 * a "checked at" line: that would change the hash every tick and rewrite the
 * message even when every service is exactly as it was.
 */
export function statusBoard (services: ServiceState[]): MessagePayload {
  const worst = services.some(s => s.status === 'down')
    ? 0xED4245
    : services.some(s => s.status === 'degraded') ? 0xFEE75C : 0x57F287

  const width = Math.max(8, ...services.map(s => s.name.length))
  return {
    embeds: [{
      title: 'YUME SYSTEM STATUS',
      color: worst,
      description: '```\n' + services.map(s => `${s.name.padEnd(width)}  ${ICON[s.status]} ${s.status}`).join('\n') + '\n```',
      footer: { text: 'Edited in place · Discord shows the last update time' }
    }]
  }
}

/** A release, as a message that can be edited when the release changes. */
export function releaseEmbed (release: {
  title: string
  episode: number | string
  season?: string | null
  quality?: string | null
  subtitles?: string | null
  status?: string | null
  url: string
  coverUrl?: string | null
}): MessagePayload {
  return {
    embeds: [{
      title: '🎬 NEW RELEASE',
      description: `**[${release.title}](${release.url})**`,
      color: BRAND,
      ...(release.coverUrl?.startsWith('http') ? { thumbnail: { url: release.coverUrl } } : {}),
      fields: [
        { name: 'Episode', value: String(release.episode), inline: true },
        ...(release.season ? [{ name: 'Season', value: release.season, inline: true }] : []),
        ...(release.quality ? [{ name: 'Quality', value: release.quality, inline: true }] : []),
        ...(release.subtitles ? [{ name: 'Subtitle', value: release.subtitles, inline: true }] : []),
        ...(release.status ? [{ name: 'Release status', value: release.status, inline: true }] : [])
      ]
    }],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Watch Now', url: release.url }] }]
  }
}

/** Video provider board: one message listing every provider's current state. */
export function videoBoard (providers: Array<{ name: string, status: 'healthy' | 'degraded' | 'down' | 'unknown', qualities?: string[], failures?: number }>): MessagePayload {
  if (!providers.length) {
    return { embeds: [{ title: '🎥 VIDEO PROVIDERS', color: 0x5865F2, description: 'No providers reporting yet.' }] }
  }
  return {
    embeds: [{
      title: '🎥 VIDEO PROVIDERS',
      color: providers.some(p => p.status === 'down') ? 0xED4245 : 0x57F287,
      fields: providers.slice(0, 25).map(p => ({
        name: `${ICON[p.status]} ${p.name}`,
        value: [
          `Status: ${p.status}`,
          p.qualities?.length ? `Quality: ${p.qualities.join(', ')}` : null,
          p.failures ? `Failures: ${p.failures}` : null
        ].filter(Boolean).join('\n'),
        inline: true
      }))
    }]
  }
}

/** The blueprint, as a message — what the provisioner believes the server is. */
export function blueprintBoard (): MessagePayload {
  return {
    embeds: [{
      title: '🗺️ SERVER BLUEPRINT',
      color: 0x5865F2,
      description: BLUEPRINT.categories
        .map(c => `**${c.name}** — ${c.channels.map(ch => ch.name).join(', ')}`)
        .join('\n')
        .slice(0, 4000),
      footer: { text: `${BLUEPRINT.roles.length} roles · maintained by the bot` }
    }]
  }
}
