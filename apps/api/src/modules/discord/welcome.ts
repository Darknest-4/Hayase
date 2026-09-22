/**
 * A KÖSZÖNTŐ RENDSZER.
 *
 * Új tag érkezik → a gateway megkapja a `GUILD_MEMBER_ADD` eseményt → ez a
 * modul dönt: kell-e köszönteni, hova, mit, és kapjon-e rangot.
 *
 * A DUPLIKÁCIÓVÉDELEM NEM ELHANYAGOLHATÓ RÉSZLET. A gateway egy
 * újracsatlakozás után MEGISMÉTELHETI az eseményeket, és egy tag két
 * köszöntője rosszabb, mint egy sem: az első kellemes, a második azt üzeni,
 * hogy a bot hibás. A védelem az adatbázisban van, nem a memóriában — több
 * példány között is működnie kell.
 *
 * A SABLONVÁLTOZÓK ZÁRT LISTÁBÓL JÖNNEK. Egy szabad helyettesítés azt
 * jelentené, hogy a sablonba írt `{valami}` némán ottmarad a kimenetben,
 * vagy — rosszabb esetben — olyasmit helyettesítünk be, amit nem akartunk.
 * Ismeretlen változónál a mentés HIBÁT ad, nem csendes elhagyást.
 */

import { query, queryOne } from '../../infrastructure/database/index.ts'
import * as rest from './rest-client.ts'
import * as registry from './registry.ts'

/** Amit a sablonban használni lehet. Ami nincs itt, azt elutasítjuk. */
export const VARIABLES = [
  'user', 'username', 'server_name', 'member_count',
  'rules_channel', 'welcome_channel', 'yume_url'
] as const

export type Variable = typeof VARIABLES[number]

export interface WelcomeConfig {
  guild_id: string
  enabled: boolean
  channel_id: string | null
  template: string
  role_key: string | null
  dm_enabled: boolean
  mention: boolean
  updated_at: Date
}

export const DEFAULT_TEMPLATE =
  'Üdv a(z) **{server_name}** szerveren, {user}!\n\n' +
  'A YUME egy magyar animeoldal — nézd meg itt: {yume_url}\n' +
  'A szabályzatot a {rules_channel} csatornában találod.\n\n' +
  'Jó szórakozást! Te vagy a **{member_count}.** tagunk.'

/**
 * A SABLON ELLENŐRZÉSE.
 *
 * Három dolgot néz: nincs-e benne ismeretlen változó, nem túl hosszú-e (a
 * Discord embed leírása 4096 karakter), és nem próbál-e tömeges említést.
 * Az `@everyone` egy köszöntőben minden új tagnál felverné az egész
 * szervert — ez nem funkció, hanem baleset.
 */
export function validateTemplate (template: string): { ok: true } | { ok: false, error: string } {
  if (typeof template !== 'string' || template.trim() === '') {
    return { ok: false, error: 'A sablon nem lehet üres.' }
  }
  if (template.length > 3500) {
    return { ok: false, error: 'A sablon túl hosszú (legfeljebb 3500 karakter).' }
  }
  if (/@everyone|@here/.test(template)) {
    return { ok: false, error: 'Az @everyone és az @here nem használható a köszöntőben.' }
  }
  const ismeretlen = [...template.matchAll(/\{([a-z_]+)\}/g)]
    .map(m => m[1]!)
    .filter(v => !(VARIABLES as readonly string[]).includes(v))
  if (ismeretlen.length) {
    return { ok: false, error: `Ismeretlen változó: ${[...new Set(ismeretlen)].join(', ')}` }
  }
  return { ok: true }
}

export interface RenderContext {
  userId: string
  username: string
  serverName: string
  memberCount: number | null
  rulesChannelId: string | null
  welcomeChannelId: string | null
}

/** A behelyettesítés. Csak a zárt listát ismeri. */
export function renderTemplate (template: string, ctx: RenderContext): string {
  const ertek: Record<Variable, string> = {
    user: `<@${ctx.userId}>`,
    username: ctx.username,
    server_name: ctx.serverName,
    // A NULLA ÉS A „NEM TUDJUK" NEM UGYANAZ. Ha nincs létszámadat, nem írunk
    // oda nullát — az azt állítaná, hogy a szervernek nincs tagja.
    member_count: ctx.memberCount === null ? '—' : String(ctx.memberCount),
    rules_channel: ctx.rulesChannelId ? `<#${ctx.rulesChannelId}>` : '#szabalyzat',
    welcome_channel: ctx.welcomeChannelId ? `<#${ctx.welcomeChannelId}>` : '#udvozlet',
    yume_url: process.env.PUBLIC_URL ?? 'https://animehub.hu'
  }
  return template.replace(/\{([a-z_]+)\}/g, (egesz, nev: string) =>
    (VARIABLES as readonly string[]).includes(nev) ? ertek[nev as Variable] : egesz)
}

