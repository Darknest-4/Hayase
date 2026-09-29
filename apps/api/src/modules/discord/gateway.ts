/**
 * A DISCORD GATEWAY — a folyamatos kapcsolat, `discord.js` nélkül.
 *
 * MIÉRT KELL, ha a REST-en is lekérdezhető a szerver állapota. Mert a REST
 * azt mondja meg, MI VAN MOST — hány tag, milyen csatornák —, azt pedig nem,
 * hogy MI TÖRTÉNT. Az üzenetek, a csatlakozások és a kilépések ESEMÉNYEK: a
 * Discord akkor küldi el őket, amikor megtörténnek, és visszamenőleg nem
 * kérdezhetők le. Ami nem volt begyűjtve, az nem létezik.
 *
 * MIÉRT NINCS BENNE KÖNYVTÁR. A protokoll négy dologból áll: egy
 * WebSocket-kapcsolat, egy szívverés, egy azonosítás és egy folytatás. Ez
 * körülbelül háromszáz sor — egy teljes könyvtár ugyanezért több megabájt
 * függőséget, saját életciklust és egy olyan eseménymodellt hozna, amiből
 * három eseményt használnánk. A Node 22-nek saját `WebSocket`-je van.
 *
 * AMIT NEM GYŰJTÜNK: üzenetszöveget, szerzőazonosítót, jelenlétet. Csak
 * DARABSZÁMOKAT, csatornánként és naponként. Ehhez a `MESSAGE_CONTENT`
 * privilegizált intent nem is kell — az esemény enélkül is megérkezik, csak
 * a `content` mező üres, és az nekünk nem kell. Aki egy szerverstatisztikáért
 * cserébe a tagok üzeneteit gyűjti, az nem statisztikát épít.
 *
 * A PROTOKOLL LOGIKÁJA KÜLÖN VAN A HÁLÓZATTÓL (`GatewayEngine`), mert a
 * nehéz része nem a kapcsolat, hanem a döntések: mikor folytatunk és mikor
 * azonosítunk újra, meddig várunk, mit teszünk egy elmaradt szívverés-
 * nyugtára. Ezek mind mérhetők valódi Discord nélkül — és csak úgy
 * mérhetők: egy éles kapcsolatnál nem lehet megrendelni, hogy „most szakadj
 * meg folytatható módon".
 */

import { query } from '../../infrastructure/database/index.ts'
import { botToken, isConfigured } from './rest-client.ts'

// ---------------------------------------------------------------- intentek

/**
 * Az intentek — és melyik privilegizált.
 *
 * A PRIVILEGIZÁLTAT A FEJLESZTŐI PORTÁLON KELL ENGEDÉLYEZNI, és amíg nincs,
 * a Discord a csatlakozást UTASÍTJA VISSZA (4014), nem csak az eseményeket
 * hallgatja el. Ezért nem kérjük alapból: egy nem engedélyezett intent nem
 * kevesebb adatot jelentene, hanem NULLA adatot.
 */
export const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1, // PRIVILEGIZÁLT
  GUILD_MESSAGES: 1 << 9,
  MESSAGE_CONTENT: 1 << 15 // PRIVILEGIZÁLT — nem kérjük, nem kell
} as const

/** Amivel alapból csatlakozunk. A taglista külön kapcsolóval jön. */
export function intentsFromEnv (env: NodeJS.ProcessEnv = process.env): number {
  let bits = INTENTS.GUILDS | INTENTS.GUILD_MESSAGES
  // A csatlakozás/kilépés eseményéhez privilegizált intent kell. Csak akkor
  // kérjük, ha az üzemeltető kifejezetten bekapcsolta — különben a Discord
  // az egész kapcsolatot visszautasítja.
  if (env.DISCORD_GUILD_MEMBERS_INTENT === 'true') bits |= INTENTS.GUILD_MEMBERS
  return bits
}

// ---------------------------------------------------------------- opkódok

export const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11
} as const

/**
 * A lezárási kódok, amikre NEM ÉRDEMES újrapróbálni.
 *
 * Ezek beállítási hibák, nem üzemzavarok: egy rossz token vagy egy nem
 * engedélyezett privilegizált intent újracsatlakozással sosem javul meg, és
 * a végtelen próbálkozás csak a Discord felé gyárt forgalmat. A többi kódnál
 * az újracsatlakozás a helyes válasz.
 */
export const VEGZETES_KODOK = new Set([4004, 4010, 4011, 4012, 4013, 4014])

