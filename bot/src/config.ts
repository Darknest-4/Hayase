// Environment for the bot. Mirrors server/src/config.ts: validate at import,
// fail loudly, never print a secret.

const required = (name: string): string => {
  const value = process.env[name]
  if (!value) {
    // A missing variable is a configuration mistake, not a crash. The compose
    // service is `restart: on-failure`, so a clean non-zero exit with this line
    // in the log leaves the container stopped instead of looping forever.
    console.error(`[yume-bot] ${name} is not set. See docs/discord-telepites.md.`)
    process.exit(78)   // EX_CONFIG
  }
  return value
}

export const config = {
  token: process.env.DISCORD_BOT_TOKEN ?? '',
  applicationId: process.env.DISCORD_APP_ID ?? '',
  publicKey: process.env.DISCORD_PUBLIC_KEY ?? '',
  guildId: process.env.DISCORD_GUILD_ID ?? '',

  /** Where the bot reaches the Yume API. Inside compose this is the service name. */
  apiUrl: process.env.YUME_API_URL ?? 'http://app:4000',
  /** Shared secret for the bot→API and API→bot calls. Not a user credential. */
  serviceToken: process.env.YUME_SERVICE_TOKEN ?? '',
  /** Public site URL, used in embeds and buttons. */
  siteUrl: process.env.YUME_SITE_URL ?? 'http://localhost',

  port: Number(process.env.BOT_PORT ?? 4100),
  requireToken: (): string => required('DISCORD_BOT_TOKEN'),
  requireAppId: (): string => required('DISCORD_APP_ID'),
  requirePublicKey: (): string => required('DISCORD_PUBLIC_KEY')
} as const

/** True when there is enough configuration to talk to Discord at all. */
export const configured = (): boolean => Boolean(config.token && config.applicationId)
