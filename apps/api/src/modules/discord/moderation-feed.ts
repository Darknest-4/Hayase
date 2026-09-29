/**
 * MODERÁLÁS DISCORDBÓL — a YUME-bejelentések a moderátori csatornában.
 *
 * Ha a szerveren be van állítva moderátori csatorna (vezérlőpult → Szerver-
 * beállítások), az új bejelentések oda kerülnek, két gombbal: Elrejtés (ahol
 * a tárgy elrejthető: hozzászólás, bejegyzés, értékelés) és Elvetés. A
 * gombnyomás után egy ablak kéri az indoklást, és a döntés UGYANAZON az úton
 * születik, mint az adminfelületen (`moderation/resolve.ts`): ugyanaz a
 * tranzakció, ugyanaz a moderálási napló.
 *
 * KI DÖNTHET: csak az, akinek a Discord-fiókja egy YUME-fiókhoz van kötve, és
 * annak a YUME-fióknak van moderálási joga (`community.moderate`) — a Discordon
 * lévő rangja nem számít. A jogot a gombnyomáskor ÉS az indoklás elküldésekor
 * is ellenőrizzük.
 *
 * AMI A DISCORDRA KERÜL: a bejelentés tárgyának rövid részlete, az oka, és a
 * döntést segítő számok (a bejelentő korábbi bejelentései, hány bejelentés
 * szól ugyanarról). A BEJELENTŐ NEVE NEM — ahhoz az adminfelület kell. A
 * csatornának privátnak kell lennie; a vezérlőpult ezt a beállításnál ki is
 * mondja.
 *
 * AMI MÁSHOL DŐLT EL: ha egy bejelentést közben az adminfelületen zártak le,
 * a Discord-üzenet a következő körben frissül (a gombok eltűnnek).
 */

import { query, queryOne } from '../../infrastructure/database/index.ts'
import { createRestClient, isConfigured } from './rest-client.ts'
import { guildLanguage } from './guild-settings.ts'
import { SZIN, YUME_URL, rovidit } from './embed-kit.ts'

import type { Nyelv } from './i18n.ts'

/** Egy körben szerverenként ennyi új bejelentés megy ki. */
const KOTEG = Number(process.env.DISCORD_MODERATION_BATCH ?? 10)
/** Ennél régebbi nyitott bejelentést nem küldünk ki — a bekapcsolás ne öntse ki a teljes hátralékot. */
const MAX_KOR_NAP = Number(process.env.DISCORD_MODERATION_MAX_AGE_DAYS ?? 7)

export const HIDEABLE_SUBJECTS = new Set(['comment', 'post', 'review'])

const SZOVEG = {
  hu: {
    cim: (tipus: string) => `Új bejelentés: ${tipus}`,
    tipus: { comment: 'hozzászólás', post: 'bejegyzés', topic: 'fórumtéma', review: 'értékelés', user: 'felhasználó', message: 'üzenet', extension: 'bővítmény' } as Record<string, string>,
    ok: { spam: 'spam', harassment: 'zaklatás', nsfw: 'NSFW', spoiler: 'spoiler', illegal: 'illegális', other: 'egyéb' } as Record<string, string>,
    okCim: 'Ok', reszlet: 'Részlet', nincsReszlet: '(nem elérhető)', megjegyzes: 'A bejelentő megjegyzése',
    bejelento: 'A bejelentőtől', bejelentoErtek: (n: number, e: number) => `${n} bejelentés, ebből ${e} elvetve`,
    ugyanarra: 'Ugyanerre', ugyanarraErtek: (n: number) => `${n} bejelentés`,
    elrejt: 'Elrejtés', elvet: 'Elvetés', admin: 'Adminfelület',
    lablec: 'YUME • moderálás • a döntés a YUME moderálási naplójába kerül',
    elrejtve: (ki: string) => `✅ Elrejtve — ${ki}`, elvetve: (ki: string) => `➖ Elvetve — ${ki}`,
    lezarvaMashol: (allapot: string) => `Lezárva a YUME-ban: ${allapot}`,
    allapot: { resolved: 'elrejtve / rendezve', dismissed: 'elvetve' } as Record<string, string>,
    indoklas: 'Indoklás'
  },
  en: {
    cim: (tipus: string) => `New report: ${tipus}`,
    tipus: { comment: 'comment', post: 'post', topic: 'forum topic', review: 'review', user: 'user', message: 'message', extension: 'extension' } as Record<string, string>,
    ok: { spam: 'spam', harassment: 'harassment', nsfw: 'NSFW', spoiler: 'spoiler', illegal: 'illegal', other: 'other' } as Record<string, string>,
    okCim: 'Reason', reszlet: 'Excerpt', nincsReszlet: '(not available)', megjegyzes: 'Reporter\'s note',
    bejelento: 'From the reporter', bejelentoErtek: (n: number, e: number) => `${n} reports, ${e} of them dismissed`,
    ugyanarra: 'Same subject', ugyanarraErtek: (n: number) => `${n} reports`,
    elrejt: 'Hide', elvet: 'Dismiss', admin: 'Admin panel',
    lablec: 'YUME • moderation • decisions go into the YUME moderation log',
    elrejtve: (ki: string) => `✅ Hidden — ${ki}`, elvetve: (ki: string) => `➖ Dismissed — ${ki}`,
    lezarvaMashol: (allapot: string) => `Closed in YUME: ${allapot}`,
    allapot: { resolved: 'hidden / resolved', dismissed: 'dismissed' } as Record<string, string>,
    indoklas: 'Reason'
  }
}

