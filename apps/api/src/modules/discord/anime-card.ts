/**
 * AZ ANIMEKÁRTYA — egy cím adatlapja a Discordon.
 *
 * EGY HELYEN, mert a parancsok, a hírfolyam, a DM és a tartós üzenetek is
 * ugyanazt a címet mutatják. Amíg mindegyik maga rakta össze, eltértek: a
 * hírfolyam a 0–100-as pontszámot „82.0"-nak írta, az oldal „82%"-nak; az
 * állapot nyersen ment ki („RELEASING"); az `/anime info` borító és leírás
 * nélkül, három mezővel.
 *
 * AMI NINCS, AZ KIMARAD. Egy frissen importált címnél lehet, hogy nincs
 * borító, stúdió vagy leírás — a mező ilyenkor nem jelenik meg; se „—", se
 * kitalált tartalom.
 *
 * A KÉPEK ABSZOLÚT CÍMMEL mennek ki, ugyanazzal a szabállyal, mint az oldalon
 * (`media/public-url.ts`: a saját tükrünk, és csak ha nincs, a forrás CDN-je).
 * A Discord relatív címet nem fogad el — az egész üzenetet visszadobja.
 *
 * FELNŐTT CÍM (`is_adult`) SEMMILYEN BOT-KIMENETBEN NEM MUTAT KÉPET ÉS
 * LEÍRÁST, a nyilvános listákból (keresés, címkiegészítés, véletlen,
 * menetrend, hírfolyam, tartós üzenetek) pedig ki is marad — ahogy az oldal
 * katalógusa is alapból elrejti (`NOT a.is_adult`). A Discord szabályai
 * szerint szexuális tartalom csak korhatáros csatornába mehet, és egy
 * borítókép egy általános csatornában épp ez volna. A saját könyvtárad címe
 * (/watchlist, /next, DM) a nevével megjelenik, kép és leírás nélkül.
 *
 * AZ ELŐZETES GOMBJA csak akkor, ha az oldalon is látszik: a
 * `feature.trailers` kapcsoló mindenkinek be van kapcsolva.
 */

import { query } from '../../infrastructure/database/index.ts'
import { imageUrl } from '../media/public-url.ts'
import { flags } from '../settings/feature-flags.ts'
import { SZIN, YUME_URL } from './embed-kit.ts'

import type { Nyelv } from './i18n.ts'

const IKON = process.env.DISCORD_EMBED_ICON || `${YUME_URL}/assets/yume.svg`

// ---------------------------------------------------------------- feliratok

/**
 * A katalógus felsorolásai emberi alakban — ugyanazokkal a szavakkal, mint az
 * oldal (`shared/lib/dom.js` + `i18n/hu.js`), hogy a Discordon és a YUME-n
 * ugyanaz álljon.
 */
