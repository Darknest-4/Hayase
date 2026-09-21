// „Ez a kérés a szerveren belülről jött?"
//
// A sebességkorlát célja az, hogy egy IDEGEN ne tudja elárasztani a rendszert.
// A saját gépünk nem idegen: a worker, a bot, az egészségjelző, a mérések és
// a karbantartó szkriptek ugyanazon a hálózaton futnak, és ha ezeket
// megfojtjuk, az nem védelem, hanem öngól — a rendszer megbénítja saját
// magát, pont amikor dolgozik.
//
// EZ EGY BIZTONSÁGI DÖNTÉS, tehát az a kérdés, hogy KÍVÜLRŐL HAMISÍTHATÓ-E.
//
// Az egyetlen mező, amit egy távoli kérő nem tud hazudni, a TCP-kapcsolat
// túlsó vége (`socket.remoteAddress`). Az `X-Forwarded-For` hazudható —
// ezért azt itt nem hisszük el, sőt: a JELENLÉTE önmagában kizárja a belső
// minősítést, mert azt a fordított proxy teszi rá, és ami azon átjött, az
// definíció szerint kívülről érkezett.
//
// A telepítés ezt meg is támogatja: az alkalmazás portja NINCS kipublikálva a
// gazdagépre (`docker compose ps` szerint csak a Caddy 80/443-a és a
// PostgreSQL helyi továbbítása), tehát a folyamathoz eleve csak a Docker
// hálózatáról vagy a hurokcímről lehet hozzáérni.

import type { FastifyRequest } from 'fastify'

/**
 * A fejlécek, amelyek bármelyikének jelenléte azt jelenti: ez a kérés
 * proxyn át jött, tehát NEM belső.
 *
 * Fehérlista helyett feketelista, és ez itt kivételesen helyes: nem azt
 * soroljuk fel, mi biztonságos, hanem azt, mi bizonyítja a külső eredetet.
 * Egy fel nem sorolt új proxyfejléc legrosszabb esetben is csak annyit tesz,
 * hogy a címellenőrzésre marad a döntés — az pedig nem hamisítható.
 */
const PROXY_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-host', 'cf-connecting-ip']

/** Hurokcím. IPv6-ban a `::ffff:127.0.0.1` alak is ezt jelenti. */
export function isLoopback (address: string | undefined): boolean {
  if (!address) return false
  const plain = address.replace(/^::ffff:/i, '')
  return plain === '::1' || plain === '127.0.0.1' || /^127\./.test(plain)
}

/**
 * RFC 1918 magánhálózat — a Docker hídja is ilyen.
 *
 * Ez ÖNMAGÁBAN nem elég a mentességhez: a fordított proxy is ilyen címen ül,
 * és rajta keresztül jön be az egész internet. Ezért a hívó a proxyfejlécek
 * hiányát is megköveteli.
 */
export function isPrivateAddress (address: string | undefined): boolean {
  if (!address) return false
  const plain = address.replace(/^::ffff:/i, '')
  if (isLoopback(plain)) return true
  const octets = plain.split('.').map(Number)
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    // IPv6 egyedi helyi címek (fc00::/7).
    return /^f[cd][0-9a-f]{2}:/i.test(plain)
  }
  const a = octets[0] as number
  const b = octets[1] as number
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

/**
 * Belülről jött-e a kérés.
 *
 * A KÉT FELTÉTEL EGYÜTT kell:
 *
 *   1. a TCP-kapcsolat túlsó vége hurok- vagy magáncím — ezt egy távoli kérő
 *      nem tudja befolyásolni;
 *   2. nincs rajta proxyfejléc — ami a Caddyn átjött, azon mindig van.
 *
 * Az első feltétel önmagában kevés lenne (a proxy is magáncímen ül), a
 * második önmagában szintén (egy fejléc elhagyható). Együtt viszont nincs
 * olyan út, amin egy külső kérő idejuthatna: a port nincs kipublikálva, tehát
 * a folyamatot csak a saját hálózatunkról lehet elérni.
 */
export function isInternalRequest (request: FastifyRequest): boolean {
  if (!internalTrustEnabled()) return false
  for (const header of PROXY_HEADERS) {
    if (request.headers[header] !== undefined) return false
  }
  return isPrivateAddress(request.socket?.remoteAddress ?? undefined)
}

/**
 * Ki lehet kapcsolni: `RATE_LIMIT_TRUST_INTERNAL=false`.
 *
 * Alapból BE van kapcsolva, mert az alapértelmezett telepítésben helyes: az
 * alkalmazás portja nincs kipublikálva, és a Caddy minden átengedett kérésre
 * rátesz egy `X-Forwarded-For`-t.
 *
 * Aki viszont MÁS fordított proxyt tesz elé, annak tudnia kell egy dolgot: ha
 * az a proxy NEM állít továbbítófejlécet, és hurok- vagy magáncímről ér az
 * apphoz, akkor az egész internet „belülről" érkezőnek látszana. Ez a kapcsoló
 * az ilyen telepítésé.
 */
export function internalTrustEnabled (): boolean {
  return process.env.RATE_LIMIT_TRUST_INTERNAL !== 'false'
}
