// Jelöltek normalizálása és rangsorolása.
//
// Tiszta függvények, DOM nélkül — ez a modul csak adatot alakít adattá.
//
// AMIT A RÉGIBŐL ÁTHOZOK, ÉS MIÉRT. A mai `normalise` egy valódi, mért hibából
// tanult: `raw.url ?? raw.link` állt benne, miközben a bővítmény-homokozó
// MINDKÉT kulcsot kiküldi, és üres sztringet ír abba, amelyiket a bővítmény
// kihagyta. A `??` az üres sztringet JELENLÉVŐNEK veszi, tehát minden
// csak-link eredmény — vagyis minden torrent — üresre normalizálódott és
// eldobódott, hibaüzenet nélkül. A motor nulla jelöltet jelentett, és ez
// „nincs találat"-nak látszott, nem hibának.
//
// Ezért itt `||` van, és ezért van rá teszt.

/** A forrás fajtái, ahogy a katalógus tárolja őket. */
export const SOURCE_KIND = Object.freeze({
  DIRECT: 'direct',
  HLS: 'hls',
  DASH: 'dash',
  MAGNET: 'magnet',
  /**
   * IDEGEN LEJÁTSZÓ EGY KERETBEN — nem folyam.
   *
   * Nem a `classify()` adja: egy beágyazó lap címe semmiben nem különbözik
   * egy videófájlétól, tehát a címből nem látszik. A szerver mondja meg, és
   * a `normalise()` fogadja el tőle.
   */
  EMBED: 'embed',
  UNKNOWN: 'unknown'
})

/**
 * Mi ez a hivatkozás.
 *
 * Az AZONOS EREDETŰ ÚT (`/assets/videos/x.mp4`) szándékosan `direct`. A YUME
 * maga is kiszolgál videót, és ha csak a teljes URL számítana, a katalógusba a
 * tartománynevet kellene beírni — 364 064 sorba. Egy költözés (duckdns → saját
 * domain) mindet egyszerre törné el.
 *
 * A `//host/x.mp4` protokoll-relatív alak KIMARAD: az más kiszolgálóra mutat.
 */
export function classify (url) {
  const value = String(url ?? '')
  if (!value) return SOURCE_KIND.UNKNOWN
  if (value.startsWith('magnet:')) return SOURCE_KIND.MAGNET
  const path = value.split('?')[0].toLowerCase()
  if (path.endsWith('.m3u8')) return SOURCE_KIND.HLS
  if (path.endsWith('.mpd')) return SOURCE_KIND.DASH
  if (/^https?:/.test(value)) return SOURCE_KIND.DIRECT
  if (value.startsWith('/') && !value.startsWith('//')) return SOURCE_KIND.DIRECT
  return SOURCE_KIND.UNKNOWN
}

/** Felbontás a címből vagy a megadott mezőből. `null`, ha nem tudjuk. */
export function detectQuality (raw) {
  const declared = Number(raw?.quality ?? raw?.resolution)
  if (Number.isFinite(declared) && declared > 0) return declared
  const text = `${raw?.title ?? ''} ${raw?.url ?? ''}`
  const match = /\b(2160|1440|1080|720|540|480|360)p?\b/i.exec(text)
  return match ? Number(match[1]) : null
}

let autoId = 0

/**
 * Egy nyers rekord → jelölt.
 *
 * `null`, ha nincs benne használható hivatkozás. A hívó szűr, nem mi dobunk:
 * egy hibás rekord nem viheti magával a köteget.
 */
export function normalise (raw, source = {}) {
  if (!raw) return null
  // `||`, NEM `??` — lásd a fájl fejlécét. Ez a sor egy mért hiba javítása.
  const url = String(raw.url || raw.link || raw.ref || '').trim()
  if (!url) return null

  /*
   * A BEJELENTETT `embed` FELÜLÍRJA A CÍMBŐL VALÓ FELISMERÉST.
   *
   * A `classify()` egy `https://...` címet `direct`-nek vesz, és a natív
   * motor egy HTML-lapot töltene a `<video>`-ba — néma fekete doboz. A
   * beágyazás tényét csak a szerver tudja, tehát tőle fogadjuk el.
   *
   * CSAK EZ AZ EGY FAJTA JÖHET KÍVÜLRŐL. A néző által beillesztett rekord
   * nem hordoz `kind` mezőt, tehát ezen az úton nem lehet tetszőleges címet
   * `iframe`-be juttatni; a tényleges kapu a szerver `embed-url.ts`-e.
   */
  const kind = raw.kind === SOURCE_KIND.EMBED ? SOURCE_KIND.EMBED : classify(url)
  return {
    id: raw.id ?? `cand-${++autoId}`,
    url,
    kind,
    title: raw.title ?? source.name ?? null,
    provider: raw.provider ?? source.slug ?? null,
    quality: detectQuality(raw),
    variant: raw.variant ?? null,
    audioLang: raw.audioLang ?? raw.language ?? null,
    isBatch: Boolean(raw.isBatch ?? raw.is_batch),
    sizeBytes: Number(raw.sizeBytes ?? raw.size_bytes) || null,
    seeders: Number(raw.seeders) || null,
    subtitles: Array.isArray(raw.subtitles) ? raw.subtitles : [],
    accuracy: source.accuracy ?? raw.accuracy ?? 'medium',
    /** Honnan jött: a katalógusból vagy a néző beillesztéséből. */
    origin: raw.origin ?? 'registered'
  }
}

const ACCURACY_SCORE = { high: 30, medium: 15, low: 0 }
const VARIANT_MATCH = 40

/**
 * Egy jelölt pontszáma a néző beállításai szerint. Nagyobb = előrébb.
 *
 * A REGISZTRÁLT FORRÁS ELŐRÉBB, mint a beillesztett. Nem önkényes: azt valaki,
 * aki ezt az oldalt üzemelteti, kézzel akasztotta ehhez a részhez — erősebb
 * állítás arról, hogy „ez a helyes videó", mint egy egyszer bemásolt szöveg.
 */
export function score (candidate, prefs = {}) {
  let points = 0

  if (candidate.origin === 'registered') points += 100

  // Sub/dub: ha a néző kért valamit, az egyezés sokat ér; a `any` nem büntet.
  if (prefs.variant && prefs.variant !== 'any' && candidate.variant) {
    points += candidate.variant === prefs.variant ? VARIANT_MATCH : -VARIANT_MATCH
  }

  // Felbontás: a kért MAXIMUM alatt a nagyobb jobb, fölötte nem érdekel.
  if (candidate.quality) {
    const cap = Number(prefs.maxQuality) || Infinity
    points += candidate.quality <= cap
      ? candidate.quality / 100
      : -10 // a néző korlátja fölött: hátrébb, de nem kizárva
  }

  points += ACCURACY_SCORE[candidate.accuracy] ?? 0

  // A kötegelt kiadás egy epizódhoz rosszabb találat: a néző egy részt akar.
  if (candidate.isBatch) points -= 20

  // A magnet böngészőben nem játszható — utolsónak, de nem eldobva: egy
  // asztali kliens még elviheti.
  if (candidate.kind === SOURCE_KIND.MAGNET) points -= 1000
  if (candidate.kind === SOURCE_KIND.UNKNOWN) points -= 2000

  return points
}

/** Rangsorolt lista. Stabil: azonos pontszámnál a beérkezési sorrend marad. */
export function rank (candidates, prefs = {}) {
  return candidates
    .map((candidate, index) => ({ candidate, index, points: score(candidate, prefs) }))
    .sort((a, b) => (b.points - a.points) || (a.index - b.index))
    .map(entry => entry.candidate)
}