export function feliratok (nyelv: Nyelv): typeof SZOVEG.hu { return SZOVEG[nyelv] }

interface ReportRow {
  id: string
  subject_type: string
  reason: string
  details: string | null
  created_at: Date
  excerpt: string | null
  reporter_total: number
  reporter_dismissed: number
  subject_reports: number
}

/** A bejelentés adatai — ugyanaz a részlet, mint az adminfelület sorában, a bejelentő neve nélkül. */
async function reportRow (id: string): Promise<ReportRow | undefined> {
  return await queryOne<ReportRow>(
    `SELECT r.id, r.subject_type, r.reason, r.details, r.created_at,
            CASE WHEN r.subject_type = 'comment' THEN (SELECT left(c.body, 300) FROM comments c WHERE c.id = r.subject_id)
                 WHEN r.subject_type = 'review'  THEN (SELECT left(v.body, 300) FROM reviews v WHERE v.id = r.subject_id)
                 WHEN r.subject_type = 'post'    THEN (SELECT left(p.body, 300) FROM posts p WHERE p.id = r.subject_id)
                 WHEN r.subject_type = 'user'    THEN (SELECT uu.username FROM users uu WHERE uu.id = r.subject_id)
            END AS excerpt,
            (SELECT count(*)::int FROM reports r2 WHERE r2.reporter_id = r.reporter_id) AS reporter_total,
            (SELECT count(*)::int FROM reports r2
              WHERE r2.reporter_id = r.reporter_id AND r2.status = 'dismissed') AS reporter_dismissed,
            (SELECT count(*)::int FROM reports r3
              WHERE r3.subject_type = r.subject_type AND r3.subject_id = r.subject_id) AS subject_reports
       FROM reports r WHERE r.id = $1`, [id])
}

/** A moderátori üzenet — nyitott bejelentésnél gombokkal, lezártnál a döntéssel. */
export function reportMessage (r: ReportRow, nyelv: Nyelv, dontes: string | null = null): Record<string, unknown> {
  const s = SZOVEG[nyelv]
  const gombok = dontes
    ? []
    : [{
        type: 1,
        components: [
          ...(HIDEABLE_SUBJECTS.has(r.subject_type)
            ? [{ type: 2, style: 4, label: s.elrejt, custom_id: `mod:hide:${r.id}` }]
            : []),
          { type: 2, style: 2, label: s.elvet, custom_id: `mod:dismiss:${r.id}` },
          { type: 2, style: 5, label: s.admin, url: `${YUME_URL}/#/admin/reports` }
        ]
      }]
  return {
    embeds: [{
      color: dontes ? 0x6B_72_80 : SZIN,
      title: s.cim(s.tipus[r.subject_type] ?? r.subject_type),
      description: dontes ?? undefined,
      fields: [
        { name: s.okCim, value: s.ok[r.reason] ?? r.reason, inline: true },
        { name: s.bejelento, value: s.bejelentoErtek(r.reporter_total, r.reporter_dismissed), inline: true },
        { name: s.ugyanarra, value: s.ugyanarraErtek(r.subject_reports), inline: true },
        { name: s.reszlet, value: rovidit(r.excerpt, 300) || s.nincsReszlet, inline: false },
        ...(r.details ? [{ name: s.megjegyzes, value: rovidit(r.details, 300), inline: false }] : [])
      ],
      timestamp: new Date(r.created_at).toISOString(),
      footer: { text: s.lablec }
    }],
    components: gombok,
    // A bejelentett szöveg bármit tartalmazhat — senkit nem említünk vele.
    allowed_mentions: { parse: [] }
  }
}

export interface FeedResult { posted: number, updated: number, failed: number }

/**
 * A KÖR: az új bejelentések kiküldése, és a máshol lezártak frissítése —
 * minden szerveren, ahol van moderátori csatorna.
 */
