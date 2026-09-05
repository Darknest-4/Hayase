// The Yume Discord server, as data.
//
// Everything the provisioner creates is described here and nowhere else. That
// is the whole point: the server's shape is reviewable in a diff, and applying
// it is a mechanical operation rather than a script somebody has to read to
// find out what it does.
//
// ---------------------------------------------------------------------------
// The two rules that make it re-runnable
// ---------------------------------------------------------------------------
//  1. Every object has a stable `key`. Matching is by key, never by position.
//  2. Discord objects are matched by *name* within their scope, because that
//     is the only identity Discord exposes for a role or channel that we did
//     not create. Renaming an entry here therefore creates a new object and
//     orphans the old one — which is why names are treated as identifiers and
//     changed deliberately.
//
// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------
// Stated as names, resolved to the bitfield in `permissions.ts`. Nothing here
// grants Administrator except the roles that are the server's owners: a
// moderator who can delete a message does not need to be able to delete the
// server, and giving them the bit "so it works" is how a compromised staff
// account becomes a lost server.

export type ChannelKind = 'text' | 'voice' | 'forum' | 'announcement'

export interface RoleSpec {
  key: string
  name: string
  color?: number
  hoist?: boolean
  mentionable?: boolean
  /** Permission names; see permissions.ts. Empty means "@everyone and nothing more". */
  permissions: string[]
}

export interface ChannelSpec {
  key: string
  name: string
  kind: ChannelKind
  topic?: string
  nsfw?: boolean
  slowmodeSeconds?: number
  /** Roles that may see it. Empty/absent = visible to everyone. */
  visibleTo?: string[]
  /** Roles that may post. Absent = anyone who can see it. */
  postableBy?: string[]
  /** A webhook is created here and its URL handed to the operator. */
  webhook?: string
}

export interface CategorySpec {
  key: string
  name: string
  visibleTo?: string[]
  channels: ChannelSpec[]
}

export interface Blueprint {
  roles: RoleSpec[]
  categories: CategorySpec[]
}

// ---------------------------------------------------------------------------
// Roles, highest first — Discord orders by position and the provisioner keeps
// this order. A role only appears in a channel's `visibleTo` if it genuinely
// needs to read it.
// ---------------------------------------------------------------------------

/** Everything staff-shaped, for the channels only staff may read. */
export const STAFF_ROLES = ['owner', 'admin', 'developer', 'moderator', 'project_manager'] as const
/** The people who work on releases. */
export const CREW_ROLES = ['translator', 'proofreader', 'timer', 'typesetter', 'karaoke', 'qc', 'encoder'] as const

