// Slash commands over HTTP interactions.
//
// Discord POSTs each interaction to a URL and verifies nothing else; there is
// no gateway connection involved. That suits this project: the bot has no
// long-lived socket to babysit, it scales to zero between commands, and the
// signature check below is the entire security model — 20 lines of
// `node:crypto` rather than a library.
//
// Ed25519 is verified with Node's own crypto (native since 12), so the usual
// `tweetnacl` dependency is not needed.
//
// What this design cannot do is react to events nobody sent us: a member
// joining, a message being posted. Welcome messages and anti-spam therefore
// need the gateway, and `docs/discord-bot.md` §4 is the plan for that. Nothing
// here forecloses it.

import { verify } from 'node:crypto'

export const InteractionType = { Ping: 1, ApplicationCommand: 2, MessageComponent: 3, Autocomplete: 4, ModalSubmit: 5 } as const
export const ResponseType = { Pong: 1, ChannelMessage: 4, Deferred: 5, DeferredUpdate: 6 } as const
/** Only the user who ran the command sees the reply. */
export const EPHEMERAL = 1 << 6

/**
 * Is this request really from Discord?
 *
 * Discord signs every interaction with the application's Ed25519 key. An
 * unverified endpoint is an open door: anyone who learns the URL could post a
 * fabricated `/admin` interaction. Discord also sends deliberately invalid
 * signatures when you register the endpoint and refuses to accept it unless
 * they are rejected — so getting this wrong fails closed at setup, which is
 * the right way round.
 */
export function verifySignature (publicKey: string, signature: string, timestamp: string, body: string): boolean {
  try {
    const key = Buffer.from(publicKey, 'hex')
    if (key.length !== 32) return false
    // Node needs the key as SPKI DER; the 12-byte prefix is the Ed25519 header.
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key])
    const publicKeyObject = { key: der, format: 'der' as const, type: 'spki' as const }
    return verify(null, Buffer.from(timestamp + body), publicKeyObject, Buffer.from(signature, 'hex'))
  } catch {
    // A malformed header is a failed verification, not a 500.
    return false
  }
}

export interface Interaction {
  type: number
  id: string
  token: string
  guild_id?: string
  channel_id?: string
  member?: { user: { id: string, username: string }, permissions?: string, roles?: string[] }
  user?: { id: string, username: string }
  data?: { name: string, options?: Array<{ name: string, value?: unknown, options?: Array<{ name: string, value?: unknown }> }> }
}

/** The invoking user, whether the command came from a guild or a DM. */
export const actorOf = (interaction: Interaction): { id: string, username: string } | null =>
  interaction.member?.user ?? interaction.user ?? null

/** A named option's value, or undefined. Sub-command options are flattened. */
export function optionValue (interaction: Interaction, name: string): string | undefined {
  const walk = (options: Array<{ name: string, value?: unknown, options?: Array<{ name: string, value?: unknown }> }> = []): unknown => {
    for (const option of options) {
      if (option.name === name && option.value !== undefined) return option.value
      const nested = walk(option.options as never)
      if (nested !== undefined) return nested
    }
    return undefined
  }
  const value = walk(interaction.data?.options)
  return value === undefined ? undefined : String(value)
}

/** The sub-command name for a grouped command (`/admin status` → 'status'). */
export const subCommand = (interaction: Interaction): string | undefined => interaction.data?.options?.[0]?.name

export const reply = (content: string, ephemeral = false): unknown =>
  ({ type: ResponseType.ChannelMessage, data: { content, ...(ephemeral ? { flags: EPHEMERAL } : {}) } })

export const replyEmbed = (embed: unknown, ephemeral = false): unknown =>
  ({ type: ResponseType.ChannelMessage, data: { embeds: [embed], ...(ephemeral ? { flags: EPHEMERAL } : {}) } })