const SZIN = 0xE4_1E_63

export function buildEmbed (szoveg: string, ctx: RenderContext): unknown {
  return {
    // A MENTION AZ ÜZENET TÖRZSÉBEN KELL, nem az embedben: a Discord az
    // embedben lévő említésre NEM küld értesítést, és a tag nem venné észre.
    embeds: [{
      title: `Üdv a(z) ${ctx.serverName} szerveren!`,
      description: szoveg,
      color: SZIN,
      footer: { text: 'YUME' }
    }],
    /*
     * AZ EMLÍTÉSEK KORLÁTOZVA. Csak azt a felhasználót említhetjük, akiről
     * az üzenet szól — szerepkört és `@everyone`-t soha, akkor sem, ha a
     * sablonba valahogy bekerülne.
     */
    allowed_mentions: { parse: [], users: [ctx.userId] }
  }
}

// ---------------------------------------------------------------- beállítás

export async function config (guildId: string): Promise<WelcomeConfig> {
  const sor = await queryOne<WelcomeConfig>(
    'SELECT * FROM discord_welcome_config WHERE guild_id = $1', [guildId])
  if (sor) return sor
  return {
    guild_id: guildId,
    enabled: false,
    channel_id: null,
    template: DEFAULT_TEMPLATE,
    role_key: null,
    dm_enabled: false,
    mention: true,
    updated_at: new Date()
  }
}

export async function saveConfig (guildId: string, mezok: {
  enabled?: boolean
  channelId?: string | null
  template?: string
  roleKey?: string | null
  dmEnabled?: boolean
  mention?: boolean
}): Promise<WelcomeConfig> {
  if (mezok.template !== undefined) {
    const ellenorzes = validateTemplate(mezok.template)
    if (!ellenorzes.ok) throw new Error(ellenorzes.error)
  }
  const sor = await queryOne<WelcomeConfig>(
    `INSERT INTO discord_welcome_config (guild_id, enabled, channel_id, template, role_key, dm_enabled, mention)
     VALUES ($1, coalesce($2, false), $3, coalesce($4, $8), $5, coalesce($6, false), coalesce($7, true))
     ON CONFLICT (guild_id) DO UPDATE
        SET enabled    = coalesce($2, discord_welcome_config.enabled),
            channel_id = CASE WHEN $9::boolean THEN $3 ELSE discord_welcome_config.channel_id END,
            template   = coalesce($4, discord_welcome_config.template),
            role_key   = CASE WHEN $10::boolean THEN $5 ELSE discord_welcome_config.role_key END,
            dm_enabled = coalesce($6, discord_welcome_config.dm_enabled),
            mention    = coalesce($7, discord_welcome_config.mention),
            updated_at = now()
     RETURNING *`,
    [guildId, mezok.enabled ?? null, mezok.channelId ?? null, mezok.template ?? null,
      mezok.roleKey ?? null, mezok.dmEnabled ?? null, mezok.mention ?? null,
      DEFAULT_TEMPLATE, mezok.channelId !== undefined, mezok.roleKey !== undefined])
  return sor!
}

// ---------------------------------------------------------------- küldés

export type Outcome = 'sent' | 'skipped' | 'failed' | 'test'

async function naploz (
  guildId: string, userId: string, outcome: Outcome, detail?: string
): Promise<void> {
  await query(
    'INSERT INTO discord_welcome_log (guild_id, discord_user_id, outcome, detail) VALUES ($1, $2, $3, $4)',
    [guildId, userId, outcome, detail ? detail.slice(0, 300) : null])
}

/** Meddig számít ugyanannak a belépésnek. Egy újracsatlakozás nem köszönt újra. */
export const DEDUPE_MS = Number(process.env.DISCORD_WELCOME_DEDUPE_MS ?? 60 * 60_000)

/**
 * KAPOTT-E MÁR KÖSZÖNTŐT.
 *
 * Az ADATBÁZIS dönt, nem a folyamat memóriája: a gateway több példányban is
 * futhat, és egy memóriabeli halmaz mindegyikben külön lenne.
 */