export async function syncModeration (): Promise<FeedResult> {
  const eredmeny: FeedResult = { posted: 0, updated: 0, failed: 0 }
  if (!isConfigured()) return eredmeny
  const kliens = createRestClient()

  const guildek = await query<{ guild_id: string, moderation_channel_id: string }>(
    'SELECT guild_id, moderation_channel_id FROM discord_guild_settings WHERE moderation_channel_id IS NOT NULL')

  for (const g of guildek) {
    const nyelv = await guildLanguage(g.guild_id)

    const ujak = await query<{ id: string }>(
      `SELECT r.id FROM reports r
        WHERE r.status IN ('open', 'reviewing')
          AND r.created_at > now() - ($2::int || ' days')::interval
          AND NOT EXISTS (SELECT 1 FROM discord_moderation_messages m WHERE m.report_id = r.id AND m.guild_id = $1)
        ORDER BY r.created_at LIMIT $3`, [g.guild_id, MAX_KOR_NAP, KOTEG])

    for (const { id } of ujak) {
      // ELŐBB FOGLALUNK — egy bejelentés szerverenként egyszer megy ki.
      const foglalas = await queryOne(
        `INSERT INTO discord_moderation_messages (report_id, guild_id, channel_id) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING 1`, [id, g.guild_id, g.moderation_channel_id])
      if (!foglalas) continue
      const r = await reportRow(id)
      if (!r) continue
      try {
        const kuldott = await kliens.send(g.moderation_channel_id, reportMessage(r, nyelv))
        await query('UPDATE discord_moderation_messages SET message_id = $3 WHERE report_id = $1 AND guild_id = $2',
          [id, g.guild_id, kuldott.id])
        eredmeny.posted++
      } catch (error) {
        await query('UPDATE discord_moderation_messages SET error = $3 WHERE report_id = $1 AND guild_id = $2',
          [id, g.guild_id, String((error as Error)?.message ?? error).slice(0, 300)])
        eredmeny.failed++
      }
    }

    // A MÁSHOL LEZÁRTAK: az üzenet gombjai eltűnnek, és kiírja az állapotot.
    const lezartak = await query<{ report_id: string, channel_id: string, message_id: string, status: string }>(
      `SELECT m.report_id, m.channel_id, m.message_id, r.status
         FROM discord_moderation_messages m JOIN reports r ON r.id = m.report_id
        WHERE m.guild_id = $1 AND m.message_id IS NOT NULL AND m.shown_status = 'open'
          AND r.status IN ('resolved', 'dismissed')
        LIMIT $2`, [g.guild_id, KOTEG])
    for (const l of lezartak) {
      const r = await reportRow(l.report_id)
      if (!r) continue
      const s = SZOVEG[nyelv]
      try {
        await kliens.edit(l.channel_id, l.message_id, reportMessage(r, nyelv, s.lezarvaMashol(s.allapot[l.status] ?? l.status)))
        eredmeny.updated++
      } catch {
        eredmeny.failed++
      }
      // Akkor is lezárjuk, ha a szerkesztés nem ment: egy törölt üzenetet nem
      // próbálunk minden percben újra.
      await query('UPDATE discord_moderation_messages SET shown_status = $3 WHERE report_id = $1 AND guild_id = $2',
        [l.report_id, g.guild_id, l.status])
    }
  }
  return eredmeny
}

/**
 * A HÍVÓ YUME-MODERÁTOR-E: összekötött fiók, aktív, `community.moderate`
 * joggal. Minden más `undefined` — a Discordon lévő rang nem számít.
 */
export async function moderatorOf (discordUserId: string): Promise<{ id: string, username: string } | undefined> {
  return await queryOne<{ id: string, username: string }>(
    `SELECT u.id, u.username
       FROM discord_links l JOIN users u ON u.id = l.user_id
      WHERE l.discord_user_id = $1 AND u.status = 'active'
        AND EXISTS (
          SELECT 1 FROM user_roles ur
            JOIN role_permissions rp ON rp.role_id = ur.role_id
            JOIN permissions p ON p.id = rp.permission_id
           WHERE ur.user_id = u.id AND p.slug = 'community.moderate')`, [discordUserId])
}

/** A döntés után: az üzenet új alakja (a gombok nélkül). */
export async function decidedMessage (
  reportId: string, guildId: string | null, nyelv: Nyelv, dontes: string
): Promise<Record<string, unknown> | null> {
  const r = await reportRow(reportId)
  if (!r) return null
  if (guildId) {
    await query(
      `UPDATE discord_moderation_messages m SET shown_status = r.status
         FROM reports r WHERE r.id = m.report_id AND m.report_id = $1 AND m.guild_id = $2`, [reportId, guildId])
  }
  return reportMessage(r, nyelv, dontes)
}

/** A már lezárt bejelentés állapota, emberi alakban — ha valaki közben döntött. */
export async function closedState (reportId: string, nyelv: Nyelv): Promise<string | null> {
  const r = await queryOne<{ status: string, resolver: string | null }>(
    `SELECT r.status, u.username AS resolver FROM reports r LEFT JOIN users u ON u.id = r.resolved_by WHERE r.id = $1`,
    [reportId])
  if (!r || r.status === 'open' || r.status === 'reviewing') return null
  const s = SZOVEG[nyelv]
  return `${s.lezarvaMashol(s.allapot[r.status] ?? r.status)}${r.resolver ? ` — ${r.resolver}` : ''}`
}
