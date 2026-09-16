/* global fetch, Blob, URL */
// Külső feliratfájl betöltése.
//
// MIÉRT KELL EZ EGYÁLTALÁN: a böngésző `<track>` eleme CSAK WebVTT-t ért. Az
// interneten viszont az SRT a gyakoribb formátum, és egy `.srt`-re mutató
// `<track src>` némán semmit nem csinál — nincs hibaesemény, nincs üzenet,
// csak nincs felirat. Ezért a fájlt magunk kérjük le, beolvassuk, VTT-re
// alakítjuk, és egy `blob:` címen adjuk a `<track>`-nek.
//
// A BEOLVASÁSON ÁTVEZETÉS a biztonsági része is: a kimenet a saját
// előállításunk, nem a letöltött szöveg. Akármi volt a fájlban, a `<track>`
// címke nélküli szöveget kap.

import { parseSubtitles, shift, toVtt } from './subtitle-parser.js'

/** Ennél nagyobb feliratfájlt nem olvasunk be. Egy rész felirata pár tíz kilobájt. */
export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024

/**
 * Egy feliratsáv `blob:` címe.
 *
 * @param {object} track `{ url, delayMs }`
 * @param {object} options `fetch`, `signal`
 * @returns {Promise<{url: string, cues: Array, revoke: function}|null>}
 */
export async function loadSubtitleTrack (track, options = {}) {
  const url = track?.url ?? track?.src
  if (!url) return null

  const request = options.fetch ?? fetch
  const response = await request(url, { signal: options.signal })
  if (!response.ok) throw new Error(`a felirat nem tölthető le (${response.status})`)

  // A MÉRET KORLÁTOZÁSA egy `content-length` alapján: egy elrontott vagy
  // rosszindulatú cím mögött egy gigabájtos fájl is lehet, és azt beolvasni
  // annyi, mint megfagyasztani a lapot.
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > MAX_SUBTITLE_BYTES) {
    throw new Error('a feliratfájl túl nagy')
  }

  const text = await response.text()
  if (text.length > MAX_SUBTITLE_BYTES) throw new Error('a feliratfájl túl nagy')

  const cues = shift(parseSubtitles(text), Number(track.delayMs) || 0)
  if (!cues.length) return null

  const blob = new Blob([toVtt(cues)], { type: 'text/vtt' })
  const objectUrl = URL.createObjectURL(blob)
  return {
    url: objectUrl,
    cues,
    // A `blob:` cím a lapon marad, amíg vissza nem vonjuk. Részváltásonként
    // egy elfelejtett felirat pár tíz kilobájt; egy hosszú estén ez sok
    // részszer annyi, és senki nem veszi észre.
    revoke: () => { try { URL.revokeObjectURL(objectUrl) } catch { /* már nincs */ } }
  }
}
