// Discord permission flags, as names.
//
// The blueprint states permissions as names because a bitfield in a config
// file is unreviewable — nobody catches a wrong bit in `1099511627775` during
// review, and that particular number is "every permission including
// Administrator".
//
// Values are from Discord's documented permission flags. They are a bitfield
// wider than 32 bits, so they are BigInt here and strings on the wire, which
// is what the API expects.

export const PERMISSIONS: Record<string, bigint> = {
  CreateInstantInvite: 1n << 0n,
  KickMembers: 1n << 1n,
  BanMembers: 1n << 2n,
  Administrator: 1n << 3n,
  ManageChannels: 1n << 4n,
  ManageGuild: 1n << 5n,
  AddReactions: 1n << 6n,
  ViewAuditLog: 1n << 7n,
  PrioritySpeaker: 1n << 8n,
  Stream: 1n << 9n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  SendTTSMessages: 1n << 12n,
  ManageMessages: 1n << 13n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  MentionEveryone: 1n << 17n,
  UseExternalEmojis: 1n << 18n,
  ViewGuildInsights: 1n << 19n,
  Connect: 1n << 20n,
  Speak: 1n << 21n,
  MuteMembers: 1n << 22n,
  DeafenMembers: 1n << 23n,
  MoveMembers: 1n << 24n,
  UseVAD: 1n << 25n,
  ChangeNickname: 1n << 26n,
  ManageNicknames: 1n << 27n,
  ManageRoles: 1n << 28n,
  ManageWebhooks: 1n << 29n,
  ManageGuildExpressions: 1n << 30n,
  UseApplicationCommands: 1n << 31n,
  RequestToSpeak: 1n << 32n,
  ManageEvents: 1n << 33n,
  ManageThreads: 1n << 34n,
  CreatePublicThreads: 1n << 35n,
  CreatePrivateThreads: 1n << 36n,
  UseExternalStickers: 1n << 37n,
  SendMessagesInThreads: 1n << 38n,
  UseEmbeddedActivities: 1n << 39n,
  ModerateMembers: 1n << 40n
}

/** Names → the bitfield string Discord expects. Unknown names are a mistake, not a default. */
export function toBits (names: readonly string[]): string {
  let bits = 0n
  for (const name of names) {
    const flag = PERMISSIONS[name]
    if (flag === undefined) throw new Error(`unknown Discord permission: ${name}`)
    bits |= flag
  }
  return bits.toString()
}

/** Does this bitfield include every one of these permissions? */
export function has (bits: string | bigint, names: readonly string[]): boolean {
  const value = typeof bits === 'bigint' ? bits : BigInt(bits || '0')
  // Administrator implies everything, which is how Discord evaluates it too.
  if ((value & PERMISSIONS.Administrator!) !== 0n) return true
  return names.every(name => (value & (PERMISSIONS[name] ?? 0n)) !== 0n)
}

/**
 * What the bot itself needs to provision a server.
 *
 * Deliberately short of Administrator. The invite link built from this asks
 * for exactly these, so an operator granting it can see what they are agreeing
 * to — `ManageRoles`, `ManageChannels` and `ManageWebhooks` are the three that
 * do the work, and the rest is what the bot needs to speak afterwards.
 */
export const BOT_REQUIRED = [
  'ManageRoles', 'ManageChannels', 'ManageWebhooks',
  'ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory',
  'ModerateMembers', 'KickMembers', 'BanMembers', 'ManageMessages', 'ViewAuditLog'
] as const
