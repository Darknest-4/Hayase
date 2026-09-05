// Provisioning from the command line.
//
//   npm run invite            print the invite URL with exactly the needed permissions
//   npm run plan              show what provisioning would do — writes nothing
//   npm run provision         apply the blueprint
//   npm run deploy-commands   register the slash command tree
//
// The plan/apply split is the point. A destructive-looking operation against a
// live Discord server should be readable before it runs, and the same code
// path produces both, so the plan cannot drift from what apply does.

import { config, configured } from './config.ts'
import { BLUEPRINT, allChannels } from './blueprint.ts'
import { commandPayload } from './commands.ts'
import { Rest } from './discord/rest.ts'
import { inviteUrl, provision, type ProvisionReport } from './provision.ts'
import { WEBHOOK_ENV } from './notify.ts'
import { syncAll } from './sync.ts'

const command = process.argv[2] ?? 'plan'

if (command === 'invite') {
  const appId = config.applicationId || process.env.DISCORD_APP_ID
  if (!appId) { console.error('DISCORD_APP_ID is not set.'); process.exit(78) }
  console.log('\nInvite the bot with this URL. It asks for exactly the permissions the provisioner needs — no Administrator:\n')
  console.log('  ' + inviteUrl(appId))
  console.log(`\nThe blueprint will create: ${BLUEPRINT.roles.length} roles, ${BLUEPRINT.categories.length} categories, ${allChannels().length} channels.\n`)
  process.exit(0)
}

if (!configured()) {
  console.error('DISCORD_BOT_TOKEN and DISCORD_APP_ID are required. See docs/discord-telepites.md.')
  process.exit(78)
}

const rest = new Rest({ token: config.requireToken() })

if (command === 'deploy-commands') {
  const payload = commandPayload()
  const scope = config.guildId
    // Guild-scoped commands appear instantly; global ones take up to an hour
    // to propagate. During setup that difference is the whole experience.
    ? `/applications/${config.requireAppId()}/guilds/${config.guildId}/commands`
    : `/applications/${config.requireAppId()}/commands`
  await rest.put(scope, payload)
  console.log(`registered ${payload.length} commands ${config.guildId ? `to guild ${config.guildId}` : 'globally (up to an hour to appear)'}`)
  process.exit(0)
}

if (command !== 'plan' && command !== 'provision') {
  console.error(`unknown command: ${command}. Use invite | plan | provision | deploy-commands.`)
  process.exit(64)
}

if (!config.guildId) {
  console.error('DISCORD_GUILD_ID is not set — that is the server to provision.')
  console.error('Create the server in Discord, invite the bot (npm run invite), then copy the server id.')
  process.exit(78)
}

const dryRun = command === 'plan'
const report: ProvisionReport = await provision({
  rest,
  guildId: config.guildId,
  dryRun,
  onAction: (action, outcome) => { console.log(`  ${outcome === 'applied' ? '✓' : '✗'} ${action.kind} ${action.name}`) }
})

console.log(`\n${dryRun ? 'PLAN' : 'APPLIED'} — ${report.guild.name}\n`)
const group = (prefix: string): number => report.planned.filter(a => a.kind.startsWith(prefix)).length
for (const [label, n] of [['Roles', group('role')], ['Categories', group('category')], ['Channels', group('channel')], ['Webhooks', group('webhook')]] as const) {
  console.log(`  ${label.padEnd(12)} ${dryRun ? `${n} to create/update` : `${n} done`}`)
}
console.log(`  ${'Unchanged'.padEnd(12)} ${report.skipped}`)

if (report.warnings.length) {
  console.log('\nWarnings:')
  for (const warning of report.warnings) console.log('  ! ' + warning)
}

if (report.failed.length) {
  console.log('\nFailed:')
  for (const { action, error } of report.failed) console.log(`  ✗ ${action.kind} ${action.name}: ${error}`)
}

if (Object.keys(report.webhooks).length) {
  // Printed exactly once, to the operator's own terminal. Discord will not
  // show these again, and they are never written to the database.
  console.log('\nWebhook URLs — copy these into .env now, they are shown only once:\n')
  for (const [kind, url] of Object.entries(report.webhooks)) {
    console.log(`  ${WEBHOOK_ENV[kind] ?? kind.toUpperCase()}=${url}`)
  }
}

// The static pages are part of a provisioned server, not a separate chore.
// Boards are left to the running bot, which has live data to put in them.
if (!dryRun && report.ready) {
  const synced = await syncAll(rest, config.guildId, { staticOnly: true })
  console.log(`\n  Messages     ${synced.created} posted, ${synced.edited} edited, ${synced.unchanged} already current`)
}

console.log(`\nStatus: ${report.ready ? 'READY' : 'INCOMPLETE'}`)
if (dryRun) console.log('Nothing was changed. Run `npm run provision` to apply.')
process.exit(report.ready ? 0 : 1)
