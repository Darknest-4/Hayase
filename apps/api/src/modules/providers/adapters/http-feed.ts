// Általános HTTP-forrásadapter — konfigurálható, és MÁSOLHATÓ KIINDULÓPONT.
//
// KÉT DOLOGRA JÓ EGYSZERRE:
//
//   1. MŰKÖDIK, ahogy van. Beállítod a `providers.config`-ban, hogy honnan
//      kérdezzen, és onnantól valódi forrásokat szolgál — nincs benne egyetlen
//      kitalált cím sem.
//
//   2. VÁZ. Minden vízvezeték kész benne: időkorlát, a 4xx/5xx
//      megkülönböztetése, üres eredmény kontra kivétel, fejlécek, lejárat,
//      feliratok normalizálása. Ha a saját szolgáltatásod más alakban felel,
//      EGYETLEN függvényt kell kicserélned — a `normalize`-t.
//
// BEÁLLÍTÁS (`providers.config`, adminfelületről szerkeszthető):
//
//   {
//     "urlTemplate": "https://sajat.pelda/api/forras/{anilistId}/{episode}",
//     "timeoutMs": 6000,
//     "headers": { "X-Client": "yume" }
//   }
//
//   A sablon helyőrzői: {anilistId} {malId} {kitsuId} {anidbId} {episode}
//   {variant}. Ami nincs meg, arra a helyőrző üresen marad — ezért a sablonban
//   olyan azonosítót használj, amit a katalógusod tényleg ismer.
//
// BEÁLLÍTÁS NÉLKÜL NEM CSINÁL SEMMIT. Nincs `urlTemplate` → üres eredmény,
// egyetlen kérés nélkül. Ez nem hiba: „megkérdeztek, és nincs mit mondanom".
//
// TITOK NEM MEHET A `config`-ba — az adminfelület megjeleníti. Ha a
// szolgáltatásod hitelesítést kér, a kulcs környezeti változóból jöjjön, és
// SOHA ne kerüljön a `ProviderSource.headers`-be: az kimegy a böngészőnek.
//
// A VÁRT VÁLASZ (a `normalize` ezt olvassa):
//
//   {
//     "sources":   [ { "url", "kind", "variant", "label"?, "quality"?,
//                      "language"?, "headers"?, "expiresAt"? } ],
//     "subtitles": [ { "url", "language", "format"?, "kind"?, "isDefault"? } ]
//   }

import { noResult } from '../types.ts'

import type {
  AnimeProvider, EpisodeRef, ProviderEpisode, ProviderMatch, ProviderResult,
  ProviderSource, ProviderSubtitle, SourceKind, SourceVariant
} from '../types.ts'

const DEFAULT_TIMEOUT_MS = 6_000

const KINDS: SourceKind[] = ['hls', 'dash', 'mp4']
const VARIANTS: SourceVariant[] = ['sub', 'dub', 'raw']
const SUB_FORMATS = ['vtt', 'ass', 'srt'] as const

// `exactOptionalPropertyTypes`: a hiányzó kulcs és az `undefined` érték itt
// nem ugyanaz, ezért az `| undefined` kiírva.
interface Beallitas {
  urlTemplate?: string | undefined
  timeoutMs?: number | undefined
  headers?: Record<string, string> | undefined
}

function beallitas (config?: Record<string, unknown>): Beallitas {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  const c = config as Record<string, unknown>
  return {
    urlTemplate: typeof c.urlTemplate === 'string' ? c.urlTemplate : undefined,
    timeoutMs: typeof c.timeoutMs === 'number' && c.timeoutMs > 0 ? c.timeoutMs : undefined,
    headers: c.headers && typeof c.headers === 'object' && !Array.isArray(c.headers)
      ? c.headers as Record<string, string>
      : undefined
  }
}

/**
 * A cím összeállítása.
 *
 * A helyőrzők ÉRTÉKE URL-kódolva megy be. Enélkül egy furcsa karakter a
 * címben elrontaná az útvonalat — vagy rosszabb: kiléphetne belőle.
 */
function cim (sablon: string, ref: EpisodeRef): string {
  const ertekek: Record<string, string> = {
    anilistId: ref.anilistId != null ? String(ref.anilistId) : '',
    malId: ref.malId != null ? String(ref.malId) : '',
    kitsuId: ref.kitsuId != null ? String(ref.kitsuId) : '',
    anidbId: ref.anidbId != null ? String(ref.anidbId) : '',
    episode: String(ref.number),
    variant: ref.variant ?? ''
  }
  return sablon.replace(/\{(\w+)\}/g, (egesz, nev: string) =>
    nev in ertekek ? encodeURIComponent(ertekek[nev]!) : egesz)
}

