// A szolgáltatói szerződés ellenőrzői — EGY példányban.
//
// MIÉRT KELL. Eddig minden adapter a saját tesztjében írta le, mit jelent
// „érvényes eredmény": hogy a `variant` kötelező, hogy a `kind` a három
// ismert egyike, hogy a felirat formátuma zárt halmaz. Három adapternél ez
// három, egymástól függetlenül elavuló másolat — és ha a szerződés változik,
// az egyik teszt még hónapokig zölden méri a régit.
//
// Innentől egy hely mondja meg, mit jelent megfelelni. Egy új adapter tesztje
// ezeket hívja, és nem ír újra semmit.
//
// AMIT EZEK NEM CSINÁLNAK: nem hívnak hálózatot és nem indítanak
// alkalmazást. Amit kapnak, azt vizsgálják — a hívó dolga előállítani.

import assert from 'node:assert/strict'

import { isSensitiveHeader } from '../../src/modules/providers/scrub.ts'

import type {
  AnimeProvider, ProviderEpisode, ProviderMatch, ProviderResult, ProviderSubtitle
} from '../../src/modules/providers/types.ts'

/** A `types.ts` zárt halmazai, EGY helyen kiírva. */
export const SOURCE_KINDS = ['hls', 'dash', 'mp4', 'embed'] as const
export const SOURCE_VARIANTS = ['sub', 'dub', 'raw'] as const
export const SUBTITLE_KINDS = ['subtitles', 'captions'] as const
export const SUBTITLE_FORMATS = ['vtt', 'ass', 'srt'] as const

/**
 * Az adapter ALAKJA — hálózat nélkül.
 *
 * Ez az, amit egy adapterről akkor is meg lehet mondani, ha egyetlen kérést
 * sem küldünk: van-e azonosítója, neve, és megvan-e mind a három metódusa.
 */
export function checkShape (provider: AnimeProvider, cim = 'az adapter'): void {
  assert.equal(typeof provider.id, 'string', `${cim}: hiányzó vagy rossz \`id\``)
  assert.ok(provider.id.length > 0, `${cim}: üres \`id\``)
  assert.match(provider.id, /^[a-z0-9][a-z0-9-]*$/,
    `${cim}: az \`id\` a naplóba és az admin URL-jébe kerül — kisbetű, szám, kötőjel`)
  assert.equal(typeof provider.label, 'string', `${cim}: hiányzó \`label\``)
  assert.ok(provider.label.length > 0, `${cim}: üres \`label\``)

  for (const metodus of ['search', 'episodes', 'resolve'] as const) {
    assert.equal(typeof provider[metodus], 'function', `${cim}: hiányzó \`${metodus}()\``)
  }

  if (provider.defaultPriority !== undefined) {
    assert.ok(Number.isInteger(provider.defaultPriority) &&
      provider.defaultPriority >= 0 && provider.defaultPriority <= 1000,
    `${cim}: a \`defaultPriority\` 0 és 1000 közötti egész`)
  }
}

/** Egy keresési találat listája. */
export function checkMatches (matches: ProviderMatch[], cim = 'a találatok'): void {
  assert.ok(Array.isArray(matches), `${cim}: nem tömb`)
  for (const [i, m] of matches.entries()) {
    assert.equal(typeof m.id, 'string', `${cim}[${i}]: az \`id\` kötelező`)
    assert.ok(m.id.length > 0, `${cim}[${i}]: üres \`id\``)
    assert.equal(typeof m.title, 'string', `${cim}[${i}]: a \`title\` kötelező`)
  }
}

/** Egy epizódlista. */
export function checkEpisodes (episodes: ProviderEpisode[], cim = 'az epizódok'): void {
  assert.ok(Array.isArray(episodes), `${cim}: nem tömb`)
  for (const [i, e] of episodes.entries()) {
    assert.equal(typeof e.id, 'string', `${cim}[${i}]: az \`id\` kötelező`)
    assert.ok(Number.isFinite(e.number), `${cim}[${i}]: a \`number\` szám kell legyen`)
  }
}

/** Egy feliratsáv. */
function checkSubtitle (s: ProviderSubtitle, cim: string): void {
  assert.equal(typeof s.language, 'string', `${cim}: a \`language\` kötelező`)
  assert.ok(s.language.length > 0, `${cim}: üres \`language\``)
  assert.ok(SUBTITLE_KINDS.includes(s.kind), `${cim}: ismeretlen \`kind\`: ${s.kind}`)
  assert.ok(SUBTITLE_FORMATS.includes(s.format), `${cim}: ismeretlen \`format\`: ${s.format}`)
  assert.equal(typeof s.url, 'string', `${cim}: az \`url\` kötelező`)
  assert.ok(s.url.length > 0, `${cim}: üres \`url\``)
}