export function vegzetes (code: number): boolean {
  return VEGZETES_KODOK.has(code)
}

export function kodMagyarazat (code: number): string {
  switch (code) {
    case 4004: return 'érvénytelen bot token'
    case 4010: return 'érvénytelen shard-beállítás'
    case 4011: return 'a bot túl nagy, shardolni kellene'
    case 4012: return 'érvénytelen API-verzió'
    case 4013: return 'érvénytelen intent'
    case 4014: return 'NEM ENGEDÉLYEZETT privilegizált intent — a fejlesztői portálon kell bekapcsolni'
    default: return `lezárva (${code})`
  }
}

// ---------------------------------------------------------------- a motor

export interface EngineState {
  sessionId: string | null
  resumeUrl: string | null
  sequence: number | null
  /** Megjött-e a legutóbbi szívverésre a nyugta. */
  acked: boolean
  heartbeatMs: number
  reconnects: number
  /** Mikor ment ki a legutóbbi szívverés — a nyugtáig eltelt idő a körútidő. */
  szivveresKuldve: number | null
}

export function ujAllapot (): EngineState {
  return { sessionId: null, resumeUrl: null, sequence: null, acked: true, heartbeatMs: 0, reconnects: 0, szivveresKuldve: null }
}

/**
 * AZ ELSŐ SZÍVVERÉS VÉLETLEN KÉSLELTETÉSSEL indul.
 *
 * A Discord dokumentációja külön kéri: enélkül egy nagy leállás után minden
 * bot EGYSZERRE kezdene szívverni, és a visszatérő terhelés egy hullámban
 * érkezne. A `jitter` paraméter a teszt kedvéért injektálható.
 */
export function elsoSzivveres (heartbeatMs: number, jitter: number = Math.random()): number {
  return Math.floor(heartbeatMs * Math.min(Math.max(jitter, 0), 1))
}

/**
 * FOLYTATÁS VAGY ÚJ AZONOSÍTÁS?
 *
 * Folytatni csak akkor lehet, ha VAN munkamenetünk, van hova
 * visszacsatlakozni, és tudjuk, hol tartottunk. Bármelyik hiányzik, az
 * azonosítás a helyes válasz — egy hiányos folytatás a Discordtól `INVALID
 * SESSION`-t kap, és egy fölösleges körrel többe kerül.
 */
export function folytathato (s: EngineState): boolean {
  return s.sessionId !== null && s.resumeUrl !== null && s.sequence !== null
}

/**
 * Az újracsatlakozás várakozása.
 *
 * Exponenciális, de KORLÁTOS, és a hívó adja hozzá a szórást. Az első
 * szakadás után azonnal próbálkozunk: a leggyakoribb eset egy pillanatnyi
 * hálózati zökkenő, és egy másodperc várakozás ott fölösleges kiesés.
 */
export function ujraVaras (probalkozas: number, alap = 1000, max = 60_000): number {
  if (probalkozas <= 0) return 0
  return Math.min(max, alap * 2 ** (probalkozas - 1))
}

// ---------------------------------------------------------------- események

export interface MessageEvent { guildId: string, channelId: string, bot: boolean }
export interface MemberCountEvent { guildId: string, memberCount: number | null }
export interface MemberMoveEvent { guildId: string, joins: number, leaves: number }

/**
 * Egy DISPATCH esemény lefordítása arra, amit gyűjtünk.
 *
 * MINDEN MÁST ELDOBUNK, és ez szándékos: a gateway több tucat eseményt küld,
 * amiből nekünk három kell. Ami nem kell, az nem is kerül a memóriába.
 *
 * A `null` visszatérés nem hiba — azt jelenti, hogy ez az esemény nem
 * érdekel minket.
 */
export function esemenyBol (t: string, d: unknown): {
  kind: 'message' | 'memberCount' | 'join' | 'leave'
  guildId: string
  channelId?: string
  bot?: boolean
  memberCount?: number | null
} | null {
  const adat = (d ?? {}) as Record<string, unknown>
  const guildId = typeof adat.guild_id === 'string' ? adat.guild_id : null

  if (t === 'MESSAGE_CREATE') {
    // A DM-nek nincs `guild_id`-ja. Egy szerverstatisztikába nem is való.
    if (!guildId || typeof adat.channel_id !== 'string') return null
    const szerzo = (adat.author ?? {}) as Record<string, unknown>
    return { kind: 'message', guildId, channelId: adat.channel_id, bot: szerzo.bot === true }
  }

  if (t === 'GUILD_CREATE' || t === 'GUILD_UPDATE') {
    const id = typeof adat.id === 'string' ? adat.id : guildId
    if (!id) return null
    return {
      kind: 'memberCount',
      guildId: id,
      memberCount: typeof adat.member_count === 'number' ? adat.member_count : null
    }
  }

  if (t === 'GUILD_MEMBER_ADD' && guildId) return { kind: 'join', guildId }
  if (t === 'GUILD_MEMBER_REMOVE' && guildId) return { kind: 'leave', guildId }

  return null
}

