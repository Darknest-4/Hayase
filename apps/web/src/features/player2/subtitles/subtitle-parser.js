// Feliratok beolvasása — és ez BIZTONSÁGI modul, nem formátumkérdés.
//
// A felirat IDEGEN TARTALOM. A forrással érkezik, és a forrást nem mi írjuk.
// Egy `<img src=x onerror=…>` egy feliratsorban pontosan olyan
// szkriptbeszúrás, mint bárhol máshol — a 43. pont ezt külön ki is mondja.
//
// Ezért itt SOHA nem keletkezik HTML. A kimenet sima szöveg, és a megjelenítő
// `textContent`-be teszi. A WebVTT megenged néhány címkét (`<i>`, `<b>`,
// `<c.classname>`); ezeket ELDOBJUK, nem értelmezzük. Egy dőlt betűs felirat
// kevesebbet ér, mint egy biztonságos.

/** Időbélyeg → másodperc. `HH:MM:SS,mmm` és `MM:SS.mmm` is. */
export function parseTimestamp (text) {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(String(text ?? '').trim())
  if (!match) return null
  const [, h, m, s, ms] = match
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000
}

/**
 * Minden címke eltávolítása.
 *
 * Nem „a veszélyeseké" — MINDENÉ. Egy engedélyezőlista kis felület, de akkor is
 * felület; egy felirat megjelenítéséhez pedig nem kell egyetlen címke sem.
 */
export function stripMarkup (text) {
  return String(text ?? '')
    .replace(/<[^>]*>/g, '')
    // ASS/SSA felülbíráló blokkok — `{\an8}`, `{\pos(320,240)}`. Az .srt
    // fájlok fele tele van velük, mert egy konvertált feliratban bennmaradnak.
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    // A második menet azért kell, mert az entitás-visszafejtés ÚJ címkéket
    // hozhat elő: a `&lt;script&gt;` az első lépés után `<script>` lenne.
    .replace(/<[^>]*>/g, '')
    .trim()
}

/**
 * SRT vagy WebVTT → jelzéslista.
 *
 * Egy hibás blokk nem viszi magával a fájlt: átugorjuk. Egy felirat, aminek a
 * fele hiányzik, még mindig jobb, mint a semmi.
 */
export function parseSubtitles (text) {
  const body = String(text ?? '').replace(/\r\n?/g, '\n').replace(/^﻿/, '')
  const cues = []

  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean)
    if (!lines.length) continue
    if (/^WEBVTT/i.test(lines[0])) continue // fejléc

    const timingIndex = lines.findIndex(line => line.includes('-->'))
    if (timingIndex === -1) continue

    const [rawStart, rawEnd] = lines[timingIndex].split('-->').map(part => part.trim().split(/\s+/)[0])
    const start = parseTimestamp(rawStart)
    const end = parseTimestamp(rawEnd)
    if (start === null || end === null || end <= start) continue

    const content = stripMarkup(lines.slice(timingIndex + 1).join('\n'))
    if (!content) continue
    cues.push({ start, end, text: content })
  }

  return cues.sort((a, b) => a.start - b.start)
}

/**
 * Jelzések → WebVTT szöveg.
 *
 * A böngésző `<track>`-je VTT-t vár, az interneten viszont az SRT a
 * gyakoribb. Az átalakítás a beolvasáson KERESZTÜL megy, nem szövegcserével —
 * így a kimenetben biztosan nincs címke, akármi volt a bemenetben.
 */
export function toVtt (cues) {
  const stamp = seconds => {
    const total = Math.max(0, Number(seconds) || 0)
    const h = String(Math.floor(total / 3600)).padStart(2, '0')
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
    const s = String(Math.floor(total % 60)).padStart(2, '0')
    const ms = String(Math.round((total % 1) * 1000)).padStart(3, '0')
    return `${h}:${m}:${s}.${ms}`
  }
  return ['WEBVTT', '', ...cues.flatMap(cue =>
    [`${stamp(cue.start)} --> ${stamp(cue.end)}`, cue.text, ''])].join('\n')
}

/** Késleltetés alkalmazása. Negatív érték előrehozza a feliratot. */
export function shift (cues, delayMs = 0) {
  const delta = (Number(delayMs) || 0) / 1000
  if (!delta) return cues
  return cues
    // A kezdés nem csúszhat nulla alá: egy negatív időbélyeg nem jelent
    // semmit, és a jelzés attól még látszik — csak hamarabb kezdődik, mint a
    // videó. A vége dönti el, hogy megmarad-e egyáltalán.
    .map(cue => ({ ...cue, start: Math.max(0, cue.start + delta), end: cue.end + delta }))
    .filter(cue => cue.end > 0)
}
