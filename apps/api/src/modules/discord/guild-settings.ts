/**
 * SZERVERENKÉNTI BEÁLLÍTÁSOK — a vezérlőpult Szerver-beállítások nézete.
 *
 * Nyelv, hírfolyam-szűrők, moderátori csatorna, az összekötött tagok rangja,
 * a YUME-szerepkör → Discord-rang megfeleltetés és az animénként
 * megszólítható rang. Egy sor szerverenként; ami nincs beállítva, az az
 * alapértéket kapja — a sort az első mentés hozza létre.
 *
 * A DISCORD-AZONOSÍTÓK ELLENŐRZÉSE (a csatorna és a rang ehhez a szerverhez
 * tartozik-e) a hívó dolga (`routes.ts`) — ez a modul csak tárol és olvas.
 */

import { query, queryOne } from '../../infrastructure/database/index.ts'
import { nyelvBol, type Nyelv } from './i18n.ts'

export type LanguageSetting = 'hu' | 'en' | 'auto'
export const LANGUAGES: readonly LanguageSetting[] = ['hu', 'en', 'auto']

export interface GuildSettings {
  language: LanguageSetting
  /** A Discord-szerver nyelve, ahogy a gateway utoljára látta. */
  preferredLocale: string | null
  feedGenres: string[]
  feedCurrentSeason: boolean
  moderationChannelId: string | null
  linkedRoleId: string | null
}

export const DEFAULT_SETTINGS: GuildSettings = {
  language: 'hu',
  preferredLocale: null,
  feedGenres: [],
  feedCurrentSeason: false,
  moderationChannelId: null,
  linkedRoleId: null
}

type Sor = {
  language: LanguageSetting
  preferred_locale: string | null
  feed_genres: string[]
  feed_current_season: boolean
  moderation_channel_id: string | null
  linked_role_id: string | null
}

const alakit = (s: Sor | undefined): GuildSettings => s
  ? {
      language: s.language,
      preferredLocale: s.preferred_locale,
      feedGenres: s.feed_genres ?? [],
      feedCurrentSeason: s.feed_current_season,
      moderationChannelId: s.moderation_channel_id,
      linkedRoleId: s.linked_role_id
    }
  : { ...DEFAULT_SETTINGS }

export async function settingsOf (guildId: string): Promise<GuildSettings> {
  return alakit(await queryOne<Sor>(
    `SELECT language, preferred_locale, feed_genres, feed_current_season, moderation_channel_id, linked_role_id
       FROM discord_guild_settings WHERE guild_id = $1`, [guildId]))
}

export type SettingsChange = Partial<Omit<GuildSettings, 'preferredLocale'>>

/**
 * Mentés — csak a megadott mezők változnak. A `null` törlést jelent (a
 * csatornánál és a rangnál), az `undefined` érintetlenül hagyást.
 */
export async function saveSettings (guildId: string, v: SettingsChange): Promise<GuildSettings> {
  const has = (k: keyof SettingsChange): boolean => v[k] !== undefined
  return alakit(await queryOne<Sor>(
    `INSERT INTO discord_guild_settings AS s
       (guild_id, language, feed_genres, feed_current_season, moderation_channel_id, linked_role_id)
     VALUES ($1, coalesce($3, 'hu'), coalesce($5::text[], '{}'), coalesce($7, false), $9, $11)
     ON CONFLICT (guild_id) DO UPDATE SET
       language              = CASE WHEN $2 THEN excluded.language ELSE s.language END,
       feed_genres           = CASE WHEN $4 THEN excluded.feed_genres ELSE s.feed_genres END,
       feed_current_season   = CASE WHEN $6 THEN excluded.feed_current_season ELSE s.feed_current_season END,
       moderation_channel_id = CASE WHEN $8 THEN excluded.moderation_channel_id ELSE s.moderation_channel_id END,
       linked_role_id        = CASE WHEN $10 THEN excluded.linked_role_id ELSE s.linked_role_id END,
       updated_at            = now()
     RETURNING language, preferred_locale, feed_genres, feed_current_season, moderation_channel_id, linked_role_id`,
    [guildId,
      has('language'), v.language ?? null,
      has('feedGenres'), v.feedGenres ?? null,
      has('feedCurrentSeason'), v.feedCurrentSeason ?? null,
      has('moderationChannelId'), v.moderationChannelId ?? null,
      has('linkedRoleId'), v.linkedRoleId ?? null]))
}

