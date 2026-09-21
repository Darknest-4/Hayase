// A YUME saját forrásmodellje — és a szerződés, amit egy szolgáltatónak
// teljesítenie kell.
//
// EZ A FÁJL A HATÁR. Innen kifelé a YUME a saját fogalmait használja; ami egy
// külső szolgáltató válaszában van, az az adapter dolga, és nem szivárog át.
// Ha egy adapter alakja beszivárogna ide, akkor a második adapter megírásakor
// derülne ki, hogy az egész réteg egyetlen szolgáltatóra van szabva.
//
// Ezért itt nincs `server`, nincs `episodeId` idegen formátumban, nincs
// „sub/dub" sztringként szétszórva: egy forrásnak VAN nyelve és VAN változata,
// és mindkettő zárt halmaz.

/**
 * A stream szállítási formája.
 *
 * Nem ugyanaz, mint a fájlkiterjesztés: egy `.m3u8` HLS, egy `.mpd` DASH, egy
 * `.mp4` közvetlen fájl. A lejátszónak ez dönti el, melyik motort indítja, és
 * ez az EGYETLEN dolog, amit tudnia kell a forrás eredetéről.
 */
export type SourceKind = 'hls' | 'dash' | 'mp4'

/** Szinkron/felirat változat. `raw` = nincs se felirat, se szinkron. */
export type SourceVariant = 'sub' | 'dub' | 'raw'

/**
 * Egy lejátszható forrás.
 *
 * A `headers` és a `referer` NEM stílus: sok kiszolgáló csak akkor ad
 * szegmenst, ha a kérés ugyanazokkal a fejlécekkel jön, mint a lejátszólista
 * kérése. Ha ezek nem jutnak el a lejátszóig, a lista betöltődik és a videó
 * néma marad — olyan hiba, ami a feloldás naplójában sikernek látszik.
 */
export interface ProviderSource {
  kind: SourceKind
  url: string
  /**
   * Ennek a forrásnak a NEVE, ahogy a nézőnek megmutatjuk.
   *
   * Nem a szolgáltató neve: egy szolgáltató több kiszolgálót is kínálhat
   * ugyanahhoz az epizódhoz, és a néző azok KÖZÜL választ. Nálunk ez az,
   * amit az üzemeltető a forrás mellé beírt.
   *
   * Enélkül a réteg minden forrást a feloldó szolgáltató nevén mutatott
   * volna, és három különböző kiszolgáló háromszor ugyanannak látszott.
   */
  label?: string | null
  /** Emberi felbontásjelölés, ha a szolgáltató ad ilyet: `1080p`, `auto`. */
  quality?: string | null
  /** A HANG nyelve, BCP-47 (`ja`, `en`, `hu`). A feliraté a `ProviderSubtitle`-ben van. */
  language?: string | null
  variant: SourceVariant
  /** Amit a lejátszónak is el kell küldenie. Üres objektum = nincs különleges igény. */
  headers?: Record<string, string>
  /**
   * Meddig érvényes ez a cím.
   *
   * Sok aláírt URL percekig él. A gyorsítótár EZT veszi alapul, nem egy
   * rögzített élettartamot — különben vagy fölöslegesen dobunk el jó
   * címeket, vagy lejártakat szolgálunk ki.
   */
  expiresAt?: Date | null
}

/** Feliratsáv. A `kind` a WebVTT szerinti szerep. */
export interface ProviderSubtitle {
  language: string
  kind: 'subtitles' | 'captions'
  format: 'vtt' | 'ass' | 'srt'
  url: string
  headers?: Record<string, string>
  /** Alapértelmezetten bekapcsolt sáv, ha a szolgáltató megjelöl egyet. */
  isDefault?: boolean
}

/** Amit egy feloldás visszaad. Üres tömb LEGITIM válasz: „nincs, amit adjak". */
export interface ProviderResult {
  sources: ProviderSource[]
  subtitles: ProviderSubtitle[]
}

/** Egy találat a szolgáltató katalógusában. */
export interface ProviderMatch {
  /** A szolgáltató SAJÁT azonosítója. A YUME nem értelmezi, csak visszaadja. */
  id: string
  title: string
  /** Ha a szolgáltató ismeri, a párosítás ezen áll vagy bukik. */
  anilistId?: number | null
  year?: number | null
  episodeCount?: number | null
}

/** Egy epizód a szolgáltatónál. */
export interface ProviderEpisode {
  id: string
  number: number
  title?: string | null
}