// ---------------------------------------------------------------- gyűjtő

/**
 * A SZÁMLÁLÓK MEMÓRIÁBAN GYŰLNEK, és kötegben mennek ki.
 *
 * Egy forgalmas szerveren percenként több száz üzenet érkezik; soronkénti
 * írás ugyanennyi adatbázis-kört jelentene egy olyan adatért, amit napi
 * bontásban nézünk. Ugyanaz a minta, mint a látogatottsági gyűjtőnél és a
 * szolgáltatói mérőszámoknál — és ugyanaz a szabály is: a puffer a KIÍRÁS
 * ELŐTT ürül, mert a duplázás rosszabb hiba, mint a hiányzás.
 */
export class Gyujto {
  private uzenetek = new Map<string, { messages: number, bots: number }>()
  private letszam = new Map<string, number>()
  private mozgas = new Map<string, { joins: number, leaves: number }>()

  private static nap (at: Date): string { return at.toISOString().slice(0, 10) }

  uzenet (e: MessageEvent, at: Date = new Date()): void {
    const kulcs = `${Gyujto.nap(at)}|${e.guildId}|${e.channelId}`
    const cella = this.uzenetek.get(kulcs) ?? { messages: 0, bots: 0 }
    if (e.bot) cella.bots++
    else cella.messages++
    this.uzenetek.set(kulcs, cella)
  }

  tagletszam (guildId: string, count: number | null, at: Date = new Date()): void {
    if (count === null) return
    // A NAP UTOLSÓ PILLANATKÉPE nyer — a `set` felülír, és a kiírás is
    // felülír, nem összead. Egy létszám nem összeadódó mennyiség.
    this.letszam.set(`${Gyujto.nap(at)}|${guildId}`, count)
  }

  mozgott (guildId: string, irany: 'join' | 'leave', at: Date = new Date()): void {
    const kulcs = `${Gyujto.nap(at)}|${guildId}`
    const cella = this.mozgas.get(kulcs) ?? { joins: 0, leaves: 0 }
    if (irany === 'join') cella.joins++
    else cella.leaves++
    this.mozgas.set(kulcs, cella)
  }

  fuggoben (): number {
    return this.uzenetek.size + this.letszam.size + this.mozgas.size
  }

  /** Teszthez és leálláshoz. */
  urit (): void {
    this.uzenetek.clear()
    this.letszam.clear()
    this.mozgas.clear()
  }

  async kiir (): Promise<number> {
    const uzenetKoteg = [...this.uzenetek.entries()]
    const letszamKoteg = [...this.letszam.entries()]
    const mozgasKoteg = [...this.mozgas.entries()]
    // ELŐBB ÜRÍT. Lásd az osztály fejlécét.
    this.urit()

    let sorok = 0

    if (uzenetKoteg.length) {
      const napok: string[] = []; const guildek: string[] = []; const csatornak: string[] = []
      const db: number[] = []; const botDb: number[] = []
      for (const [kulcs, cella] of uzenetKoteg) {
        const [nap, guild, csatorna] = kulcs.split('|')
        if (!nap || !guild || !csatorna) continue
        napok.push(nap); guildek.push(guild); csatornak.push(csatorna)
        db.push(cella.messages); botDb.push(cella.bots)
      }
      if (napok.length) {
        await query(
          `INSERT INTO discord_message_stats_daily (day, guild_id, channel_id, messages, bot_messages)
           SELECT * FROM unnest($1::date[], $2::text[], $3::text[], $4::bigint[], $5::bigint[])
           ON CONFLICT (day, guild_id, channel_id) DO UPDATE
                  SET messages     = discord_message_stats_daily.messages + excluded.messages,
                      bot_messages = discord_message_stats_daily.bot_messages + excluded.bot_messages,
                      updated_at   = now()`,
          [napok, guildek, csatornak, db, botDb])
        sorok += napok.length
      }
    }

    if (letszamKoteg.length) {
      for (const [kulcs, count] of letszamKoteg) {
        const [nap, guild] = kulcs.split('|')
        if (!nap || !guild) continue
        await query(
          `INSERT INTO discord_member_stats_daily (day, guild_id, member_count)
           VALUES ($1, $2, $3)
           ON CONFLICT (day, guild_id) DO UPDATE
                  SET member_count = excluded.member_count, updated_at = now()`,
          [nap, guild, count])
        sorok++
      }
    }

    if (mozgasKoteg.length) {
      for (const [kulcs, cella] of mozgasKoteg) {
        const [nap, guild] = kulcs.split('|')
        if (!nap || !guild) continue
        await query(
          `INSERT INTO discord_member_stats_daily (day, guild_id, joins, leaves)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (day, guild_id) DO UPDATE
                  SET joins  = coalesce(discord_member_stats_daily.joins, 0) + excluded.joins,
                      leaves = coalesce(discord_member_stats_daily.leaves, 0) + excluded.leaves,
                      updated_at = now()`,
          [nap, guild, cella.joins, cella.leaves])
        sorok++
      }
    }

    return sorok
  }
}

