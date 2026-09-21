/**
 * Mely gazdagépek beágyazását engedjük — EGY HELYEN.
 *
 * KÉT KAPUN KELL ÁTMENNIE UGYANANNAK A LISTÁNAK, és ha a kettő szétcsúszik,
 * a hiba néma:
 *
 *   1. a szerveroldali ellenőrzés (`embed-url.ts`) — ami bekerülhet egy
 *      `iframe`-be;
 *   2. a saját CSP-nk `frame-src` irányelve (`middleware/security.ts`) — amit
 *      a BÖNGÉSZŐ enged keretbe.
 *
 * MÉRVE, ÉS EZ VOLT AZ ÉLES HIBA: a szolgáltató ellenőrzése átengedte a
 * `megaplay.buzz`-t, a CSP viszont nem szerepeltette, ezért a böngésző
 * blokkolta az egészet:
 *
 *   Framing 'https://megaplay.buzz/' violates the following Content Security
 *   Policy directive: "frame-src https://www.youtube-nocookie.com …"
 *
 * A néző ebből annyit látott, hogy „ezt a részt egyik elérhető forrásból sem
 * sikerült lejátszani" — a szerver közben forrást adott, a lejátszó keretet
 * készített, és a böngésző csendben eldobta.
 */

/**
 * ÜRES AZ ALAPÉRTELMEZÉS, mert jelenleg EGYETLEN beágyazó szolgáltató sincs.
 *
 * Az Anikoto adapter kikerült a rendszerből, és vele az egyetlen `embed`
 * fajtájú forrás. A `frame-src` egy CSP-tágítás: amíg nincs, aki használja,
 * NEM tartjuk nyitva. Egy engedély, aminek nincs jogosultja, csak
 * támadási felület.
 *
 * A beágyazás GÉPEZETE megmarad (`embed-url.ts`, `embed-frame.js`, a
 * `kind: 'embed'` a szerződésben), mert a következő beágyazó szolgáltatónak
 * pontosan ez kell — és mert mérve van. Csak a lista üres.
 *
 * Bekapcsolás egy új szolgáltatóhoz: `YUME_EMBED_HOSTS=pelda.hu,masik.hu`.
 */
export const DEFAULT_EMBED_HOSTS: readonly string[] = []

/**
 * A ténylegesen érvényes lista.
 *
 * Üres környezeti változó = ÜRES LISTA, nem alapértelmezés. Aki kimondja,
 * hogy semmit nem enged beágyazni, azt ne írjuk felül.
 */
export function embedHosts (): readonly string[] {
  const kornyezet = process.env.YUME_EMBED_HOSTS
  if (kornyezet === undefined) return DEFAULT_EMBED_HOSTS
  return kornyezet.split(',').map(x => x.trim()).filter(Boolean)
}

/**
 * A `frame-src` irányelvbe való alakok.
 *
 * A séma KIÍRVA (`https://`), mert a CSP forrásalakja nem gazdagépnév. Az
 * altartományok is bekerülnek (`https://*.host`), mert a szerveroldali
 * ellenőrzés is elfogadja őket — enélkül egy `cdn.megaplay.buzz` átmenne a
 * kapun, és a böngészőnél bukna el.
 */
export function frameSrcEntries (hosts: readonly string[] = embedHosts()): string[] {
  const out: string[] = []
  for (const host of hosts) {
    const tiszta = String(host ?? '').trim().toLowerCase().replace(/^\.+|\.$/g, '')
    if (!tiszta) continue
    out.push(`https://${tiszta}`, `https://*.${tiszta}`)
  }
  return out
}
