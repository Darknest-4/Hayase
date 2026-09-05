// The command tree, and what each command does.
//
// Registration is a separate step (`npm run deploy-commands`) because Discord
// caches the tree per application: re-registering on every boot burns rate
// limit and makes a restart a schema migration.
//
// Authorisation is stated here as `defaultMemberPermissions`, which is what
// Discord itself enforces before the interaction is ever sent — a member
// without the bit does not see the command. The handler checks again anyway:
// a permission a server admin can override in the UI is a convenience, not a
// control.

import { toBits } from './discord/permissions.ts'

export interface CommandSpec {
  name: string
  description: string
  options?: unknown[]
  /** Discord hides the command from members without these permissions. */
  defaultMemberPermissions?: string[]
  dmPermission?: boolean
}

const STRING = 3
const USER = 6
const INTEGER = 4
const SUB = 1

export const COMMANDS: CommandSpec[] = [
  { name: 'help', description: 'What this bot can do' },
  { name: 'status', description: 'Is Yume up?' },
  { name: 'uptime', description: 'How long the bot and the API have been running' },
  { name: 'website', description: 'A link to Yume' },
  {
    name: 'search',
    description: 'Search the Yume catalogue',
    options: [{ type: STRING, name: 'query', description: 'Title to look for', required: true }]
  },
  {
    name: 'anime',
    description: 'Details for one title',
    options: [{ type: STRING, name: 'query', description: 'Title', required: true }]
  },
  { name: 'schedule', description: "What is airing this week" },
  { name: 'releases', description: 'The most recent releases' },
  {
    name: 'watch',
    description: 'A link straight to an episode',
    options: [
      { type: STRING, name: 'query', description: 'Title', required: true },
      { type: INTEGER, name: 'episode', description: 'Episode number', required: false }
    ]
  },

  // ---- server management ---------------------------------------------------
  {
    name: 'yume',
    description: 'Yume server administration',
    // ManageGuild rather than Administrator: setting the server up is not the
    // same authority as owning it.
    defaultMemberPermissions: ['ManageGuild'],
    options: [
      {
        type: SUB,
        name: 'setup',
        description: 'Create or repair the Yume server structure',
        options: [{ type: 3, name: 'mode', description: 'plan (default) or apply', required: false, choices: [{ name: 'plan', value: 'plan' }, { name: 'apply', value: 'apply' }] }]
      },
      { type: SUB, name: 'health', description: 'Yume system status' },
      { type: SUB, name: 'verify', description: 'Check the server against the blueprint without changing anything' }
    ]
  },

  // ---- moderation ----------------------------------------------------------
  // Each maps to one Discord REST call and each is audited. `defaultMemberPermissions`
  // matches the permission the action itself needs, so the command is not
  // offered to somebody Discord would refuse anyway.
  {
    name: 'warn',
    description: 'Warn a member (recorded, no Discord action)',
    defaultMemberPermissions: ['ModerateMembers'],
    options: [
      { type: USER, name: 'member', description: 'Who', required: true },
      { type: STRING, name: 'reason', description: 'Why', required: true }
    ]
  },
  {
    name: 'timeout',
    description: 'Time a member out',
    defaultMemberPermissions: ['ModerateMembers'],
    options: [
      { type: USER, name: 'member', description: 'Who', required: true },
      { type: INTEGER, name: 'minutes', description: 'How long (1–40320)', required: true },
      { type: STRING, name: 'reason', description: 'Why', required: true }
    ]
  },
  {
    name: 'kick',
    description: 'Remove a member from the server',
    defaultMemberPermissions: ['KickMembers'],
    options: [
      { type: USER, name: 'member', description: 'Who', required: true },
      { type: STRING, name: 'reason', description: 'Why', required: true }
    ]
  },
  {
    name: 'ban',
    description: 'Ban a member',
    defaultMemberPermissions: ['BanMembers'],
    options: [
      { type: USER, name: 'member', description: 'Who', required: true },
      { type: STRING, name: 'reason', description: 'Why', required: true },
      { type: INTEGER, name: 'delete_days', description: 'Delete their messages from the last N days (0–7)', required: false }
    ]
  },
  {
    name: 'purge',
    description: 'Bulk-delete recent messages in this channel',
    defaultMemberPermissions: ['ManageMessages'],
    options: [{ type: INTEGER, name: 'count', description: 'How many (2–100)', required: true }]
  },
  {
    name: 'slowmode',
    description: 'Set this channel’s slowmode',
    defaultMemberPermissions: ['ManageChannels'],
    options: [{ type: INTEGER, name: 'seconds', description: '0 to turn it off, up to 21600', required: true }]
  }
]

/** The payload Discord's bulk-overwrite endpoint expects. */
export function commandPayload (commands: CommandSpec[] = COMMANDS): unknown[] {
  return commands.map(command => ({
    name: command.name,
    description: command.description,
    ...(command.options ? { options: command.options } : {}),
    ...(command.defaultMemberPermissions ? { default_member_permissions: toBits(command.defaultMemberPermissions) } : {}),
    dm_permission: command.dmPermission ?? false
  }))
}