// ---------------------------------------------------------------- állapot

export interface AllapotMezok {
  status?: string
  sessionId?: string | null
  resumeUrl?: string | null
  sequence?: number | null
  lastError?: string | null
  ready?: boolean
  event?: boolean
  /** Hány újracsatlakozást számoljon hozzá (`true` = egyet). */
  reconnect?: boolean | number
  /** Hány munkamenet folytatódott (RESUMED) — a napi összesítőbe. */
  resumed?: number
  /** Hány új munkamenet indult (READY) — a napi összesítőbe. */
  identified?: number
  /** Egy szívverés körútideje (ms): a legutóbbi az állapotsorba, mind a napi átlagba. */
  rtt?: number
  /** Az összevont körútidő-minták — az `osszevon` állítja elő. */
  rttMinta?: { sum: number, count: number, max: number }
  intents?: number
}

/** Egy számláló értéke: `true` = egy. */
const darab = (v: boolean | number | undefined): number => typeof v === 'number' ? v : (v === true ? 1 : 0)

/** A mai nap, UTC-ben — ugyanúgy, mint a `Gyujto`-ban. */
const maNap = (): string => new Date().toISOString().slice(0, 10)

/**
 * AZ ÁLLAPOTSOR ÉS A NAPI SOR — EGY UTASÍTÁSBAN.
 *
 * Nem kettőben: ha a második elbukna, az `AllapotIro` az egészet újra
 * beküldené, és az első (az újracsatlakozás-számláló) kétszer nőne. Egy
 * adatmódosító `WITH` egyben fut le, vagy sehogy.
 */
export async function allapotIr (mezok: AllapotMezok): Promise<void> {
  const minta = mezok.rttMinta ?? (typeof mezok.rtt === 'number' ? { sum: mezok.rtt, count: 1, max: mezok.rtt } : null)
  const ujra = darab(mezok.reconnect)
  const folytatva = darab(mezok.resumed)
  const uj = darab(mezok.identified)
  await query(
    `WITH allapot AS (
       UPDATE discord_gateway_state
          SET status           = coalesce($1, status),
              session_id       = CASE WHEN $2::boolean THEN $3 ELSE session_id END,
              resume_url       = CASE WHEN $4::boolean THEN $5 ELSE resume_url END,
              sequence         = CASE WHEN $6::boolean THEN $7 ELSE sequence END,
              last_error       = CASE WHEN $8::boolean THEN $9 ELSE last_error END,
              last_ready_at    = CASE WHEN $10 THEN now() ELSE last_ready_at END,
              last_event_at    = CASE WHEN $11 THEN now() ELSE last_event_at END,
              reconnects       = reconnects + $12::int,
              intents          = coalesce($13, intents),
              heartbeat_rtt_ms = coalesce($14::int, heartbeat_rtt_ms),
              updated_at       = now()
        WHERE id = 1
        RETURNING 1)
     INSERT INTO discord_gateway_daily (day, reconnects, resumed, identified, rtt_sum_ms, rtt_count, rtt_max_ms)
     SELECT $15::date, $12::int, $16::int, $17::int, $18::bigint, $19::int, $20::int
      WHERE $12::int + $16::int + $17::int + $19::int > 0
     ON CONFLICT (day) DO UPDATE
        SET reconnects = discord_gateway_daily.reconnects + excluded.reconnects,
            resumed    = discord_gateway_daily.resumed + excluded.resumed,
            identified = discord_gateway_daily.identified + excluded.identified,
            rtt_sum_ms = discord_gateway_daily.rtt_sum_ms + excluded.rtt_sum_ms,
            rtt_count  = discord_gateway_daily.rtt_count + excluded.rtt_count,
            rtt_max_ms = GREATEST(discord_gateway_daily.rtt_max_ms, excluded.rtt_max_ms)`,
    [
      mezok.status ?? null,
      mezok.sessionId !== undefined, mezok.sessionId ?? null,
      mezok.resumeUrl !== undefined, mezok.resumeUrl ?? null,
      mezok.sequence !== undefined, mezok.sequence ?? null,
      mezok.lastError !== undefined, mezok.lastError ?? null,
      mezok.ready === true,
      mezok.event === true,
      ujra,
      mezok.intents ?? null,
      typeof mezok.rtt === 'number' ? Math.round(mezok.rtt) : null,
      maNap(), folytatva, uj,
      Math.round(minta?.sum ?? 0), minta?.count ?? 0, minta ? Math.round(minta.max) : null
    ])
}

