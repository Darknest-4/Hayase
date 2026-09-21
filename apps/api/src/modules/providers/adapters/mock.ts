// MINTA-ADAPTER — másolható kiindulópont egy új szolgáltatóhoz.
//
// EZ NEM KERÜL A `BUILT_IN` LISTÁBA, és ez szándékos: `example.invalid`
// címeket ad vissza, tehát ha éles láncba kerülne, működő forrásnak látszó,
// lejátszhatatlan címeket szolgálna ki. A saját tesztje regisztrálja
// (`test/provider-mock-adapter.test.ts`), és ott bizonyítja, hogy a
// szerződést teljesíti.
//
// Ha egy valódi adaptert írsz, EZT másold, és cseréld ki benne a három
// metódus törzsét. A körülöttük lévő döntések — mikor `noResult()`, mikor
// kivétel, mi kerül a `label`-be, mikor `expiresAt` — ugyanazok maradnak.
//
// AMIT DEMONSTRÁL:
//   * keresés és a találat visszaadása
//   * párosítás AniList-azonosítón és cím szerint
//   * epizódlista
//   * feloldás HLS és MP4 forrással
//   * `sub` és `dub` változat
//   * feliratsávok, köztük kettő angol
//   * `expiresAt` egy aláírt címen
//   * `headers` továbbadása
//   * az ÜRES EREDMÉNY és a KIVÉTEL különbsége

import { noResult } from '../types.ts'

import type {
  AnimeProvider, EpisodeRef, ProviderEpisode, ProviderMatch, ProviderResult,
  ProviderSource, ProviderSubtitle
} from '../types.ts'

/** A minta „katalógusa". Egy valódi adapterben ez hálózati hívás. */
const KATALOGUS = [
  { id: 'mock-1', title: 'Minta Sorozat', anilistId: 1, year: 2020, episodeCount: 12 },
  { id: 'mock-2', title: 'Másik Minta', anilistId: 2, year: 2021, episodeCount: 24 }
]

/**
 * Egy hiba, amit a szolgáltató oldaláról kapunk.
 *
 * NEM kell saját hibatípus: a `resolve.ts` bármilyen kivételt elfogad, és a
 * `message` kerül a lánc naplójába. Ez az osztály csak azért van itt, hogy a
 * minta megmutassa, hol keletkezik.
 */
class MockProviderError extends Error {}

