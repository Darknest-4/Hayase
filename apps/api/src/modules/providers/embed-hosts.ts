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
 * A mai beágyazó gazdagép, MÉRVE (2026-09-21, `/series/8717`):
 *   `https://megaplay.buzz/stream/s-2/169846/sub`
 *
 * Nem vakon beírt érték, és nem is végleges: a `YUME_EMBED_HOSTS` környezeti
 * változó felülírja. Ha a szolgáltató másik lejátszóra vált, egy beállítás
 * igazítja — nem egy kiadás.
 */
export const DEFAULT_EMBED_HOSTS: readonly string[] = ['megaplay.buzz']

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