/**
 * Két bejegyzés összevonása: ami később jött, az nyer; a számlálók és a
 * körútidő-minták összeadódnak (a csúcs a nagyobbik), hogy egy összevont
 * írás se veszítsen el semmit.
 */
export function osszevon (a: AllapotMezok | null, b: AllapotMezok): AllapotMezok {
  const out: AllapotMezok = { ...(a ?? {}) }
  for (const kulcs of ['status', 'sessionId', 'resumeUrl', 'sequence', 'lastError', 'intents', 'rtt'] as const) {
    if (b[kulcs] !== undefined) (out as Record<string, unknown>)[kulcs] = b[kulcs]
  }
  if (b.ready === true) out.ready = true
  if (b.event === true) out.event = true
  for (const kulcs of ['reconnect', 'resumed', 'identified'] as const) {
    const n = darab(a?.[kulcs]) + darab(b[kulcs])
    if (n > 0) out[kulcs] = n
  }
  const minta = b.rttMinta ?? (typeof b.rtt === 'number' ? { sum: b.rtt, count: 1, max: b.rtt } : undefined)
  if (minta) {
    const eddig = a?.rttMinta
    out.rttMinta = eddig
      ? { sum: eddig.sum + minta.sum, count: eddig.count + minta.count, max: Math.max(eddig.max, minta.max) }
      : { ...minta }
  }
  return out
}

/**
 * AZ ÁLLAPOTSOR ÍRÓJA — összevonva, sorban.
 *
 * Eddig MINDEN Discord-esemény egy `UPDATE` volt ugyanarra a sorra, ritkítás
 * nélkül: egy forgalmas szerveren ez másodpercenként több tucat írás egy
 * olyan adatért (az utolsó esemény ideje, a sorszám), amit percekben mérünk.
 * A `void`-dal indított írások ráadásul versenyeztek, és egy később célba érő,
 * régebbi írás a tárolt sorszámot visszaléptethette.
 *
 * Most egyszerre legfeljebb EGY írás fut; ami közben jön, összeolvad
 * (`osszevon`), és a következő írásban megy ki — mindig a legfrissebb
 * értékkel, tehát a sorszám nem léphet vissza. Az esemény és a sorszám
 * legfeljebb `intervallumMs`-enként ír; minden más (állapotváltás, hiba,
 * munkamenet) azonnal, mert az ritka, és a felületnek rögtön tudnia kell.
 *
 * AMI NEM MENT KI, AZ NEM VÉSZ EL: egy elbukott írás mezői visszaolvadnak a
 * függő bejegyzésbe (a frissebbek alá), és a következő körrel mennek.
 */
export class AllapotIro {
  private fuggo: AllapotMezok | null = null
  private surgos = false
  private fut: Promise<void> | null = null
  private idozito: NodeJS.Timeout | undefined
  private utolso = 0
  // Kiírt mezők, nem paraméter-mezők: a Node típustörlő módja azokat nem ismeri.
  private readonly ir: (m: AllapotMezok) => Promise<void>
  private readonly intervallumMs: number
  private readonly hiba: (e: unknown) => void