export const BLUEPRINT: Blueprint = {
  roles: [
    // Administrator is deliberately rare. Owner has it because somebody must;
    // Administrator (the role) has it because that is what the role is for.
    { key: 'owner', name: '👑 Owner', color: 0xE91E63, hoist: true, permissions: ['Administrator'] },
    { key: 'admin', name: '🛡️ Administrator', color: 0xE74C3C, hoist: true, permissions: ['Administrator'] },

    // Below this line: enumerated permissions only.
    {
      key: 'developer',
      name: '🔧 Developer',
      color: 0x9B59B6,
      hoist: true,
      permissions: ['ManageChannels', 'ManageWebhooks', 'ViewAuditLog', 'ManageMessages', 'ReadMessageHistory', 'ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles']
    },
    {
      key: 'moderator',
      name: '🧑‍💻 Moderator',
      color: 0x3498DB,
      hoist: true,
      // No ManageGuild, no ManageRoles, no Administrator: a moderator moderates
      // messages and members, and cannot restructure the server or hand out
      // roles to themselves.
      permissions: ['KickMembers', 'BanMembers', 'ModerateMembers', 'ManageMessages', 'ManageThreads', 'MuteMembers', 'MoveMembers', 'ViewAuditLog', 'ReadMessageHistory', 'ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles']
    },
    {
      key: 'project_manager',
      name: '🎬 Project Manager',
      color: 0x1ABC9C,
      hoist: true,
      permissions: ['ManageThreads', 'ManageMessages', 'MentionEveryone', 'ReadMessageHistory', 'ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles']
    },

    // Crew roles are labels. They carry no moderation power at all — what they
    // do is open the staff channels via channel overwrites, which is where the
    // access belongs.
    { key: 'translator', name: '✍️ Translator', color: 0x2ECC71, permissions: [] },
    { key: 'proofreader', name: '🔎 Proofreader', color: 0x27AE60, permissions: [] },
    { key: 'timer', name: '⏱️ Timer', color: 0xF1C40F, permissions: [] },
    { key: 'typesetter', name: '🎨 Typesetter', color: 0xE67E22, permissions: [] },
    { key: 'karaoke', name: '🎤 Karaoke', color: 0xD35400, permissions: [] },
    { key: 'qc', name: '🧪 QC', color: 0x95A5A6, permissions: [] },
    { key: 'encoder', name: '📦 Encoder', color: 0x7F8C8D, permissions: [] },

    { key: 'bot', name: '🤖 Bot', color: 0x5865F2, permissions: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'ManageWebhooks', 'ManageMessages', 'ModerateMembers'] },
    { key: 'supporter', name: '✨ Supporter', color: 0xF39C12, hoist: true, permissions: [] },
    { key: 'member', name: '🌸 Member', color: 0xBDC3C7, permissions: [] }
  ],

  categories: [
    {
      key: 'information',
      name: '📌 INFORMATION',
      channels: [
        // Read-only for everyone: an announcement channel anyone can post in
        // is not an announcement channel.
        { key: 'welcome', name: 'welcome', kind: 'text', topic: 'Welcome to Yume', postableBy: [...STAFF_ROLES] },
        { key: 'rules', name: 'rules', kind: 'text', topic: 'Read before posting', postableBy: [...STAFF_ROLES] },
        { key: 'announcements', name: 'announcements', kind: 'announcement', topic: 'Official Yume announcements', postableBy: [...STAFF_ROLES] },
        { key: 'news', name: 'news', kind: 'text', topic: 'Anime news', postableBy: [...STAFF_ROLES] },
        { key: 'schedule', name: 'schedule', kind: 'text', topic: 'Airing schedule', postableBy: [...STAFF_ROLES], webhook: 'content' },
        { key: 'faq', name: 'faq', kind: 'text', topic: 'Frequently asked questions', postableBy: [...STAFF_ROLES] }
      ]
    },
    {
      key: 'yume',
      name: '🎬 YUME',
      channels: [
        { key: 'new_releases', name: 'new-releases', kind: 'text', topic: 'Every new release, posted automatically', postableBy: ['bot', ...STAFF_ROLES], webhook: 'release' },
        { key: 'release_updates', name: 'release-updates', kind: 'text', topic: 'Re-encodes, fixes and batch updates', postableBy: ['bot', ...STAFF_ROLES], webhook: 'content' },
        { key: 'watch_now', name: 'watch-now', kind: 'text', topic: 'What to watch right now' },
        { key: 'recommendations', name: 'recommendations', kind: 'text', topic: 'Recommend something' },
        { key: 'watch_together', name: 'watch-together', kind: 'text', topic: 'Find people to watch with' }
      ]
    },
    {
      key: 'community',
      name: '💬 COMMUNITY',
      channels: [
        { key: 'general', name: 'general', kind: 'text', topic: 'General chat' },
        { key: 'anime_chat', name: 'anime-chat', kind: 'text', topic: 'Anime discussion' },
        { key: 'manga', name: 'manga', kind: 'text', topic: 'Manga discussion' },
        { key: 'memes', name: 'memes', kind: 'text', topic: 'Memes' },
        { key: 'off_topic', name: 'off-topic', kind: 'text', topic: 'Anything else' },
        // Slowmode here rather than everywhere: this is the channel people
        // hammer, and a three-second gap costs a human nothing.
        { key: 'bot_commands', name: 'bot-commands', kind: 'text', topic: 'Bot commands', slowmodeSeconds: 3 }
      ]
    },
    {
      key: 'support',
      name: '💻 SUPPORT',
      channels: [
        { key: 'help', name: 'help', kind: 'text', topic: 'Ask for help' },
        { key: 'bug_reports', name: 'bug-reports', kind: 'text', topic: 'Report a bug', slowmodeSeconds: 30 },
        { key: 'feature_requests', name: 'feature-requests', kind: 'text', topic: 'Suggest a feature', slowmodeSeconds: 30 },
        { key: 'feedback', name: 'feedback', kind: 'text', topic: 'Tell us what you think' }
      ]
    },
    {
      key: 'voice',
      name: '🔊 VOICE',
      channels: [
        { key: 'voice_general', name: 'General', kind: 'voice' },
        { key: 'voice_lounge', name: 'Anime Lounge', kind: 'voice' },
        { key: 'voice_watch', name: 'Watch Together', kind: 'voice' },
        { key: 'voice_afk', name: 'AFK', kind: 'voice' }
      ]
    },
    {
      key: 'staff',
      name: '🔐 STAFF',
      visibleTo: [...STAFF_ROLES, ...CREW_ROLES],
      channels: [
        { key: 'staff_chat', name: 'staff-chat', kind: 'text', topic: 'Staff only' },
        { key: 'mod_log', name: 'mod-log', kind: 'text', topic: 'Moderation actions', postableBy: ['bot', ...STAFF_ROLES] },
        { key: 'user_reports', name: 'user-reports', kind: 'text', topic: 'Reports from the site', postableBy: ['bot', ...STAFF_ROLES] },
        { key: 'release_management', name: 'release-management', kind: 'text', topic: 'Release pipeline' },
        { key: 'staff_bot', name: 'staff-bot', kind: 'text', topic: 'Staff bot commands' }
      ]
    },
    {
      key: 'security',
      name: '🛡️ SECURITY',
      // Not the crew: a translator has no reason to see authentication
      // failures, and the smallest audience is the right one for this.
      visibleTo: [...STAFF_ROLES],
      channels: [
        { key: 'security_alerts', name: 'security-alerts', kind: 'text', topic: 'Security events from the site', postableBy: ['bot'], webhook: 'security' },
        { key: 'anti_spam', name: 'anti-spam', kind: 'text', topic: 'Automated anti-abuse actions', postableBy: ['bot'] },
        { key: 'audit_log', name: 'audit-log', kind: 'text', topic: 'Administrative actions', postableBy: ['bot'] },
        { key: 'incidents', name: 'incidents', kind: 'text', topic: 'Incident tracking' }
      ]
    },
    {
      key: 'system',
      name: '🖥️ SYSTEM',
      visibleTo: [...STAFF_ROLES],
      channels: [
        { key: 'server_status', name: 'server-status', kind: 'text', topic: 'VPS and service status', postableBy: ['bot'], webhook: 'system' },
        { key: 'deployments', name: 'deployments', kind: 'text', topic: 'Deployment results', postableBy: ['bot'] },
        { key: 'service_health', name: 'service-health', kind: 'text', topic: 'Health checks', postableBy: ['bot'] },
        { key: 'video_monitor', name: 'video-monitor', kind: 'text', topic: 'Video provider status', postableBy: ['bot'], webhook: 'video' }
      ]
    },
    {
      key: 'analytics',
      name: '📊 ANALYTICS',
      visibleTo: [...STAFF_ROLES],
      channels: [
        { key: 'daily_stats', name: 'daily-stats', kind: 'text', postableBy: ['bot'], webhook: 'analytics' },
        { key: 'weekly_stats', name: 'weekly-stats', kind: 'text', postableBy: ['bot'] },
        { key: 'system_metrics', name: 'system-metrics', kind: 'text', postableBy: ['bot'] }
      ]
    }
  ]
}

/** The webhook names the blueprint declares, in the order they are reported. */
export const WEBHOOK_KINDS = ['security', 'system', 'release', 'video', 'analytics', 'content'] as const
export type WebhookKind = typeof WEBHOOK_KINDS[number]

/** Every channel in the blueprint, flattened, with its category. */
export function allChannels (blueprint: Blueprint = BLUEPRINT): Array<{ category: CategorySpec, channel: ChannelSpec }> {
  return blueprint.categories.flatMap(category => category.channels.map(channel => ({ category, channel })))
}