const CIMKE = {
  hu: {
    formatum: '📺 Formátum', allapot: '📡 Állapot', szezon: '🗓️ Szezon', epizodok: '🎬 Epizódok',
    pont: '⭐ Pontszám', nepszeruseg: '👥 Népszerűség', studio: '🏢 Stúdió', forras: '📖 Forrás',
    mufajok: '🏷️ Műfajok', kovetkezo: '⏭️ Következő rész', vetites: '📅 Vetítés',
    epizod: '🎬 Epizód', hossz: '⏱️ Hossz', adas: '🗓️ Adás', errol: '📝 Erről a részről',
    resz: (n: string | number) => `${n}. rész`,
    perc: (n: number) => `${n} perc`,
    percReszenkent: (n: number) => `${n} perc/rész`,
    elerheto: (van: number, ossz: number | null) => ossz ? `${van} / ${ossz} elérhető` : `${van} elérhető`,
    osszesen: (n: number) => `${n} rész · még egy sem elérhető`,
    ota: (d: string) => `${d} óta`,
    kezdes: (d: string) => `kezdés: ${d}`,
    toltelek: 'töltelékrész', osszefoglalo: 'összefoglaló rész',
    felnott: '🔞 Felnőtt tartalom — a borítót és a leírást a Discordon nem mutatjuk.',
    megnezem: 'Megnézem', adatlap: 'Adatlap', elozetes: 'Előzetes',
    lablec: 'YUME • Anime • Közösség',
    format: {
      TV: 'TV', TV_SHORT: 'Rövid TV', MOVIE: 'Film', SPECIAL: 'Speciális', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Zene'
    } as Record<string, string>,
    statusz: {
      RELEASING: 'Adásban', FINISHED: 'Befejezett', NOT_YET_RELEASED: 'Még nem indult',
      CANCELLED: 'Törölve', HIATUS: 'Szünetel'
    } as Record<string, string>,
    evszak: { WINTER: 'Tél', SPRING: 'Tavasz', SUMMER: 'Nyár', FALL: 'Ősz' } as Record<string, string>,
    forrasok: {
      ORIGINAL: 'Eredeti', MANGA: 'Manga', LIGHT_NOVEL: 'Light novel', VISUAL_NOVEL: 'Visual novel',
      VIDEO_GAME: 'Videojáték', OTHER: 'Egyéb'
    } as Record<string, string>,
    // A `genres` tábla teljes készlete; az oldal ugyanígy fordítja.
    mufaj: {
      Action: 'Akció', Adventure: 'Kaland', Comedy: 'Vígjáték', Drama: 'Dráma', Ecchi: 'Ecchi',
      Fantasy: 'Fantasy', Hentai: 'Hentai', Horror: 'Horror', 'Mahou Shoujo': 'Varázslólány', Mecha: 'Mecha',
      Music: 'Zene', Mystery: 'Rejtély', Psychological: 'Pszichológiai', Romance: 'Romantikus',
      'Sci-Fi': 'Sci-fi', 'Slice of Life': 'Hétköznapi', Sports: 'Sport', Supernatural: 'Természetfeletti',
      Thriller: 'Thriller'
    } as Record<string, string>,
    locale: 'hu-HU'
  },
  en: {
    formatum: '📺 Format', allapot: '📡 Status', szezon: '🗓️ Season', epizodok: '🎬 Episodes',
    pont: '⭐ Score', nepszeruseg: '👥 Popularity', studio: '🏢 Studio', forras: '📖 Source',
    mufajok: '🏷️ Genres', kovetkezo: '⏭️ Next episode', vetites: '📅 Aired',
    epizod: '🎬 Episode', hossz: '⏱️ Length', adas: '🗓️ Aired', errol: '📝 About this episode',
    resz: (n: string | number) => `Episode ${n}`,
    perc: (n: number) => `${n} min`,
    percReszenkent: (n: number) => `${n} min/ep`,
    elerheto: (van: number, ossz: number | null) => ossz ? `${van} / ${ossz} available` : `${van} available`,
    osszesen: (n: number) => `${n} episodes · none available yet`,
    ota: (d: string) => `since ${d}`,
    kezdes: (d: string) => `starts ${d}`,
    toltelek: 'filler', osszefoglalo: 'recap',
    felnott: '🔞 Adult title — the cover and synopsis are not shown on Discord.',
    megnezem: 'Watch', adatlap: 'Details', elozetes: 'Trailer',
    lablec: 'YUME • Anime • Community',
    format: {
      TV: 'TV', TV_SHORT: 'TV Short', MOVIE: 'Movie', SPECIAL: 'Special', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Music'
    } as Record<string, string>,
    statusz: {
      RELEASING: 'Airing', FINISHED: 'Finished', NOT_YET_RELEASED: 'Not yet aired',
      CANCELLED: 'Cancelled', HIATUS: 'Hiatus'
    } as Record<string, string>,
    evszak: { WINTER: 'Winter', SPRING: 'Spring', SUMMER: 'Summer', FALL: 'Fall' } as Record<string, string>,
    forrasok: {
      ORIGINAL: 'Original', MANGA: 'Manga', LIGHT_NOVEL: 'Light novel', VISUAL_NOVEL: 'Visual novel',
      VIDEO_GAME: 'Video game', OTHER: 'Other'
    } as Record<string, string>,
    mufaj: {} as Record<string, string>,
    locale: 'en-GB'
  }
}

export type Cimkek = typeof CIMKE.hu

export function cimkek (nyelv: Nyelv): Cimkek {
  return CIMKE[nyelv]
}

const STATUSZ_JEL: Record<string, string> = {
  RELEASING: '🟢', FINISHED: '✅', NOT_YET_RELEASED: '🕓', CANCELLED: '⛔', HIATUS: '⏸️'
}

// ---------------------------------------------------------------- szöveg