export async function alreadyWelcomed (guildId: string, userId: string): Promise<boolean> {
  const sor = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM discord_welcome_log
      WHERE guild_id = $1 AND discord_user_id = $2 AND outcome = 'sent'
        AND at > now() - ($3::int || ' milliseconds')::interval`,
    [guildId, userId, DEDUPE_MS])
  return (sor?.n ?? 0) > 0
}

export interface JoinEvent {
  guildId: string
  userId: string
  username: string
  /** A guild neve és létszáma, ha a gateway tudja. */
  serverName?: string
  memberCount?: number | null
}

/**
 * EGY BELÉPÉS FELDOLGOZÁSA.
 *
 * Minden ág naplózik — a „nem küldtünk" is válasz. A felület ebből tudja
 * megmondani, hogy a köszöntő azért maradt el, mert ki van kapcsolva, vagy
 * mert nincs jogunk írni a csatornába.
 */
export async function handleJoin (e: JoinEvent): Promise<Outcome> {
  const beall = await config(e.guildId)
  if (!beall.enabled) { await naploz(e.guildId, e.userId, 'skipped', 'a köszöntő ki van kapcsolva'); return 'skipped' }
  if (!beall.channel_id) { await naploz(e.guildId, e.userId, 'skipped', 'nincs beállítva csatorna'); return 'skipped' }
  if (await alreadyWelcomed(e.guildId, e.userId)) {
    await naploz(e.guildId, e.userId, 'skipped', 'már kapott köszöntőt')
    return 'skipped'
  }

  const [guild, szabalyzat] = await Promise.all([
    rest.fetchGuild(e.guildId),
    registry.get(e.guildId, 'channel', 'channel:szabalyzat')
  ])

  const ctx: RenderContext = {
    userId: e.userId,
    username: e.username,
    serverName: e.serverName ?? guild?.name ?? 'a szerver',
    memberCount: e.memberCount ?? guild?.memberCount ?? null,
    rulesChannelId: szabalyzat?.discord_object_id ?? null,
    welcomeChannelId: beall.channel_id
  }

  const szoveg = renderTemplate(beall.template, ctx)
  const payload = buildEmbed(szoveg, ctx)
  const teljes = beall.mention
    ? { ...(payload as object), content: `<@${e.userId}>` }
    : payload

  const kliens = rest.createRestClient()
  try {
    await kliens.send(beall.channel_id, teljes)
  } catch (error) {
    const ok = String((error as { kind?: string }).kind ?? (error as Error).message)
    await naploz(e.guildId, e.userId, 'failed', ok)
    return 'failed'
  }

  // A RANG ÉS A DM NEM BUKTATJA MEG A KÖSZÖNTŐT. Ha az üzenet kiment, a
  // lényeg megtörtént; a többi jó, ha sikerül.
  if (beall.role_key) {
    const rang = await registry.get(e.guildId, 'role', beall.role_key)
    if (rang?.discord_object_id) {
      await rest.addMemberRole(e.guildId, e.userId, rang.discord_object_id, 'YUME köszöntő')
    }
  }
  if (beall.dm_enabled) {
    await rest.sendDirectMessage(e.userId, buildEmbed(szoveg, ctx))
  }

  await naploz(e.guildId, e.userId, 'sent')
  return 'sent'
}

/** Előnézet — a Discordot MEG SEM SZÓLÍTJA. */
export async function preview (guildId: string, username = 'ujtag'): Promise<{
  text: string
  payload: unknown
}> {
  const beall = await config(guildId)
  const [guild, szabalyzat] = await Promise.all([
    rest.fetchGuild(guildId),
    registry.get(guildId, 'channel', 'channel:szabalyzat')
  ])
  const ctx: RenderContext = {
    userId: '000000000000000000',
    username,
    serverName: guild?.name ?? 'a szerver',
    memberCount: guild?.memberCount ?? null,
    rulesChannelId: szabalyzat?.discord_object_id ?? null,
    welcomeChannelId: beall.channel_id
  }
  const szoveg = renderTemplate(beall.template, ctx)
  return { text: szoveg, payload: buildEmbed(szoveg, ctx) }
}

export async function log (guildId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
  return await query(
    `SELECT discord_user_id, outcome, detail, at FROM discord_welcome_log
      WHERE guild_id = $1 ORDER BY at DESC LIMIT $2`, [guildId, limit])
}