/** Egy ismeretlen érték számmá — csak ha tényleg az. */
const szoveg = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * A szolgáltatás válaszának leképezése a YUME modelljére.
 *
 * EZT AZ EGY FÜGGVÉNYT KELL KICSERÉLNED, ha a saját szolgáltatásod más
 * alakban felel. Minden más marad.
 *
 * Amit nem ismerünk fel, azt KIHAGYJUK, nem találgatjuk: egy `variant` nélküli
 * forrás nem „valószínűleg sub", és egy ismeretlen `kind` nem „valószínűleg
 * mp4" — abból néma lejátszó lesz.
 */
function normalize (body: unknown): ProviderResult {
  if (!body || typeof body !== 'object') return noResult()
  const b = body as { sources?: unknown, subtitles?: unknown }

  const sources: ProviderSource[] = []
  for (const nyers of Array.isArray(b.sources) ? b.sources : []) {
    if (!nyers || typeof nyers !== 'object') continue
    const s = nyers as Record<string, unknown>
    const url = szoveg(s.url)
    const kind = szoveg(s.kind) as SourceKind | null
    const variant = szoveg(s.variant) as SourceVariant | null
    if (!url || !kind || !KINDS.includes(kind) || !variant || !VARIANTS.includes(variant)) continue

    const forras: ProviderSource = { kind, url, variant }
    const label = szoveg(s.label); if (label) forras.label = label
    const quality = szoveg(s.quality); if (quality) forras.quality = quality
    const language = szoveg(s.language); if (language) forras.language = language
    if (s.headers && typeof s.headers === 'object' && !Array.isArray(s.headers)) {
      forras.headers = s.headers as Record<string, string>
    }
    /*
     * A LEJÁRAT CSAK AKKOR, HA ÉRTELMES. Egy elrontott dátumból `Invalid
     * Date` lesz, és abból a gyorsítótár azonnal lejárt bejegyzést csinálna —
     * vagyis minden kérés újra feloldana.
     */
    const lejar = szoveg(s.expiresAt)
    if (lejar) {
      const d = new Date(lejar)
      if (Number.isFinite(d.getTime())) forras.expiresAt = d
    }
    sources.push(forras)
  }

  const subtitles: ProviderSubtitle[] = []
  for (const nyers of Array.isArray(b.subtitles) ? b.subtitles : []) {
    if (!nyers || typeof nyers !== 'object') continue
    const s = nyers as Record<string, unknown>
    const url = szoveg(s.url)
    const language = szoveg(s.language)
    if (!url || !language) continue
    const formatum = szoveg(s.format)
    const felirat: ProviderSubtitle = {
      url,
      language,
      kind: szoveg(s.kind) === 'captions' ? 'captions' : 'subtitles',
      // Alapértelmezés `vtt`: ezt minden böngésző érti. Ez nem találgatás —
      // a formátum hiánya esetén ez a biztonságos választás.
      format: (formatum && (SUB_FORMATS as readonly string[]).includes(formatum) ? formatum : 'vtt') as 'vtt' | 'ass' | 'srt'
    }
    if (s.headers && typeof s.headers === 'object' && !Array.isArray(s.headers)) {
      felirat.headers = s.headers as Record<string, string>
    }
    if (s.isDefault === true) felirat.isDefault = true
    subtitles.push(felirat)
  }

  return { sources, subtitles }
}

export const httpFeedProvider: AnimeProvider = {
  id: 'http-feed',
  label: 'HTTP-forrás (beállítható)',
  // A lánc VÉGÉN: a saját tárolónk elsőbbséget élvez.
  defaultPriority: 800,

  /*
   * A KERESÉS ÉS AZ EPIZÓDLISTA ÜRES.
   *
   * Ez az adapter epizódra old fel — nem katalógust böngészik. A YUME
   * jelenlegi láncában a `resolve()` az egyetlen forró út; a másik kettő a
   * szerződés része, de a feloldás nem használja őket. Ha a saját
   * szolgáltatásod tud keresni, itt a helye.
   */
  async search (): Promise<ProviderMatch[]> { return [] },
  async episodes (): Promise<ProviderEpisode[]> { return [] },

  async resolve (ref: EpisodeRef, config?: Record<string, unknown>): Promise<ProviderResult> {
    const b = beallitas(config)
    // Nincs beállítva → nincs mit kérdezni. Nem hiba.
    if (!b.urlTemplate) return noResult()

    const url = cim(b.urlTemplate, ref)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), b.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'YUME/1.0', ...(b.headers ?? {}) },
        signal: ac.signal
      })

      /*
       * A 4xx „NINCS NÁLAM", A 5xx „NEM TUDTAM MEGKÉRDEZNI".
       *
       * Ez a különbség dönti el, hogy a megszakító kinyisson-e. Ha a 404-et
       * is hibának vennénk, egy ritka epizód kizárná az egész szolgáltatót;
       * ha az 500-at elnyelnénk, egy halott szolgáltató örökre a lánc elején
       * maradna.
       */
      if (res.status >= 400 && res.status < 500) return noResult()
      if (!res.ok) throw new Error(`http-feed: HTTP ${res.status}`)

      return normalize(await res.json())
    } finally {
      clearTimeout(timer)
    }
  }
}