/**
 * Amit a YUME tud arról az epizódról, amit fel akar oldatni.
 *
 * MIÉRT EZ MEGY BE, ÉS NEM A SAJÁT SOR-AZONOSÍTÓNK. Egy szolgáltató nem tud
 * mit kezdeni egy YUME-uuid-vel. Ami segít neki, az a cím, az évszám, a
 * rész száma és az AniList-azonosító — ez utóbbi a legjobb horgony, mert a
 * legtöbb katalógus ismeri.
 */
export interface EpisodeRef {
  /**
   * A SAJÁT epizódazonosítónk — csak a HÁZON BELÜLI adaptereknek.
   *
   * Külső szolgáltató ezzel nem tud mit kezdeni, és nem is kell: figyelmen
   * kívül hagyja. A saját tárolónk viszont pontosan ezt ismeri, és neki
   * párosítania sem kell — ő MI VAGYUNK.
   *
   * Enélkül a helyi adapter az AniList-azonosítóra volt utalva, és egy olyan
   * címnél, amihez nincs leképezés, megtagadta a SAJÁT epizódjainkat. Ezt a
   * `video-sources` tesztje fogta meg: üres lista ott, ahol három forrás állt.
   */
  episodeId?: string
  anilistId: number | null
  /*
   * A TÖBBI KÜLSŐ AZONOSÍTÓ.
   *
   * Az `anime_mappings` tábla hordozza őket, és eddig nem mentek át — egy
   * olyan szolgáltató, ami MAL vagy AniDB szerint katalogizál, kénytelen volt
   * cím szerint párosítani, ami két évadnál rendre téved.
   *
   * Mind `null` lehet: egy katalógusbeli címhez nem feltétlenül tartozik
   * leképezés, és egyikhez sem tartozik mind.
   */
  malId?: number | null
  kitsuId?: number | null
  anidbId?: number | null
  title: string
  /** Alternatív címek — a párosítás sokszor ezen múlik. */
  synonyms?: string[]
  year?: number | null
  number: number
  /**
   * Melyik változatot keressük.
   *
   * HIÁNYZÓ ÉRTÉK = BÁRMELYIK, nem `sub`. Ez nem apróság: ha a hiány
   * `sub`-ot jelentene, egy változatot nem kérő hívás CSENDBEN kizárná a
   * szinkronos forrásokat — a néző pedig azt látná, hogy „nincs forrás",
   * miközben van.
   */
  variant?: SourceVariant
}

/**
 * A SZOLGÁLTATÓ SZERZŐDÉSE.
 *
 * Három metódus, és mind a három KIVÉTELT DOBHAT — a hívó (`resolve.ts`) arra
 * van felkészülve. Amit viszont NEM szabad: csendben üres tömböt adni egy
 * hibára. Az üres tömb azt jelenti, hogy „megkérdeztem, és nincs"; egy hiba
 * azt, hogy „nem tudtam megkérdezni". A kettő különbsége dönti el, hogy a
 * körkörös megszakító kinyisson-e.
 */
export interface AnimeProvider {
  /** Gépi azonosító. Ez kerül a `video_sources.provider` oszlopba és a naplóba. */
  readonly id: string
  /** Emberi név az adminfelületre. */
  readonly label: string
  /**
   * Alapértelmezett prioritás, ha a `providers` táblában még nincs sora.
   * Kisebb szám = előbb próbáljuk.
   */
  readonly defaultPriority?: number

  /** Cím keresése a szolgáltatónál. */
  search (query: string, hint?: { anilistId?: number | null, year?: number | null }): Promise<ProviderMatch[]>

  /** Egy találat epizódjai. */
  episodes (matchId: string): Promise<ProviderEpisode[]>

  /**
   * A lejátszható címek egy epizódhoz.
   *
   * Ez a forró út: ez fut le, amikor valaki megnyom egy lejátszás gombot.
   *
   * A MÁSODIK PARAMÉTER A SZOLGÁLTATÓ SAJÁT BEÁLLÍTÁSA — a `providers.config`
   * oszlopból, az adminfelületről szerkeszthetően. Opcionális: egy adapter,
   * ami nem kér beállítást, egyszerűen nem veszi át.
   *
   * SOHA NEM TITOK. Ez az érték megjelenik az adminfelületen, tehát alap-URL,
   * régió, nyelvi preferencia való bele — kulcs, jelszó, token nem. Azok a
   * környezeti változókban maradnak.
   */
  resolve (ref: EpisodeRef, config?: Record<string, unknown>): Promise<ProviderResult>
}

/** Üres eredmény — a „megkérdeztem, és nincs" válasz egy helyen leírva. */
export function noResult (): ProviderResult {
  return { sources: [], subtitles: [] }
}
