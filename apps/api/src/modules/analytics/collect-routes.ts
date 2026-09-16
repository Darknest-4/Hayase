// /v1/analytics — az egyetlen végpont, amit a kliens hív.
//
// Egy kimutatás annyit ér, amennyire igaz. Amit a kliens küld, azt hamisítani
// is tudja: egy ciklus a konzolban tízezer „megnézés"-t ír bármelyik címre, és
// onnantól a „legnépszerűbb" lista arról szól, kinek van türelme.
//
// Ezért itt a kliens PONTOSAN EGY dolgot mondhat: melyik oldalra lépett. Minden
// más a kiszolgálóé:
//
//   * ki ő (napi látogatókulcs a címből és a böngészőazonosítóból),
//   * melyik munkamenet (számított, harmincperces ablak),
//   * milyen eszközről (a böngészőazonosítóból),
//   * mikor (a kiszolgáló órája).
//
// És a nézési események — indítás, befejezés, idő — egyáltalán NEM innen
// jönnek: azok a haladásírásból születnek, amit a lejátszó amúgy is küld, és
// aminek van adatbázisbeli következménye. Egy „befejeztem" esemény, ami csak a
// statisztikát mozdítja, ingyen hamisítható; egy olyan, ami a felhasználó saját
// haladását is átírja, már nem éri meg.

import { enqueueView } from './collector.ts'
import { languageOf, referrerHost, screenClass, shapeOf, visitorKey } from './visitor.ts'
import { WRITE_LIMIT } from '../../middleware/security.ts'

import type { FastifyPluginAsync } from 'fastify'

/** Amit a kliens küldhet. Minden mező rövid és ellenőrzött. */
const BODY = {
  type: 'object',
  required: ['route'],
  additionalProperties: false,
  properties: {
    // Az alkalmazás útvonala, nem szabad szöveg: `/anime/:id`, `/search`.
    route: { type: 'string', minLength: 1, maxLength: 200 },
    // Melyik címről van szó, ha a lap egy címhez tartozik.
    entityId: { type: 'string', format: 'uuid' },
    referrer: { type: 'string', maxLength: 500 },
    screenWidth: { type: 'integer', minimum: 1, maximum: 10000 },
    utm: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', maxLength: 80 },
        medium: { type: 'string', maxLength: 80 },
        campaign: { type: 'string', maxLength: 80 }
      }
    }
  }
} as const

/**
 * Az útvonal egységesítése.
 *
 * `/anime/9985a8c7-…` és `/anime/1b2c…` ugyanaz az OLDAL. Azonosítóstul tárolva
 * a „belépő oldalak" listája harmincezer sor lenne, egyenként egy látogatóval,
 * és semmit nem mondana. Az azonosító külön oszlopban megy (`entity_id`).
 */
export function normaliseRoute (route: string): string {
  return route
    .split('?')[0]!
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:n')
    .slice(0, 200) || '/'
}

const routes: FastifyPluginAsync = async fastify => {
  /**
   * Egy oldalletöltés.
   *
   * 204, mindig és mindenre, ami nem szabálysértés: a kliens számára ez egy
   * beacon, nem egy művelet. Nem mondjuk meg neki, hogy duplikátumnak
   * számítottuk-e — abból lehetne kitalálni, hogyan kell nem annak látszani.
   *
   * Az írási sebességkorlát alá tartozik. Ez a végpont hitelesítés nélkül is
   * hívható (a látogatók többsége nincs bejelentkezve), tehát a korlát az
   * egyetlen, ami a visszaéléstől véd.
   */
  fastify.post('/view', {
    config: WRITE_LIMIT,
    onRequest: fastify.identify,
    schema: { body: BODY }
  }, async (request, reply) => {
    const body = request.body as {
      route: string
      entityId?: string
      referrer?: string
      screenWidth?: number
      utm?: { source?: string, medium?: string, campaign?: string }
    }

    const shape = shapeOf(request.headers['user-agent'])
    // A robotokat felvesszük, de megjelöljük: a kimutatás alapból kihagyja
    // őket, a „mennyi a robotforgalom" kérdésre viszont van válasz.
    const key = await visitorKey(request.ip, request.headers['user-agent'] ?? '')

    enqueueView({
      visitorKey: key,
      userId: request.user?.sub ?? null,
      route: normaliseRoute(body.route),
      entityId: body.entityId ?? null,
      referrerHost: referrerHost(body.referrer, request.headers.host),
      utm: {
        source: body.utm?.source ?? null,
        medium: body.utm?.medium ?? null,
        campaign: body.utm?.campaign ?? null
      },
      shape,
      screen: screenClass(body.screenWidth),
      language: languageOf(request),
      // Ország: csak ha egy fordított proxy megmondta. Nem tippelünk, és nem
      // kérünk hozzá külső adatbázist — egy üres oszlop őszintébb.
      country: typeof request.headers['cf-ipcountry'] === 'string'
        ? request.headers['cf-ipcountry'].slice(0, 2).toUpperCase()
        : null,
      at: new Date()
    })

    return await reply.code(204).send()
  })
}

export default routes