/** A katalógus leírásaiban előforduló nevesített HTML-entitások (mérve, élesben). */
const ENTITAS: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”',
  ldquo: '“', mdash: '—', ndash: '–', hellip: '…', eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à',
  acirc: 'â', auml: 'ä', iuml: 'ï', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', szlig: 'ß', deg: '°', bull: '•',
  dagger: '†', times: '×', mu: 'μ', micro: 'µ', rarr: '→'
}

const kodpont = (n: number): string | null =>
  Number.isInteger(n) && n > 0 && n <= 0x10FFFF && (n < 0xD800 || n > 0xDFFF) ? String.fromCodePoint(n) : null

/**
 * A katalógus szövege olvasható alakban: HTML nélkül, dekódolt entitásokkal.
 *
 * Az AniList-leírások HTML-t hoznak (`<br>`, `<i>`), a többi forrás
 * entitásokat (`&rsquo;`, `&#12300;` — élesben ötszáz leírásban). A Discord
 * egyiket sem érti: szó szerint kiírná.
 */
export function tisztaSzoveg (nyers: string | null | undefined): string {
  if (!nyers) return ''
  return nyers
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d{1,7});/g, (m, d: string) => kodpont(Number(d)) ?? m)
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h: string) => kodpont(parseInt(h, 16)) ?? m)
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITAS[n.toLowerCase()] ?? m)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * DISCORD-JELÖLÉS KIKAPCSOLÁSA egy katalógusszövegben.
 *
 * Egy cím vagy leírás `*`-a, `_`-ja dőlt betűt nyitna, a `<@…>` említésnek, a
 * `<t:…>` időpontnak, a `[x](y)` hivatkozásnak látszana — a szöveg nem a
 * miénk, tehát nem is formázhat. A sor eleji `#`, `>`, `-` fejléc, idézet,
 * lista volna.
 */
