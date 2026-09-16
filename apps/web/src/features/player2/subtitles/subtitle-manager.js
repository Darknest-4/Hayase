// Melyik feliratsáv legyen bekapcsolva.
//
// A mai lejátszó egy valódi hibát tanult meg: egy `<track>` `default` nélkül
// LETILTVA töltődik be. A forrás által adott felirat ott volt a DOM-ban, és
// láthatatlan maradt — nem hiányzott, csak nem látszott. Ezért a kiválasztás
// itt nem „hozzáadjuk a sávokat", hanem „megmondjuk, melyik legyen látható".

/** Nyelvi kód normalizálása: `hu-HU`, `hun`, `Hungarian` → `hu`. */
export function languageCode (value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text) return null
  const named = {
    hungarian: 'hu', magyar: 'hu', hun: 'hu',
    english: 'en', eng: 'en',
    japanese: 'ja', japán: 'ja', jpn: 'ja', jp: 'ja'
  }
  if (named[text]) return named[text]
  return text.split(/[-_]/)[0].slice(0, 3) || null
}

/**
 * Egy sáv pontszáma a néző kívánsága szerint. Nagyobb = jobb.
 *
 * A KÉNYSZERÍTETT (`forced`) sáv külön eset: az csak az idegen nyelvű
 * részeket felirátozza, és nem helyettesíti a teljes feliratot. Ha a néző
 * feliratot kért, a teljes verzió jár neki.
 */
export function scoreTrack (track, wanted) {
  if (!track) return -Infinity
  let points = 0
  const language = languageCode(track.language ?? track.lang)
  if (wanted && language === languageCode(wanted)) points += 100
  else if (language === 'en') points += 20 // értelmes második esély
  if (track.forced) points -= 50
  if (track.default) points += 10
  if (track.kind && track.kind !== 'subtitles' && track.kind !== 'captions') points -= 30
  return points
}

/**
 * A választott sáv, vagy `null`.
 *
 * `null` akkor is, ha vannak sávok, de a néző kikapcsolta a feliratot — ez nem
 * ugyanaz, mint a „nincs mit mutatni", és a felületnek is másképp kell
 * mutatnia.
 */
export function selectTrack (tracks = [], { language, enabled = true } = {}) {
  if (!enabled || !tracks.length) return null
  const ranked = tracks
    .map((track, index) => ({ track, index, points: scoreTrack(track, language) }))
    .sort((a, b) => (b.points - a.points) || (a.index - b.index))
  // Ha a legjobb is negatív (csak kényszerített sáv van, és nem is a kért
  // nyelven), inkább semmit: egy rossz nyelvű felirat zavaróbb, mint a hiánya.
  return ranked[0]?.points > 0 ? ranked[0].track : null
}

/**
 * A felirat megjelenésének CSS-változói.
 *
 * Változókat adunk vissza, nem stílust: a megjelenítés a CSS dolga, és így a
 * beállítás egy helyen lesz alkalmazva, nem elemenként.
 */
export function subtitleStyle (prefs = {}) {
  const size = Number(prefs['player.subtitle.size'] ?? 100)
  const opacity = Number(prefs['player.subtitle.backgroundOpacity'] ?? 0.35)
  return {
    '--yp-sub-size': `${Math.max(50, Math.min(200, size)) / 100}`,
    '--yp-sub-weight': String(prefs['player.subtitle.weight'] ?? 600),
    '--yp-sub-color': String(prefs['player.subtitle.color'] ?? '#ffffff'),
    '--yp-sub-bg': String(prefs['player.subtitle.background'] ?? '#000000'),
    '--yp-sub-bg-opacity': String(Math.max(0, Math.min(1, opacity))),
    '--yp-sub-outline': prefs['player.subtitle.outline'] === false ? '0' : '1',
    '--yp-sub-bottom': `${Math.max(0, Math.min(40, Number(prefs['player.subtitle.bottomOffset'] ?? 8)))}%`
  }
}
