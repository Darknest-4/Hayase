// Számokból olvasható szöveg, és képernyőpontokból számok.
//
// Semmi DOM. Ezek a függvények adják a felület MINDEN számított értékét — az
// időkijelzőt, a tekerés helyét, a hangerőt —, és pont ezért érdemes őket a
// felülettől külön tartani: itt elbukik egy elrontott kerekítés a tesztben,
// egy `<div>`-ben elrejtve nem bukna el sehol.

/**
 * Másodperc → `1:23` vagy `1:02:03`.
 *
 * Az óra csak akkor jelenik meg, ha van — egy huszonnégy perces rész
 * `0:24:13`-ként kiírva három karakterrel szélesebb kijelzőt kér, minden
 * haszon nélkül.
 */
export function formatTime (seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const pad = value => String(value).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/**
 * Hátralévő idő, előjellel: `-3:20`.
 *
 * Ismeretlen hossznál `null`, nem `-0:00`. Az élő adás és a még be nem
 * töltött metaadat ugyanígy néz ki, és egy hazug nulla rosszabb, mint egy
 * üres hely.
 */
export function formatRemaining (currentTime, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return null
  return `-${formatTime(Math.max(0, duration - (Number(currentTime) || 0)))}`
}

/** Képernyőolvasónak szánt időtartam: „1 óra 2 perc 3 másodperc". */
export function spokenTime (seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const parts = []
  const h = Math.floor(total / 3600)
  const m = Math.floor(total / 60) % 60
  const s = total % 60
  if (h) parts.push(`${h} óra`)
  if (m) parts.push(`${m} perc`)
  if (s || !parts.length) parts.push(`${s} másodperc`)
  return parts.join(' ')
}

/**
 * Egy vízszintes sávon belüli arány egy mutatóesemény x-koordinátájából.
 *
 * A `0`–`1` közé szorítás nem óvatoskodás: a fogás KÖZBEN az ujj kimehet a
 * sávról, és a böngésző akkor is küld eseményt. Enélkül egy lefelé csúsztatott
 * fogás negatív időre tekert.
 */
export function ratioFromPointer (clientX, rect) {
  if (!rect || !Number.isFinite(rect.width) || rect.width <= 0) return 0
  const x = (Number(clientX) || 0) - rect.left
  return Math.max(0, Math.min(1, x / rect.width))
}

/** Ugyanez függőlegesen — a hangerőcsúszkához. Fent az egy. */
export function ratioFromPointerY (clientY, rect) {
  if (!rect || !Number.isFinite(rect.height) || rect.height <= 0) return 0
  const y = (Number(clientY) || 0) - rect.top
  return Math.max(0, Math.min(1, 1 - y / rect.height))
}

/**
 * A pufferelt szakaszok arányban, a megjelenítéshez.
 *
 * A `buffered` egy `TimeRanges`: több, egymástól független szakasz. Több
 * tekerés után a videó eleje és közepe is be lehet töltve, és egyetlen sáv
 * kirajzolása ilyenkor hazudik.
 */
export function bufferedRanges (buffered, duration) {
  if (!buffered || !Number.isFinite(duration) || duration <= 0) return []
  const ranges = []
  for (let i = 0; i < buffered.length; i++) {
    const start = buffered.start(i) / duration
    const end = buffered.end(i) / duration
    if (end > start) ranges.push({ start: Math.max(0, start), end: Math.min(1, end) })
  }
  return ranges
}

/** Sebesség szövege: `1x`, `1.25x`. */
export function formatRate (rate) {
  const value = Number(rate) || 1
  return `${Number(value.toFixed(2))}x`
}
