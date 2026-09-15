// „Ez a suite nem a bejelentkezési kapuról szól."
//
// A `require_login` egy adatbázissorban él, tehát a tesztek eredménye attól
// függött, hogy az éppen használt példány privát-e. Amikor ez az egy sor
// átbillent, hatvanhárom teszt bukott el egyszerre tizenegy fájlban — és
// egyik sem azért, mert elromlott valami: névtelen kérésekre 401 jött a várt
// 200 / 404 / 400 / 413 helyett, még mielőtt a vizsgált kód lefutott volna.
//
// Egy teszt, ami a környezet egy beállításától függ, nem a termékről mond
// valamit, hanem arról a beállításról. Ezért mondja ki mindegyik suite, hogy
// milyen példányon akar futni — ahogy a privát viselkedést vizsgáló tesztek
// eddig is kimondták a magukét (`requiresLogin → true`).
//
// A site-settings.ts azért csoportosítja a beolvasókat egy exportált objektumra,
// hogy pontosan ezt lehessen: kicserélni az egyiket a teszt idejére, anélkül
// hogy a megosztott `site_settings` táblába írnánk.

import { after, beforeEach, mock } from 'node:test'

import { settings } from '../../src/modules/settings/site-settings.ts'

/**
 * A suite nyilvános példányon fut.
 *
 * A `describe` törzséből hívandó. Minden teszt előtt újra felteszi a helyettest,
 * mert több suite `mock.restoreAll()`-lal takarít a saját mockjai után — az
 * ezt is leszedné, és a suite közepétől megint 401-ek jönnének.
 */
export function publicInstance (): void {
  beforeEach(() => {
    mock.method(settings, 'requiresLogin', async () => false)
  })
  after(() => {
    mock.restoreAll()
  })
}