/** A Discord-szerver nyelve — a gateway írja, amikor a szervert látja. */
export async function rememberLocale (guildId: string, locale: string | null): Promise<void> {
  if (!locale) return
  await query(
    `INSERT INTO discord_guild_settings (guild_id, preferred_locale) VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET preferred_locale = excluded.preferred_locale
      WHERE discord_guild_settings.preferred_locale IS DISTINCT FROM excluded.preferred_locale`,
    [guildId, locale.slice(0, 16)])
}

/** A SZERVERRE kimenő üzenetek nyelve — az `auto` a Discord-szerver nyelve. */
export async function guildLanguage (guildId: string): Promise<Nyelv> {
  const s = await settingsOf(guildId)
  if (s.language === 'auto') return nyelvBol(s.preferredLocale)
  return s.language
}

// ---------------------------------------------------------------- rangok

export interface RoleMapping { yumeRole: string, discordRoleId: string }

export async function roleMappings (guildId: string): Promise<RoleMapping[]> {
  return (await query<{ yume_role_slug: string, discord_role_id: string }>(
    'SELECT yume_role_slug, discord_role_id FROM discord_role_mappings WHERE guild_id = $1 ORDER BY yume_role_slug',
    [guildId])).map(r => ({ yumeRole: r.yume_role_slug, discordRoleId: r.discord_role_id }))
}

/** A megfeleltetés CSERÉJE: ami nincs a listában, az megszűnik. */
export async function saveRoleMappings (guildId: string, lista: RoleMapping[]): Promise<void> {
  await query('DELETE FROM discord_role_mappings WHERE guild_id = $1', [guildId])
  if (!lista.length) return
  await query(
    `INSERT INTO discord_role_mappings (guild_id, yume_role_slug, discord_role_id)
     SELECT $1, * FROM unnest($2::text[], $3::text[])`,
    [guildId, lista.map(m => m.yumeRole), lista.map(m => m.discordRoleId)])
}

// ---------------------------------------------------------------- animénkénti rang

export interface AnimeMention { animeId: string, title: string, discordRoleId: string }

export async function animeMentions (guildId: string): Promise<AnimeMention[]> {
  return (await query<{ anime_id: string, title: string, discord_role_id: string }>(
    `SELECT m.anime_id, a.canonical_title AS title, m.discord_role_id
       FROM discord_anime_mentions m JOIN anime a ON a.id = m.anime_id
      WHERE m.guild_id = $1 ORDER BY a.canonical_title`, [guildId]))
    .map(r => ({ animeId: r.anime_id, title: r.title, discordRoleId: r.discord_role_id }))
}

export async function saveAnimeMention (guildId: string, animeId: string, discordRoleId: string): Promise<boolean> {
  const sor = await queryOne(
    `INSERT INTO discord_anime_mentions (guild_id, anime_id, discord_role_id)
     SELECT $1, a.id, $3 FROM anime a WHERE a.id = $2 AND a.visibility = 'public'
     ON CONFLICT (guild_id, anime_id) DO UPDATE SET discord_role_id = excluded.discord_role_id
     RETURNING 1`, [guildId, animeId, discordRoleId])
  return Boolean(sor)
}

export async function removeAnimeMention (guildId: string, animeId: string): Promise<boolean> {
  const sor = await queryOne(
    'DELETE FROM discord_anime_mentions WHERE guild_id = $1 AND anime_id = $2 RETURNING 1', [guildId, animeId])
  return Boolean(sor)
}
