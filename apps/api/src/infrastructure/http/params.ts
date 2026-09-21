// Útvonalparaméterek ellenőrzése — EGY helyen.
//
// MIÉRT KELL. Egy `:id` útvonalparaméter nyersen megy tovább a lekérdezésbe,
// és ha nem azonosító, a Postgres dobja el: „invalid input syntax for type
// uuid". Az eredmény HTTP 500 — holott nem a kiszolgáló hibázott, hanem a
// kérés volt hibás, és egy 500 ráadásul a hibakövetőt is teleszemeteli.
//
// Ez nem elmélet: mind a 238 végpontot végigmértem névtelenül és belépett
// felhasználóként is, és HAT adott 500-at pontosan ezért. Négy csak
// névtelenül látszott, kettő pedig CSAK belépve — azok a 401 mögött ültek,
// tehát egy névtelen pásztázás sosem találta volna meg őket.
//
// MIÉRT ITT, ÉS NEM MINDEN FÁJLBAN. Mielőtt ez a modul megvolt, ugyanazt a
// paramétert HÁROMFÉLEKÉPPEN kezelte a kód — séma szerint (400), kézi
// regexszel (404), és sehogy (500) —, néhol egyetlen fájlon belül. Nem az a
// baj, hogy sok helyen van, hanem hogy mindegyik mást válaszol ugyanarra a
// kérdésre.
//
// MIÉRT SÉMA, ÉS NEM ELLENŐRZÉS A KEZELŐBEN. A séma a kezelő ELŐTT fut: a
// rossz kérés el sem jut az adatbázisig, és a válasza pontosan olyan alakú,
// mint minden más séma-hibáé.

/**
 * Egy kötelező, UUID alakú útvonalparaméter.
 *
 * @param name a paraméter neve az útvonalban — `/:id`-hez `'id'`
 *
 * @example
 *   fastify.get('/:id', { schema: uuidParams() }, handler)
 *   fastify.delete('/library/:animeId', { schema: uuidParams('animeId') }, handler)
 */
export function uuidParams (name = 'id'): {
  params: { type: 'object', properties: Record<string, { type: 'string', format: 'uuid' }>, required: string[] }
} {
  return {
    params: {
      type: 'object',
      properties: { [name]: { type: 'string', format: 'uuid' } },
      required: [name]
    }
  }
}
