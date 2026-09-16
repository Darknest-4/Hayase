// A letükrözött képek kiszolgálása.
//
// Ez az útvonal a KULCSOT A KÉRÉS URL-JÉBŐL kapja, és ez a tény határozza meg
// az egész felépítését.
//
// KÉT ZÁR, egymástól függetlenül:
//
//   1. KÜLÖN VÖDÖR. A médiavödör nem az, amiben a mentések vannak. Még ha
//      minden más ellenőrzés elromlana, ez az útvonal akkor sem tud olyan
//      vödörre mutatni, ami az adatbázis teljes tartalmát őrzi.
//   2. ISMERT KULCS. Nem elég, hogy a kulcs jól néz ki: szerepelnie kell az
//      `anime_images.mirror_key` oszlopban. Vagyis csak azt lehet letölteni,
//      amit MI tettünk oda, egy katalógusképként. Kitalált kulcs, útvonal-
//      bejárás, idegen prefix — mind ismeretlen, tehát 404.
//
// A GYORSÍTÓTÁRAZÁS `immutable`, és ezt meg lehet ígérni: a kulcs a forrás
// URL-jének hasítása, tehát egy kulcs mögött sosem lesz más kép. Ha a
// szolgáltató lecseréli a borítót, az új URL új kulcsot kap.

import { mediaStorage, getObject } from '../../infrastructure/storage/s3.ts'
import { queryOne } from '../../infrastructure/database/index.ts'

import type { FastifyPluginAsync } from 'fastify'

/** Egy év. A kulcs tartalomcímzett, tehát a tartalom nem változhat alatta. */
const CACHE = 'public, max-age=31536000, immutable'

const routes: FastifyPluginAsync = async fastify => {
  fastify.get('/media/*', async (request, reply) => {
    const key = (request.params as { '*': string })['*']

    /*
     * Az első szűrő olcsó és nem az adatbázist terheli: ami nem a `media/`
     * prefixszel kezdődik, azt meg sem kérdezzük. A `..` kifejezetten szerepel,
     * noha a következő ellenőrzés amúgy is megfogná — egy útvonal-bejárási
     * kísérletet olcsóbb itt elutasítani, mint egy lekérdezés árán.
     */
    if (!key || !key.startsWith('media/') || key.includes('..')) {
      return await reply.code(404).send({
        type: 'about:blank', title: 'Not Found', status: 404
      })
    }

    // A dönTŐ ellenőrzés: ezt a kulcsot MI írtuk oda, egy katalógusképhez?
    const known = await queryOne<{ id: string }>(
      'SELECT id::text FROM anime_images WHERE mirror_key = $1', [key])
    if (!known) {
      return await reply.code(404).send({
        type: 'about:blank', title: 'Not Found', status: 404
      })
    }

    const storage = mediaStorage()
    if (!storage) {
      return await reply.code(503).send({
        type: 'about:blank', title: 'Service Unavailable', status: 503,
        detail: 'A képtár nincs beállítva'
      })
    }

    const object = await getObject(storage, key)
    if (!object) {
      // A sor szerint ott kellene lennie, de nincs. Ez a tárhely és az
      // adatbázis eltérése — naplózzuk, mert ez nem a látogató hibája.
      request.log.warn({ key }, 'a tükrözött kép hiányzik a tárhelyről')
      return await reply.code(404).send({
        type: 'about:blank', title: 'Not Found', status: 404
      })
    }

    return await reply
      .header('cache-control', CACHE)
      .header('content-type', object.contentType)
      .send(object.body)
  })
}

export default routes
