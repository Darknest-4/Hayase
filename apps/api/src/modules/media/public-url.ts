// Honnan jön a kép.
//
// A katalógus képei EREDETILEG az AniList CDN-jéről jöttek, és az adatbázis
// az ottani teljes URL-t tárolta (`object_key`). A tükrözés óta ugyanaz a kép
// megvan nálunk is, az R2-ben (`mirror_key`) — csak épp SENKI NEM HASZNÁLTA:
// a katalógus továbbra is az idegen CDN-re mutatott, 56 997 letükrözött kép
// mellett.
//
// Ez a modul az az EGY hely, ahol eldől, melyik cím megy ki. Nem huszonhat
// lekérdezésben szétszórva: egy elfelejtett lekérdezés csendben visszaesne az
// idegen CDN-re, és semmi nem hibázna tőle.
//
// ---------------------------------------------------------------------------
// HÁROM LEHETSÉGES ALAP, ÉS MIND A HÁROM ÉRVÉNYES
//
//   `/media/`                  — a saját kiszolgálónk (alapértelmezés). Nem
//                                igényel semmilyen külső beállítást, és MA
//                                működik. A forgalom rajtunk megy át.
//
//   https://media.animehub.hu  — az R2 saját domainje. A kép a látogatóhoz
//                                legközelebbi Cloudflare él-szerverről jön,
//                                NULLA kimenő díjjal, és hozzánk el sem ér.
//
//   (nincs tükör)              — az eredeti forrás URL-je. Ez a tartalék, és
//                                marad is: tizenöt képet nem sikerült
//                                letükrözni, és azoknak így is van helyük.

/** Az alapértelmezés: a saját `/media/` útvonalunk. Relatív, tehát mindig jó. */
const DEFAULT_BASE = '/media/'

/**
 * Az alap, a környezetből.
 *
 * SZIGORÚAN ELLENŐRZÖTT, mert az értéke szó szerint bekerül egy SQL
 * kifejezésbe. Ez üzemeltetői bemenet, nem látogatói — de egy elgépelt
 * beállítás így sem okozhat mást, mint hogy az alapértelmezésre esünk vissza.
 *
 * Amit elfogadunk: egy `https://gazdagep/` alak, vagy egy `/`-rel kezdődő
 * útvonal. Semmi mást — se lekérdezést, se idézőjelet, se szóközt.
 */
export function mediaBaseUrl (): string {
  const raw = (process.env.MEDIA_BASE_URL ?? '').trim()
  if (!raw) return DEFAULT_BASE

  const absolute = /^https:\/\/[a-z0-9.-]{1,253}(:\d{1,5})?\/?$/i.test(raw)
  // A `(?!\/)` ugyanazt a rést zárja, amit a karbantartási videónál: a
  // `//idegen/` séma nélküli cím abszolút útvonalnak látszik, a böngésző
  // viszont idegen gazdának olvassa, és onnan töltené MINDEN képet.
  const relative = /^\/(?!\/)[a-z0-9/_-]{0,60}$/i.test(raw)
  if (!absolute && !relative) return DEFAULT_BASE

  return raw.endsWith('/') ? raw : raw + '/'
}

/** Egy szöveg SQL-literállá alakítása. Az aposztróf megduplázva. */
function literal (value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Az SQL kifejezés, ami a kimenő képcímet adja.
 *
 * `CASE`, nem `coalesce`: a kettő nem ugyanaz. A `coalesce(mirror, object)`
 * a NYERS KULCSOT adná vissza, ha van tükör — abból a böngészőben törött kép
 * lesz. Az előtag hozzáfűzése tehát nem elhagyható.
 *
 * @param table a képtábla álneve a lekérdezésben (`img`, `bimg`, `i`, …)
 */
export function imageUrlSql (table: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error(`érvénytelen táblanév: ${table}`)
  const base = literal(mediaBaseUrl())
  return `CASE WHEN ${table}.mirror_key IS NOT NULL THEN ${base} || ${table}.mirror_key ELSE ${table}.object_key END`
}

/**
 * Ugyanez JavaScriptben, azoknak a helyeknek, ahol a sor már megvan.
 *
 * A kettőnek EGYFORMÁN kell viselkednie, és erre teszt is van: két
 * megvalósítás ugyanarra a szabályra előbb-utóbb eltér, és az eltérés csendes.
 */
export function imageUrl (objectKey: string | null, mirrorKey: string | null): string | null {
  if (mirrorKey) return mediaBaseUrl() + mirrorKey
  return objectKey ?? null
}

/**
 * Tényleg kiszolgálja-e a beállított cím a képeinket?
 *
 * MIÉRT INDULÁSKOR, ÉS MIÉRT HANGOSAN
 *
 * A `MEDIA_BASE_URL` átállítása egyetlen sor, és ha a cím még nem él, a
 * következmény az oldal MINDEN képe. Semmi nem hibázik: az API helyes választ
 * ad, a lap felépül, csak minden kép törött — és a naplóban egy sor sincs
 * róla, mert a hiba a LÁTOGATÓ böngészőjében történik, nem nálunk.
 *
 * Ez pontosan megtörtént: a beállítás bekerült, mielőtt a vödör domainje
 * elérhető lett volna.
 *
 * NEM ESÜNK VISSZA MAGUNKTÓL. Egy induláskori hálózati zökkenő miatt csendben
 * a saját kiszolgálónkra terelni minden képet rosszabb, mint egy hangos sor a
 * naplóban: az első esetben senki nem tudja meg, hogy a beállítás nem hat.
 */
export async function verifyMediaBase (
  probeKey: string | null,
  log: { warn: (data: unknown, message: string) => void, info: (data: unknown, message: string) => void }
): Promise<boolean> {
  const base = mediaBaseUrl()
  // A saját útvonalunkat nincs értelme külső kéréssel ellenőrizni: az
  // ugyanez a folyamat, és ha az nem megy, arról már úgyis tudunk.
  if (!base.startsWith('https://')) return true
  if (!probeKey) return true

  const url = base + probeKey
  try {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) })
    if (response.ok) {
      log.info({ base }, 'a képek a beállított címről mennek ki, és az válaszol')
      return true
    }
    log.warn(
      { base, status: response.status },
      'A BEÁLLÍTOTT KÉPFORRÁS NEM SZOLGÁL KI. Az oldal minden képe törött lesz. ' +
      'Ellenőrzés: scripts/cloudflare/check-media.sh — visszaállítás: vedd ki a MEDIA_BASE_URL sort.'
    )
    return false
  } catch (error) {
    log.warn(
      { base, err: (error as Error).message },
      'A BEÁLLÍTOTT KÉPFORRÁS NEM ÉRHETŐ EL. Az oldal minden képe törött lesz. ' +
      'Ellenőrzés: scripts/cloudflare/check-media.sh — visszaállítás: vedd ki a MEDIA_BASE_URL sort.'
    )
    return false
  }
}