  constructor (
    ir: (m: AllapotMezok) => Promise<void> = allapotIr,
    intervallumMs = Number(process.env.DISCORD_GATEWAY_STATE_MS ?? 10_000),
    hiba: (e: unknown) => void = () => {}
  ) {
    this.ir = ir
    this.intervallumMs = intervallumMs
    this.hiba = hiba
  }

  /** Bejegyzés: az esemény, a sorszám és a körútidő ritkítva, minden más azonnal. */
  jelez (m: AllapotMezok): void {
    this.fuggo = osszevon(this.fuggo, m)
    if (Object.keys(m).some(k => k !== 'event' && k !== 'sequence' && k !== 'rtt')) this.surgos = true
    this.utemez()
  }

  /**
   * A függő bejegyzés kiírva — leálláskor. EGY kísérlet: ha az adatbázis nem
   * érhető el, a leállás nem várhat rá a végtelenségig.
   */
  async kiurit (): Promise<void> {
    if (this.fut) await this.fut
    if (this.fuggo) await this.kiir()
    clearTimeout(this.idozito)
    this.idozito = undefined
  }

  private utemez (): void {
    if (this.fut) return // a futó írás végén újra ütemez
    const varas = this.surgos ? 0 : Math.max(0, this.utolso + this.intervallumMs - Date.now())
    if (this.idozito && varas > 0) return // már van időzített írás
    clearTimeout(this.idozito)
    this.idozito = setTimeout(() => { void this.kiir() }, varas)
    this.idozito.unref?.()
  }

  private kiir (): Promise<void> {
    clearTimeout(this.idozito)
    this.idozito = undefined
    if (this.fut) return this.fut
    const m = this.fuggo
    if (!m) return Promise.resolve()
    this.fuggo = null
    this.surgos = false
    this.utolso = Date.now()
    // A lánc ELŐBB kerül a `fut`-ba, és csak utána indul: a `finally` így
    // biztosan a már beírt ígéretet törli, és a várakozó (`kiurit`) már a
    // rendbe tett állapotot látja.
    this.fut = Promise.resolve()
      .then(async () => { await this.ir(m) })
      .catch(e => {
        // A frissebb bejegyzés nyer: a régi alá olvad vissza.
        this.fuggo = this.fuggo ? osszevon(m, this.fuggo) : m
        this.hiba(e)
      })
      .finally(() => {
        this.fut = null
        if (this.fuggo) this.utemez()
      })
    return this.fut
  }
}

export async function allapot (): Promise<Record<string, unknown> | undefined> {
  const sorok = await query<Record<string, unknown>>('SELECT * FROM discord_gateway_state WHERE id = 1')
  return sorok[0]
}

/**
 * ÉL-E A KAPCSOLAT — a felület ebből tudja, van-e egyáltalán adatforrás.
 *
 * NEM A `status` MEZŐ DÖNT ÖNMAGÁBAN. Egy lefagyott folyamat `ready`
 * állapotban hagyhatja a sort, és onnantól a felület örökké azt hinné, hogy
 * gyűjtünk. Az utolsó esemény ideje a valódi jel: ha percek óta nem jött
 * semmi, a kapcsolat nem él, akármit mond a saját magáról.
 */
export function elo (sor: { status?: unknown, last_event_at?: unknown } | undefined, most = Date.now()): boolean {
  if (!sor || sor.status !== 'ready') return false
  const utolso = sor.last_event_at ? new Date(String(sor.last_event_at)).getTime() : 0
  return most - utolso < STALE_MS
}

/**
 * Meddig hisszük el, hogy él.
 *
 * A Discord szívverése ~41 másodperc, és arra mindig válaszol: ha öt percig
 * SEMMI nem jött, az nem csendes szerver, hanem halott kapcsolat.
 *
 * EHHEZ A NYUGTA IS ESEMÉNY (`last_event_at`). Eddig csak a DISPATCH írta, és
 * egy csendes szerveren — ahol öt percig senki nem ír, és a bot sem szerkeszt
 * üzenetet — a felület halottnak mutatta az élő kapcsolatot, a `/status`
 * parancs pedig ugyanezt mondta a gatewayen át érkezett kérdésre.
 */
export const STALE_MS = Number(process.env.DISCORD_GATEWAY_STALE_MS ?? 5 * 60_000)

export function konfiguralva (): boolean {
  return isConfigured() && process.env.DISCORD_GATEWAY_ENABLED !== 'false'
}

export { botToken }
