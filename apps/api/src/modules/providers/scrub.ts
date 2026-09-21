// A fejlécek megtisztítása — FUTÁSIDŐBEN, nem csak tesztben.
//
// MIÉRT KELL. A `ProviderSource.headers` és a `ProviderSubtitle.headers`
// tartalma a `/v1/anime/episodes/:id/sources` válaszában KIMEGY A BÖNGÉSZŐNEK
// — ez a mező pont azért van, hogy a lejátszó ugyanazokkal a fejlécekkel
// kérje a szegmenseket. Vagyis ami ide bekerül, azt minden néző látja a
// hálózati naplójában.
//
// Volt rá ellenőrzés — `test/support/provider-contract.ts` —, de az egy
// TESZT-SEGÉD: csak akkor fut le, ha az adapter szerzője megírja hozzá a
// tesztet. Egy adapter, ami bemásol egy `Authorization` fejlécet és nem ír
// tesztet, észrevétlenül szivárogtat.
//
// Ez a modul a HATÁR: a `resolve.ts` minden eredményt átenged rajta, tehát
// minden fogyasztóra hat — nem csak azon az egy végponton.
//
// NEM CSENDBEN TÖRLI. Az eltávolított fejléc NEVE naplóba kerül (az értéke
// soha), mert az adapter szerzőjének meg kell tudnia, hogy amit beírt, nem
// megy ki — különben azt hiszi, elküldtük, és a forrást hibásnak látja.

/**
 * Amit soha nem adunk tovább a böngészőnek.
 *
 * Kétféle szabály, mert kétféle hiba létezik:
 *
 *   * PONTOS NEVEK — a klasszikusok, amiket mindenki ismer;
 *   * MINTÁK — mert egy fejléc nem attól titok, hogy `Authorization` a neve.
 *     Egy `X-Vendor-Session-Token` éppúgy az, és a pontos lista sosem lesz
 *     teljes.
 */
const PONTOS = new Set([
  'authorization',
  'proxy-authorization',
  'authentication',
  'cookie',
  'set-cookie',
  'set-cookie2',
  'www-authenticate',
  'proxy-authenticate',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-auth',
  'x-csrf-token',
  'x-xsrf-token',
  'x-session-id',
  'x-amz-security-token'
])

/**
 * A minta a NÉV bármely részére illik, kisbetűsítve.
 *
 * `token`, `secret`, `passwd`/`password`, `credential`, `session`, `bearer`,
 * és a végén álló `-key` (hogy a `x-api-key` rokonai is fennakadjanak, de a
 * `x-monkey-name`-szerű ártatlan nevek ne).
 */
const MINTAK = [
  /token/, /secret/, /passwo?rd/, /credential/, /session/, /bearer/, /(^|[-_])key$/
]

/** Titkos-e ez a fejlécnév? A vizsgálat kis- és nagybetűre érzéketlen. */
export function isSensitiveHeader (name: string): boolean {
  const n = String(name).trim().toLowerCase()
  if (PONTOS.has(n)) return true
  return MINTAK.some(m => m.test(n))
}

/**
 * Egy fejléckészlet megtisztítva.
 *
 * Visszaadja a megtartott fejléceket és az ELTÁVOLÍTOTTAK NEVÉT — az érték
 * sosem kerül ki innen, még naplóba sem.
 */
export function scrubHeaders (
  headers: Record<string, string> | undefined
): { kept: Record<string, string>, removed: string[] } {
  if (!headers) return { kept: {}, removed: [] }
  const kept: Record<string, string> = {}
  const removed: string[] = []
  for (const [k, v] of Object.entries(headers)) {
    if (isSensitiveHeader(k)) removed.push(k)
    else kept[k] = v
  }
  return { kept, removed }
}
