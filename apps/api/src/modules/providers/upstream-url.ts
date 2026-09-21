/**
 * Szolgáltatótól kapott cím ellenőrzése, MIELŐTT a nézőhöz jutna.
 *
 * EZ EGY BIZTONSÁGI HATÁR, nem formai szűrés. Ami innen kijut, azt a
 * böngésző betölti: `iframe` `src`-jeként, HLS-manifesztként vagy
 * feliratsávként. A bizalom láncolata itt ér véget — a szolgáltató válasza
 * ettől a ponttól kezdve NEM megbízható adat.
 *
 * UGYANAZ A SZABÁLY MIND A HÁROMRA, és ez szándékos: https, engedélyezett
 * gazdagép, hitelesítő adat nélkül. Külön-külön megírva a három közül
 * előbb-utóbb az egyik egy esettel kevesebbet tudna.
 *
 * MIÉRT SAJÁT MODUL. Ha ez az adapter belsejében ülne, egyetlen módon
 * lehetne tesztelni: élő hálózattal. Így a szabályok önmagukban mérhetők —
 * és a következő adapter is ugyanezt használja, nem ír magának egy
 * hasonlót, ami egy esettel kevesebbet tud.
 *
 * AMIT SZÁNDÉKOSAN NEM CSINÁLUNK: nem követjük az átirányítást, és nem
 * nézünk bele a lapba. Mindkettő a harmadik fél védelmének feszegetése
 * volna, és egyikből sem lesz biztonságosabb a cím.
 */

/**
 * Elfogadható-e a cím ahhoz, hogy a nézőhöz adjuk.
 *
 * @param raw amit a szolgáltató adott — tetszőleges, nem megbízható érték
 * @param allowedHosts engedélyezett gazdagépek; üres lista = semmi nem megy át
 * @returns a normalizált cím, vagy `null` az elutasítás okával a hívó felé
 */
export function safeUpstreamUrl (raw: unknown, allowedHosts: readonly string[]): string | null {
  return checkUpstreamUrl(raw, allowedHosts).url
}

export interface UrlCheck {
  url: string | null
  /** Miért nem felelt meg. Naplóba való, a válaszba NEM. */
  reason: string | null
}

export function checkUpstreamUrl (raw: unknown, allowedHosts: readonly string[]): UrlCheck {
  const nem = (reason: string): UrlCheck => ({ url: null, reason })

  if (typeof raw !== 'string' || raw.trim() === '') return nem('nincs cím')
  const text = raw.trim()

  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    // A RELATÍV CÍM IS ELUTASÍTÁS. Egy `/stream/1` a saját lapunkhoz képest
    // oldódna fel, vagyis a saját oldalunkat ágyaznánk magunkba.
    return nem('nem értelmezhető abszolút cím')
  }

  /*
   * CSAK HTTPS.
   *
   * A `javascript:`, `data:` és `blob:` séma ezzel EGYÜTT esik ki, és ez a
   * lényegi része: egy `javascript:` cím az `iframe`-ben a MI lapunk
   * eredetén futna le. A `http:` azért nem megy át, mert a YUME HTTPS-en
   * áll, és a kevert tartalmat a böngésző amúgy is blokkolná — jobb itt
   * kimondani, mint a böngésző néma hibájából visszafejteni.
   */
  if (parsed.protocol !== 'https:') return nem(`nem https séma: ${parsed.protocol}`)

  /*
   * BEJELENTKEZÉSI ADAT A CÍMBEN: elutasítás.
   *
   * A `https://user:pass@host/` alak érvényes URL, és a `hostname` belőle
   * szabályosan `host` — vagyis a gazdagép-ellenőrzésen ÁTMENNE. A
   * böngészőnek viszont hitelesítő adatot ad át, és a cím a naplóba is
   * bekerülne. Nekünk nincs szükségünk rá.
   */
  if (parsed.username !== '' || parsed.password !== '') {
    return nem('a cím hitelesítő adatot tartalmaz')
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return nem('nincs gazdagép')

  /*
   * A GAZDAGÉP-EGYEZÉS PONTOS VAGY ALTARTOMÁNY — és a pont nem díszítés.
   *
   * Egy egyszerű `host.endsWith('megaplay.buzz')` átengedné a
   * `gonoszmegaplay.buzz`-t is, ami egy TELJESEN MÁS, tetszőleges kézben
   * lévő tartomány. A `'.' + engedélyezett` végződés ezt kizárja.
   */
  const megfelel = allowedHosts.some(entry => {
    const allowed = String(entry ?? '').trim().toLowerCase().replace(/^\.+|\.$/g, '')
    if (!allowed) return false
    return host === allowed || host.endsWith(`.${allowed}`)
  })
  if (!megfelel) return nem(`nem engedélyezett gazdagép: ${host}`)

  return { url: parsed.toString(), reason: null }
}
