/**
 * AZ EMBEDEK KÖZÖS ÉPÍTŐELEMEI.
 *
 * MIT TUD EGY DISCORD EMBED, ÉS MIT NEM. A tervrajzok egy böngészőben
 * rajzolt felületet mutatnak; a Discord embed ennél szűkebb: nincs saját
 * betűtípus, nincs rács, nincs oszlopdiagram. Ami VAN, és amiből ez a modul
 * dolgozik:
 *
 *   * `author` — egy sor ikonnal, ez lesz a fejléc;
 *   * `title` + `description` — a cím és az alcím;
 *   * `fields` — soronként legföljebb HÁROM `inline` mező; ez a rács;
 *   * `thumbnail` / `image` — borító és banner;
 *   * `footer` — a záró sor;
 *   * `components` — GOMBOK, külön az embedtől. Ezek valódiak, nem rajzok.
 *
 * Az oszlopdiagram blokk-karakterekből áll (`▁▂▃▄▅▆▇█`). Nem szép, de
 * ŐSZINTE: a magasságok a valódi számokból jönnek.
 *
 * NINCS RENDERELÉSKORI IDŐBÉLYEG, és ez nem feledékenység. Egy „Frissítve:
 * 19:22" sor MINDEN renderelésnél más lenne, az ujjlenyomat is, és a bot
 * percenként módosítaná az üzenetet — napi több ezer fölösleges hívás. A
 * frissesség nem vész el: a Discord maga jelzi a „szerkesztve" bélyeggel.
 */

/** A YUME arcszíne. */
export const SZIN = 0xE4_1E_63

const YUME_URL = process.env.PUBLIC_URL ?? 'https://animehub.hu'
const DASHBOARD_URL = process.env.DISCORD_DASHBOARD_URL ?? 'https://discord.animehub.hu'
const IKON = process.env.DISCORD_EMBED_ICON ?? `${YUME_URL}/assets/yume.svg`

/**
 * A FEJLÉC.
 *
 * Az `author` sor az egyetlen hely, ahová ikon és szöveg egy sorba kerül —
 * a tervrajzok fejléce ezért ide képződik le.
 */
export function fejlec (szakasz: string): Record<string, unknown> {
  return { name: `YUME • ${szakasz}`, icon_url: IKON, url: YUME_URL }
}

/** A záró sor. Mindenhol ugyanaz, hogy egy szerveren egységes legyen. */
export const LABLEC = { text: 'YUME • Anime • Közösség' }

/**
 * EGY MEZŐ A RÁCSBAN.
 *
 * A NULLA ÉS A „NINCS ADAT" NEM UGYANAZ. Egy friss telepítésen a „0
 * megtekintés" azt állítaná, hogy mérünk és senki nem jött — pedig még nem
 * mérünk. Ezért `—` az alapértelmezés.
 */
export function mezo (
  cimke: string,
  ertek: number | string | null | undefined,
  extra?: string | null,
  inline = true
): Record<string, unknown> {
  const szam = ertek === null || ertek === undefined
    ? '—'
    : typeof ertek === 'number' ? ertek.toLocaleString('hu-HU') : String(ertek)
  return {
    name: cimke,
    value: extra ? `**${szam}**\n${extra}` : `**${szam}**`,
    inline
  }
}

/**
 * VÁLTOZÁS JELZÉSE — nyíllal.
 *
 * `null`-ra nem ír semmit: ha nincs mihez hasonlítani, egy „0%" azt
 * állítaná, hogy mértük, és nem változott.
 */
export function trend (valtozas: number | null, utotag = ''): string | null {
  if (valtozas === null || !Number.isFinite(valtozas)) return null
  if (valtozas === 0) return `→ 0${utotag}`
  return `${valtozas > 0 ? '↗' : '↘'} ${valtozas > 0 ? '+' : ''}${valtozas.toLocaleString('hu-HU')}${utotag}`
}

/** Üres sor a rácsban — a Discord hármasával tördel, ez tölti ki a sort. */
export function toltelek (): Record<string, unknown> {
  return { name: '​', value: '​', inline: true }
}

/**
 * OSZLOPDIAGRAM BLOKK-KARAKTEREKBŐL.
 *
 * Nyolc magasság áll rendelkezésre. A legnagyobb érték a teljes magasság;
 * a nulla külön jel (`·`), mert egy `▁` azt sugallná, hogy volt valamennyi.
 */
const BLOKKOK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

export function oszlopok (ertekek: number[]): string {
  if (!ertekek.length) return '—'
  const csucs = Math.max(...ertekek)
  if (csucs <= 0) return ertekek.map(() => '·').join(' ')
  return ertekek
    .map(v => v <= 0 ? '·' : BLOKKOK[Math.min(BLOKKOK.length - 1, Math.floor((v / csucs) * (BLOKKOK.length - 1)))]!)
    .join(' ')
}

/** A hét napjai a diagram alá, ugyanabban a szélességben. */
export const NAPOK = ['H', 'K', 'Sz', 'Cs', 'P', 'Sz', 'V']

/**
 * GOMBOK.
 *
 * Ezek VALÓDI Discord-komponensek, nem rajzok — és mivel mind hivatkozás,
 * nincs mögöttük interakció, amit kezelni kellene. Statikusak, tehát az
 * ujjlenyomatot sem mozgatják.
 */
export function gombok (
  elemek: Array<{ label: string, url: string, emoji?: string }>
): unknown[] {
  if (!elemek.length) return []
  return [{
    type: 1,
    components: elemek.slice(0, 5).map(g => ({
      type: 2,
      style: 5, // LINK
      label: g.label.slice(0, 80),
      url: g.url,
      ...(g.emoji ? { emoji: { name: g.emoji } } : {})
    }))
  }]
}

/** A vezérlőpultra és az oldalra mutató szokásos gombpár. */
export function alapGombok (extra: Array<{ label: string, url: string, emoji?: string }> = []): unknown[] {
  return gombok([
    ...extra,
    { label: 'YUME megnyitása', url: YUME_URL, emoji: '🌸' },
    { label: 'Vezérlőpult', url: DASHBOARD_URL, emoji: '⚙️' }
  ])
}

/** Egy embed köré a teljes üzenet. */
export function uzenet (embed: Record<string, unknown>, komponensek: unknown[] = []): unknown {
  return {
    embeds: [{ color: SZIN, footer: LABLEC, ...embed }],
    ...(komponensek.length ? { components: komponensek } : {}),
    // SOHA NEM EMLÍTÜNK SENKIT egy automatikus üzenetben.
    allowed_mentions: { parse: [] }
  }
}

/** Szöveg rövidítése a Discord korlátaihoz, szóhatáron. */
export function rovidit (szoveg: string | null | undefined, hossz: number): string {
  if (!szoveg) return ''
  const tiszta = szoveg
    // Az AniList leírásai HTML-t tartalmaznak; a Discord nem értelmezi.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (tiszta.length <= hossz) return tiszta
  const vagott = tiszta.slice(0, hossz - 1)
  const utolso = vagott.lastIndexOf(' ')
  return (utolso > hossz * 0.6 ? vagott.slice(0, utolso) : vagott).trimEnd() + '…'
}

export { YUME_URL, DASHBOARD_URL }