export const mockProvider: AnimeProvider = {
  id: 'mock',
  label: 'Minta szolgáltató',
  // Magas szám = a lánc VÉGÉN. Egy új adaptert érdemes hátulra tenni, amíg
  // nem bízol benne: csak akkor kérdezzük meg, ha előtte senki nem adott semmit.
  defaultPriority: 900,

  /**
   * KERESÉS.
   *
   * A `hint.anilistId` az erősebb horgony: ha megvan, azon keresünk, és a
   * címet meg sem nézzük. Cím szerint keresni egy ismert azonosító mellett
   * azért rossz, mert két évad címe gyakran majdnem azonos.
   */
  async search (query, hint): Promise<ProviderMatch[]> {
    if (hint?.anilistId != null) {
      return KATALOGUS.filter(m => m.anilistId === hint.anilistId)
    }
    const q = query.trim().toLowerCase()
    if (!q) return []
    // ÜRES TÖMB, ha nincs találat — ez NEM hiba.
    return KATALOGUS.filter(m => m.title.toLowerCase().includes(q))
  },

  /**
   * EPIZÓDOK.
   *
   * A `ProviderEpisode.id` a SZOLGÁLTATÓ saját azonosítója. A YUME nem
   * értelmezi: csak visszaadja, és az adapter kapja meg újra, ha kell.
   */
  async episodes (matchId): Promise<ProviderEpisode[]> {
    const mu = KATALOGUS.find(m => m.id === matchId)
    // ISMERETLEN AZONOSÍTÓ = KIVÉTEL, nem üres lista: a hívó rosszat kért,
    // és ezt jobb megmondani, mint úgy tenni, mintha nem volna epizód.
    if (!mu) throw new MockProviderError(`ismeretlen azonosító: ${matchId}`)
    return Array.from({ length: mu.episodeCount }, (_, i) => ({
      id: `${mu.id}-ep${i + 1}`,
      number: i + 1,
      title: `${mu.episodeCount} részes minta — ${i + 1}. rész`
    }))
  },

  /**
   * FELOLDÁS — a forró út.
   *
   * A PÁROSÍTÁS SORRENDJE: AniList-azonosító, aztán cím, aztán szinonimák. Az
   * `episodeId` itt szándékosan NINCS használva: az a SAJÁT azonosítónk, amit
   * egy külső szolgáltató nem ismer.
   */
  async resolve (ref: EpisodeRef): Promise<ProviderResult> {
    const mu = KATALOGUS.find(m =>
      (ref.anilistId != null && m.anilistId === ref.anilistId) ||
      m.title.toLowerCase() === ref.title.toLowerCase() ||
      (ref.synonyms ?? []).some(s => s.toLowerCase() === m.title.toLowerCase())
    )
    // NINCS ILYEN CÍM NÁLUNK → üres eredmény. Megkérdeztek, és nincs.
    if (!mu) return noResult()

    /*
     * A HIBÁT NEM NYELJÜK EL. Egy valódi adapterben itt áll a hálózati hívás;
     * ha az elhasal, a kivétel MEGY TOVÁBB. Ha elkapnánk és üres tömböt
     * adnánk, a megszakító sosem nyitna ki, és egy halott szolgáltató örökre
     * a lánc elején maradna.
     *
     * A DEMÓ-HIBA A TARTOMÁNYELLENŐRZÉS ELŐTT ÁLL, és ez nem esetlegesség:
     * először utána tettem, és a saját tesztem buktatta el — a 13. rész a
     * tizenkét részes mintán már a tartományon kiesett, tehát a hibaághoz el
     * sem jutott. A hálózati hívás egy valódi adapterben is a
     * tartomány-ellenőrzés előtt van, mert a tartományt épp a válaszból tudjuk
     * meg.
     */
    if (ref.number === 13) {
      throw new MockProviderError('a minta 13. része szándékosan hibázik (demó)')
    }

    // NINCS ILYEN RÉSZ → üres eredmény, nem kivétel: a szolgáltató elérhető
    // volt és felelt.
    if (ref.number < 1 || ref.number > mu.episodeCount) return noResult()

    /*
     * A FEJLÉCEK. Amit a lejátszónak is el kell küldenie, hogy a kiszolgáló
     * szegmenst adjon. A `Referer`-nek nincs külön mezője a modellben — egy
     * fejléc a többi között.
     */
    const headers = {
      Referer: 'https://example.invalid/',
      'User-Agent': 'YUME/1.0 (minta adapter)'
    }

    const kert = ref.variant ?? null
    const sources: ProviderSource[] = []

    if (kert === null || kert === 'sub') {
      sources.push({
        kind: 'hls',
        url: `https://example.invalid/hls/${mu.id}/${ref.number}/master.m3u8?sig=minta`,
        // A NÉV, amit a néző lát. Egy szolgáltató több kiszolgálót is
        // kínálhat; a néző azok közül választ, és ez különbözteti meg őket.
        label: 'Minta · 1. kiszolgáló',
        quality: '1080p',
        language: 'ja',
        variant: 'sub',
        headers,
        // ALÁÍRT CÍM: tíz percig él. A gyorsítótár EZT veszi alapul, nem a
        // saját öt perces alapértelmezését.
        expiresAt: new Date(Date.now() + 10 * 60_000)
      })
      sources.push({
        kind: 'mp4',
        url: `https://example.invalid/mp4/${mu.id}/${ref.number}/720.mp4`,
        label: 'Minta · tartalék (MP4)',
        quality: '720p',
        language: 'ja',
        variant: 'sub',
        headers
      })
    }

    if (kert === null || kert === 'dub') {
      sources.push({
        kind: 'hls',
        url: `https://example.invalid/hls/${mu.id}/${ref.number}/dub.m3u8`,
        label: 'Minta · szinkron',
        quality: '1080p',
        // A `language` a HANG nyelve, nem a feliraté.
        language: 'en',
        variant: 'dub',
        headers
      })
    }

    if (!sources.length) return noResult()

    /*
     * FELIRATOK.
     *
     * MINDEGYIK ANGOL SÁV MEGMARAD. A modellben nincs mező, ami
     * megkülönböztetne két azonos nyelvű sávot — nincs `label` a feliraton —,
     * és a szűrés nem az adapter dolga: aki nézi, az dönti el, melyik kell
     * neki. Ha kettőből egyet eldobnánk, azt vennénk el, amelyik jobb.
     */
    const subtitles: ProviderSubtitle[] = [
      { language: 'en', kind: 'subtitles', format: 'vtt', url: `https://example.invalid/sub/${mu.id}/${ref.number}/en.vtt`, headers, isDefault: true },
      { language: 'en', kind: 'subtitles', format: 'ass', url: `https://example.invalid/sub/${mu.id}/${ref.number}/en-signs.ass`, headers },
      { language: 'hu', kind: 'subtitles', format: 'srt', url: `https://example.invalid/sub/${mu.id}/${ref.number}/hu.srt`, headers }
    ]

    return { sources, subtitles }
  }
}