export function md (szoveg: string): string {
  return szoveg.replace(/([\\*_~`|<[])/g, '\\$1').replace(/^([#>-])/gm, '\\$1')
}

/** Szóhatáron vágás, „…"-val. A vágás a jelölés-kikapcsolás ELŐTT jön, hogy ne vágjon ketté egy `\*`-ot. */
export function vag (szoveg: string, hossz: number): string {
  if (szoveg.length <= hossz) return szoveg
  const vagott = szoveg.slice(0, Math.max(1, hossz - 1))
  const szokoz = vagott.lastIndexOf(' ')
  return (szokoz > hossz * 0.6 ? vagott.slice(0, szokoz) : vagott).trimEnd() + '…'
}

/**
 * Egy leírás Discord-alakja: tiszta szöveg, vágva, jelölés nélkül — és az
 * AniList spoiler-jelölése (`~!…!~`) Discord-spoiler lesz (`||…||`), nem
 * kitakaratlan szöveg.
 */
export function leirasDiscordra (nyers: string | null | undefined, hossz: number): string {
  const szoveg = vag(tisztaSzoveg(nyers), hossz)
  if (!szoveg) return ''
  return szoveg
    .split(/~!([\s\S]*?)(?:!~|$)/)
    .map((darab, i) => i % 2 === 1 ? (darab.trim() ? `||${md(darab)}||` : '') : md(darab))
    .join('')
}

// ---------------------------------------------------------------- képek, hivatkozások

/**
 * Abszolút képcím, vagy `null`. A relatív (`/media/…`) a nyilvános címhez
 * kötve; minden más (üres, séma nélküli, `//idegen/`) kimarad.
 */
export function abszolutKep (url: string | null | undefined): string | null {
  if (!url) return null
  if (/^https?:\/\/[^\s]+$/i.test(url)) return url
  if (url.startsWith('/') && !url.startsWith('//')) return YUME_URL + url
  return null
}

/**
 * A kép kimenő címe. A forrásadatbázis „nincs kép" helyőrzője (`no_pic.png`,
 * élesben 178 borító) nem kép — az a hely üresen marad.
 */
function kep (forras: string | null, tukor: string | null): string | null {
  if (forras && /\/no_pic\.png(?:$|\?)/i.test(forras)) return null
  return abszolutKep(imageUrl(forras, tukor))
}

/**
 * A YouTube-videó azonosítója a tárolt hivatkozásból. A katalógusban nem
 * egységes (mérve: puszta azonosító, teljes cím, `…&t=1s`, `…/0.jpg`,
 * záró szóköz); ami nem ad ki pontosan tizenegy jelet, az nem előzetes.
 */
export function youtubeId (ref: string | null | undefined): string | null {
  const m = /(?:[?&]v=|youtu\.be\/|\/embed\/|^)([A-Za-z0-9_-]{11})(?=$|[&?#/])/.exec((ref ?? '').trim())
  return m ? m[1]! : null
}

export const adatlapUrl = (animeId: string): string => `${YUME_URL}/#/anime/${animeId}`
export const nezesUrl = (episodeId: string): string => `${YUME_URL}/#/watch/${episodeId}`

/** A borító uralkodó színe az embed szélén; ha nincs, a YUME színe. */
export function kartyaSzin (hex: string | null | undefined): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '')
  return m ? parseInt(m[1]!, 16) : SZIN
}

// ---------------------------------------------------------------- betöltés

export interface AnimeCard {
  id: string
  cim: string
  romaji: string | null
  english: string | null
  native: string | null
  leiras: string | null
  format: string | null
  status: string | null
  season: string | null
  ev: number | null
  kezdes: string | null
  vege: string | null
  /** A tervezett részek száma (a forrásból) — lehet ismeretlen. */
  epizodok: number | null
  /** Részenkénti hossz, percben. */
  hossz: number | null
  felnott: boolean
  forras: string | null
  /** 0–100. */
  pontszam: number | null
  nepszeruseg: number | null
  kovetkezoAt: Date | null
  kovetkezoEp: number | null
  /** Abszolút képcímek; felnőtt címnél mindig `null`. */
  borito: string | null
  banner: string | null
  szin: string | null
  mufajok: string[]
  studiok: string[]
  /** YouTube-azonosító; `null`, ha nincs, vagy ha az előzetes ki van kapcsolva. */
  elozetes: string | null
  /** A YUME-n nyilvános részek száma. */
  elerheto: number
  /** Az első nyilvános rész — a „Megnézem" gombhoz. */
  elsoResz: string | null
}

type Sor = Omit<AnimeCard, 'borito' | 'banner' | 'elozetes' | 'pontszam' | 'kovetkezoAt' | 'kovetkezoEp' | 'elsoResz'> & {
  pontszam: number | string | null
  kovetkezo_at: Date | null
  kovetkezo_ep: number | null
  elso_resz: string | null
  borito_forras: string | null
  borito_tukor: string | null
  banner_forras: string | null
  banner_tukor: string | null
  elozetes: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Az előzetes akkor mutatható, ha az oldalon is mindenkinek látszik. */
async function elozetesLatszik (): Promise<boolean> {
  try {
    const f = (await flags.load()).get('feature.trailers')
    // Hiányzó sor = nincs kapcsoló = be (ugyanaz, mint `flags.enabled`).
    return !f || (f.enabled && f.access === 'public')
  } catch {
    return false
  }
}

/**
 * CÍMEK TELJES ADATLAPJA — EGY LEKÉRDEZÉSBEN, a megadott sorrendben.
 *
 * A nevek, képek, műfajok, stúdiók és videók külön táblákban élnek;
 * al-lekérdezésekkel egyetlen kör, címenként öt külön kérdés helyett.
 *
 * `csakNyilvanos`: a parancsok csak nyilvános címet mutatnak; a
 * hírfolyam-előnézet (ami egy már kiválasztott részről szól) nem szűr.
 */
export async function animeCards (
  ids: string[],
  { csakNyilvanos = true }: { csakNyilvanos?: boolean } = {}
): Promise<AnimeCard[]> {
  const ervenyes = [...new Set(ids.filter(id => UUID.test(id)))]
  if (!ervenyes.length) return []
  const [sorok, elozetes] = await Promise.all([
    query<Sor>(
      `SELECT a.id, a.canonical_title AS cim, a.synopsis AS leiras,
              a.format::text AS format, a.status::text AS status, a.season::text AS season,
              a.season_year AS ev, a.start_date::text AS kezdes, a.end_date::text AS vege,
              a.episode_count AS epizodok, a.episode_duration AS hossz, a.is_adult AS felnott,
              a.source_material AS forras, a.average_score AS pontszam, a.popularity AS nepszeruseg,
              a.next_airing_at AS kovetkezo_at, a.next_airing_ep AS kovetkezo_ep,
              (SELECT t.title FROM anime_titles t WHERE t.anime_id = a.id AND t.kind = 'romaji')  AS romaji,
              (SELECT t.title FROM anime_titles t WHERE t.anime_id = a.id AND t.kind = 'english') AS english,
              (SELECT t.title FROM anime_titles t WHERE t.anime_id = a.id AND t.kind = 'native')  AS native,
              c.object_key AS borito_forras, c.mirror_key AS borito_tukor, c.dominant_color AS szin,
              b.object_key AS banner_forras, b.mirror_key AS banner_tukor,
              ARRAY(SELECT g.name FROM anime_genres ag JOIN genres g ON g.id = ag.genre_id
                     WHERE ag.anime_id = a.id ORDER BY g.name) AS mufajok,
              -- NÉVENKÉNT EGYSZER (a fő stúdió írásmódjával): a cégtáblában ugyanaz
              -- a stúdió több sorban is áll (üres országkóddal az egyediség nem
              -- véd) — élesben 7909 címnél ismétlődött („WIT STUDIO, WIT STUDIO").
              ARRAY(SELECT s.name FROM (
                      SELECT (array_agg(co.name ORDER BY ac.is_main DESC, co.name))[1] AS name,
                             bool_or(ac.is_main) AS fo
                        FROM anime_companies ac JOIN companies co ON co.id = ac.company_id
                       WHERE ac.anime_id = a.id AND ac.role = 'studio'
                       GROUP BY lower(co.name)) s
                     ORDER BY s.fo DESC, s.name LIMIT 3) AS studiok,
              (SELECT v.ref FROM anime_videos v
                WHERE v.anime_id = a.id AND v.kind = 'trailer' AND v.provider = 'youtube'
                ORDER BY v.created_at, v.id LIMIT 1) AS elozetes,
              (SELECT count(*)::int FROM episodes e WHERE e.anime_id = a.id AND e.visibility = 'public') AS elerheto,
              (SELECT e.id FROM episodes e WHERE e.anime_id = a.id AND e.visibility = 'public'
                ORDER BY e.number LIMIT 1) AS elso_resz
         FROM anime a
         LEFT JOIN LATERAL (
           SELECT i.object_key, i.mirror_key, i.dominant_color FROM anime_images i
            WHERE i.anime_id = a.id AND i.kind = 'cover' ORDER BY i.is_primary DESC, i.created_at LIMIT 1) c ON true
         LEFT JOIN LATERAL (
           SELECT i.object_key, i.mirror_key FROM anime_images i
            WHERE i.anime_id = a.id AND i.kind = 'banner' ORDER BY i.is_primary DESC, i.created_at LIMIT 1) b ON true
        WHERE a.id = ANY($1::uuid[]) AND (NOT $2::boolean OR a.visibility = 'public')`,
      [ervenyes, csakNyilvanos]),
    elozetesLatszik()
  ])

  const szerint = new Map(sorok.map(s => {
    const felnott = s.felnott === true
    const pont = s.pontszam === null ? null : Number(s.pontszam)
    const kartya: AnimeCard = {
      id: s.id,
      cim: s.cim,
      romaji: s.romaji,
      english: s.english,
      native: s.native,
      leiras: s.leiras,
      format: s.format,
      status: s.status,
      season: s.season,
      ev: s.ev,
      kezdes: s.kezdes,
      vege: s.vege,
      epizodok: s.epizodok,
      hossz: s.hossz,
      felnott,
      forras: s.forras,
      pontszam: pont !== null && Number.isFinite(pont) && pont > 0 ? pont : null,
      nepszeruseg: s.nepszeruseg,
      kovetkezoAt: s.kovetkezo_at,
      kovetkezoEp: s.kovetkezo_ep,
      borito: felnott ? null : kep(s.borito_forras, s.borito_tukor),
      banner: felnott ? null : kep(s.banner_forras, s.banner_tukor),
      szin: s.szin,
      mufajok: s.mufajok ?? [],
      studiok: s.studiok ?? [],
      elozetes: elozetes ? youtubeId(s.elozetes) : null,
      elerheto: s.elerheto ?? 0,
      elsoResz: s.elso_resz
    }
    return [s.id, kartya] as const
  }))
  return ervenyes.map(id => szerint.get(id)).filter((k): k is AnimeCard => Boolean(k))
}

export async function animeCard (id: string, o: { csakNyilvanos?: boolean } = {}): Promise<AnimeCard | undefined> {
  return (await animeCards([id], o))[0]
}

// ---------------------------------------------------------------- építőelemek

export interface Mezo { name: string, value: string, inline: boolean }

/** Egy dátum (`YYYY-MM-DD`) a néző nyelvén, a nap nélkül is értelmesen. */
export function datum (iso: string | null | undefined, nyelv: Nyelv): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '')
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return new Intl.DateTimeFormat(CIMKE[nyelv].locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d)
}

export const szam = (n: number, nyelv: Nyelv): string => n.toLocaleString(CIMKE[nyelv].locale)

/** A Discord időpont-jelölője: a néző SAJÁT időzónájában és nyelvén jelenik meg. */
export const ido = (d: Date | string, stilus: 'R' | 'F' | 'f' | 'D' | 't'): string =>
  `<t:${Math.floor(new Date(d).getTime() / 1000)}:${stilus}>`

/** A másodlagos címek — ami tényleg más, mint a kanonikus. */
export function masodlagosCimek (k: Pick<AnimeCard, 'cim' | 'native' | 'english' | 'romaji'>): string[] {
  return [
    k.native,
    k.english && k.english !== k.cim ? k.english : null,
    k.romaji && k.romaji !== k.cim && k.romaji !== k.english ? k.romaji : null
  ].filter((c): c is string => Boolean(c))
}

export function formatumSzoveg (k: Pick<AnimeCard, 'format' | 'hossz'>, nyelv: Nyelv): string | null {
  const c = CIMKE[nyelv]
  const fmt = k.format ? (c.format[k.format] ?? k.format) : null
  return [fmt, k.hossz ? c.percReszenkent(k.hossz) : null].filter(Boolean).join(' · ') || null
}

export function allapotSzoveg (status: string | null, nyelv: Nyelv): string | null {
  if (!status) return null
  return `${STATUSZ_JEL[status] ?? ''} ${CIMKE[nyelv].statusz[status] ?? status}`.trim()
}

export function szezonSzoveg (k: Pick<AnimeCard, 'season' | 'ev'>, nyelv: Nyelv): string | null {
  if (k.season && k.ev) return `${CIMKE[nyelv].evszak[k.season] ?? k.season} ${k.ev}`
  return k.ev ? String(k.ev) : null
}

export function epizodSzoveg (k: Pick<AnimeCard, 'elerheto' | 'epizodok'>, nyelv: Nyelv): string | null {
  const c = CIMKE[nyelv]
  if (k.elerheto > 0) return c.elerheto(k.elerheto, k.epizodok)
  return k.epizodok ? c.osszesen(k.epizodok) : null
}

export const pontSzoveg = (pont: number | null): string | null => pont === null ? null : `${Math.round(pont)}%`

export function mufajSzoveg (mufajok: string[], nyelv: Nyelv): string | null {
  const c = CIMKE[nyelv]
  return mufajok.length ? mufajok.map(g => md(c.mufaj[g] ?? g)).join(' · ') : null
}

function vetitesSzoveg (k: AnimeCard, nyelv: Nyelv): string | null {
  const c = CIMKE[nyelv]
  const tol = datum(k.kezdes, nyelv)
  const ig = datum(k.vege, nyelv)
  if (tol && ig) return tol === ig ? tol : `${tol} – ${ig}`
  if (!tol) return null
  return k.status === 'NOT_YET_RELEASED' ? c.kezdes(tol) : c.ota(tol)
}

/** Egy sor a tények közül: „📺 TV · 🗓️ Ősz 2024 · 🎬 12 / 24 elérhető · ⭐ 82%". */
export function tenyekSora (k: AnimeCard, nyelv: Nyelv): string {
  const c = CIMKE[nyelv]
  return [
    k.format ? `📺 ${c.format[k.format] ?? k.format}` : null,
    szezonSzoveg(k, nyelv) ? `🗓️ ${szezonSzoveg(k, nyelv)}` : null,
    epizodSzoveg(k, nyelv) ? `🎬 ${epizodSzoveg(k, nyelv)}` : null,
    k.pontszam !== null ? `⭐ ${pontSzoveg(k.pontszam)}` : null
  ].filter(Boolean).join(' · ')
}

/** A következő adás, ha a jövőben van. */
export function kovetkezoSzoveg (k: Pick<AnimeCard, 'kovetkezoAt' | 'kovetkezoEp'>, nyelv: Nyelv, most = new Date()): string | null {
  if (!k.kovetkezoAt || new Date(k.kovetkezoAt) <= most) return null
  return `${k.kovetkezoEp ? `**${CIMKE[nyelv].resz(k.kovetkezoEp)}** · ` : ''}${ido(k.kovetkezoAt, 'F')} (${ido(k.kovetkezoAt, 'R')})`
}

/** A cím adatmezői — csak ami van. */
export function adatMezok (k: AnimeCard, nyelv: Nyelv, { most = new Date(), kovetkezo = true }: { most?: Date, kovetkezo?: boolean } = {}): Mezo[] {
  const c = CIMKE[nyelv]
  const mezok: Mezo[] = []
  const tesz = (name: string, value: string | null, inline = true): void => {
    if (value) mezok.push({ name, value: value.slice(0, 1024), inline })
  }
  tesz(c.formatum, formatumSzoveg(k, nyelv))
  tesz(c.allapot, allapotSzoveg(k.status, nyelv))
  tesz(c.szezon, szezonSzoveg(k, nyelv))
  tesz(c.epizodok, epizodSzoveg(k, nyelv))
  tesz(c.pont, pontSzoveg(k.pontszam))
  tesz(c.nepszeruseg, k.nepszeruseg ? szam(k.nepszeruseg, nyelv) : null)
  tesz(c.studio, k.studiok.length ? k.studiok.map(md).join(', ') : null)
  tesz(c.forras, k.forras ? (c.forrasok[k.forras] ?? null) : null)
  tesz(c.vetites, vetitesSzoveg(k, nyelv))
  tesz(c.mufajok, mufajSzoveg(k.mufajok, nyelv), false)
  if (kovetkezo) tesz(c.kovetkezo, kovetkezoSzoveg(k, nyelv, most), false)
  return mezok
}

export interface Gomb { label: string, url: string, emoji?: string }

/** A cím hivatkozásgombjai: Megnézem (ha van rész), Adatlap, Előzetes (ha van). */
export function animeGombok (k: AnimeCard, nyelv: Nyelv, { nezes = true }: { nezes?: boolean } = {}): Gomb[] {
  const c = CIMKE[nyelv]
  const gombok: Gomb[] = []
  if (nezes && k.elsoResz) gombok.push({ label: c.megnezem, url: nezesUrl(k.elsoResz), emoji: '▶️' })
  gombok.push({ label: c.adatlap, url: adatlapUrl(k.id), emoji: '📖' })
  if (k.elozetes) gombok.push({ label: c.elozetes, url: `https://www.youtube.com/watch?v=${k.elozetes}`, emoji: '🎞️' })
  return gombok
}

/** Hivatkozásgombok egy sorban (legföljebb öt — a Discord korlátja). */
export function gombSor (gombok: Gomb[]): Record<string, unknown> {
  return {
    type: 1,
    components: gombok.slice(0, 5).map(g => ({
      type: 2, style: 5, label: g.label.slice(0, 80), url: g.url,
      ...(g.emoji ? { emoji: { name: g.emoji } } : {})
    }))
  }
}

// ---------------------------------------------------------------- embedek

export interface KartyaOpciok {
  /** Az `author` sor („YUME • Véletlen választás"). */
  szerzo?: string
  /** A leírás hossza; 0 = leírás nélkül. */
  leirasHossz?: number
  /** A banner nagy képként az embed alján. */
  banner?: boolean
  /** Egy bekezdés a leírás elé (pl. a /watchlist add kérdése). */
  elotag?: string
  most?: Date
}

/**
 * A TELJES KÁRTYA: borító kicsiben, banner nagyban, másodlagos címek,
 * leírás, és minden adat, ami van.
 */
export function animeEmbed (k: AnimeCard, nyelv: Nyelv, o: KartyaOpciok = {}): Record<string, unknown> {
  const c = CIMKE[nyelv]
  const alcimek = masodlagosCimek(k)
  const leiras = k.felnott ? '' : leirasDiscordra(k.leiras, o.leirasHossz ?? 700)
  const description = [
    o.elotag ?? null,
    alcimek.length ? `*${alcimek.map(a => md(vag(a, 120))).join(' · ')}*` : null,
    k.felnott ? c.felnott : null,
    leiras || null
  ].filter(Boolean).join('\n\n')

  return {
    color: kartyaSzin(k.felnott ? null : k.szin),
    ...(o.szerzo ? { author: { name: o.szerzo.slice(0, 250), icon_url: IKON, url: YUME_URL } } : {}),
    title: vag(k.cim, 250),
    url: adatlapUrl(k.id),
    ...(description ? { description: description.slice(0, 4000) } : {}),
    fields: adatMezok(k, nyelv, o.most ? { most: o.most } : {}),
    ...(k.borito ? { thumbnail: { url: k.borito } } : {}),
    ...(o.banner && k.banner ? { image: { url: k.banner } } : {}),
    footer: { text: c.lablec }
  }
}

export interface KompaktOpciok {
  /** A cím helyett (pl. „Cím — 7. rész"). */
  cim?: string
  url?: string
  /** Sorok a tények elé (pl. az adás időpontja). */
  sorok?: Array<string | null>
  /** A leírás hossza; 0 = leírás nélkül. */
  leirasHossz?: number
}

/**
 * A KIS KÁRTYA — listákhoz (keresés, menetrend, friss részek): borító
 * kicsiben, egy sor tény, két-három sor leírás. Öt ilyen fér kényelmesen egy
 * üzenetbe (a Discord korlátja tíz embed és 6000 karakter).
 */
export function animeKompakt (k: AnimeCard, nyelv: Nyelv, o: KompaktOpciok = {}): Record<string, unknown> {
  const leiras = k.felnott ? '' : leirasDiscordra(k.leiras, o.leirasHossz ?? 180)
  const description = [
    ...(o.sorok ?? []),
    tenyekSora(k, nyelv) || null,
    leiras || null
  ].filter(Boolean).join('\n')
  return {
    color: kartyaSzin(k.felnott ? null : k.szin),
    title: vag(o.cim ?? k.cim, 250),
    url: o.url ?? adatlapUrl(k.id),
    ...(description ? { description: description.slice(0, 1500) } : {}),
    ...(k.borito ? { thumbnail: { url: k.borito } } : {})
  }
}

// ---------------------------------------------------------------- epizód

export interface EpizodAdat {
  id: string
  /** „7", nem „7.0". */
  szam: string
  cim: string | null
  leiras: string | null
  /** Abszolút képcím, vagy `null`. */
  kep: string | null
  adas: Date | null
  hossz: number | null
  filler: boolean
  recap: boolean
}

/** Egy rész a hozzá tartozó címmel (a /next, a hírfolyam és a DM kártyája). */
export async function episodeWithAnime (
  episodeId: string,
  o: { csakNyilvanos?: boolean } = {}
): Promise<{ ep: EpizodAdat, anime: AnimeCard } | undefined> {
  if (!UUID.test(episodeId)) return undefined
  const [e] = await query<{
    id: string, anime_id: string, szam: string, cim: string | null, leiras: string | null,
    kep: string | null, adas: Date | null, hossz: number | null, filler: boolean, recap: boolean
  }>(
    `SELECT e.id, e.anime_id,
            CASE WHEN e.number = trunc(e.number) THEN trunc(e.number)::int::text ELSE e.number::text END AS szam,
            e.title AS cim, e.synopsis AS leiras, e.thumbnail_key AS kep, e.air_date AS adas,
            e.duration AS hossz, e.is_filler AS filler, e.is_recap AS recap
       FROM episodes e
      WHERE e.id = $1 AND (NOT $2::boolean OR e.visibility = 'public')`,
    [episodeId, o.csakNyilvanos ?? true])
  if (!e) return undefined
  const anime = await animeCard(e.anime_id, o)
  if (!anime) return undefined
  return {
    anime,
    ep: {
      id: e.id,
      szam: e.szam,
      cim: e.cim,
      leiras: e.leiras,
      kep: anime.felnott ? null : abszolutKep(e.kep),
      adas: e.adas,
      hossz: e.hossz,
      filler: e.filler,
      recap: e.recap
    }
  }
}

/** „**7. rész** / 24 · töltelékrész" */
export function epizodErtek (ep: EpizodAdat, k: AnimeCard, nyelv: Nyelv): string {
  const c = CIMKE[nyelv]
  return [
    `**${c.resz(ep.szam)}**${k.epizodok ? ` / ${k.epizodok}` : ''}`,
    ep.filler ? c.toltelek : null,
    ep.recap ? c.osszefoglalo : null
  ].filter(Boolean).join(' · ')
}