/**
 * EGY FELOLDÁS EREDMÉNYE — a szerződés szíve.
 *
 * `options.expectSources`: `true`, ha ennek a hívásnak adnia KELL forrást.
 * Enélkül az üres eredmény is megfelel — az a „megkérdeztem, és nincs"
 * válasz, ami legitim.
 */
export function checkResult (
  result: ProviderResult,
  { expectSources = false, cim = 'az eredmény' }: { expectSources?: boolean, cim?: string } = {}
): void {
  assert.ok(result && typeof result === 'object', `${cim}: nem objektum`)
  assert.ok(Array.isArray(result.sources), `${cim}: a \`sources\` tömb kell legyen`)
  assert.ok(Array.isArray(result.subtitles), `${cim}: a \`subtitles\` tömb kell legyen`)

  if (expectSources) {
    assert.ok(result.sources.length > 0, `${cim}: forrást vártunk, és nem jött`)
  }

  for (const [i, s] of result.sources.entries()) {
    const hol = `${cim}.sources[${i}]`
    assert.ok(SOURCE_KINDS.includes(s.kind), `${hol}: ismeretlen \`kind\`: ${s.kind}`)
    assert.equal(typeof s.url, 'string', `${hol}: az \`url\` kötelező`)
    assert.ok(s.url.length > 0, `${hol}: üres \`url\``)
    /*
     * A `variant` KÖTELEZŐ. Nincs „nem deklarál változatot" állapot: ha nem
     * tudjuk, `raw` a becsületes válasz. Enélkül a `?variant=` szűrés
     * csendben eldobná ezt a forrást.
     */
    assert.ok(SOURCE_VARIANTS.includes(s.variant),
      `${hol}: a \`variant\` kötelező és zárt halmaz, kapott: ${JSON.stringify(s.variant)}`)

    if (s.headers !== undefined) {
      assert.equal(typeof s.headers, 'object', `${hol}: a \`headers\` objektum`)
      for (const [k, v] of Object.entries(s.headers)) {
        assert.equal(typeof v, 'string', `${hol}: a(z) ${k} fejléc értéke nem sztring`)
      }
    }
    if (s.expiresAt != null) {
      const t = new Date(s.expiresAt).getTime()
      assert.ok(Number.isFinite(t), `${hol}: az \`expiresAt\` nem értelmezhető dátum`)
    }
  }

  for (const [i, s] of result.subtitles.entries()) {
    checkSubtitle(s, `${cim}.subtitles[${i}]`)
  }
}

/**
 * A FEJLÉCEK NEM TITKOSAK — a végpont kiadja őket a böngészőnek.
 *
 * Külön ellenőrző, mert ez nem alak- hanem TARTALMI kérdés, és pont az a
 * fajta hiba, amit egy adapter írója véletlenül követ el: bemásol egy
 * `Authorization` fejlécet, ami onnantól ott van minden néző hálózati
 * naplójában.
 */
export function checkNoSecretsInHeaders (result: ProviderResult, cim = 'az eredmény'): void {
  /*
   * UGYANAZT A SZABÁLYT HASZNÁLJA, AMIT A FUTÁSIDŐ.
   *
   * Eddig saját mintája volt — hat név, pontos egyezéssel —, és ez két
   * dologban tévedett: kimaradt belőle a `Set-Cookie`, és nem fogta meg azt,
   * ami nem attól titok, hogy `Authorization` a neve (egy
   * `X-Vendor-Session-Token` éppúgy az). Ráadásul két lista, ami külön
   * avul el.
   *
   * A `scrub.ts` a határ, ez a segéd pedig ugyanazt kérdezi — így egy adapter
   * tesztje pontosan azt méri, amit a rendszer tényleg kiszűr.
   */
  for (const [i, s] of result.sources.entries()) {
    for (const k of Object.keys(s.headers ?? {})) {
      assert.ok(!isSensitiveHeader(k),
        `${cim}.sources[${i}]: a(z) \`${k}\` fejléc kimenne a böngészőnek — titok nem való a \`headers\`-be`)
    }
  }
  for (const [i, s] of result.subtitles.entries()) {
    for (const k of Object.keys(s.headers ?? {})) {
      assert.ok(!isSensitiveHeader(k), `${cim}.subtitles[${i}]: a(z) \`${k}\` fejléc titok`)
    }
  }
}
