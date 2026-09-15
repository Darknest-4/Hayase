// Közös beállítások a terhelésmérő forgatókönyvekhez.
//
// Egy dolgot érdemes itt az elején kimondani, mert a terhelésmérés legtöbb
// félreolvasása ebből jön:
//
//   A VU (virtual user) NEM kérés/másodperc.
//
// Egy VU egy embert utánoz: kér egy oldalt, aztán OLVASSA. A gondolkodási idő
// alatt nem terhel semmit. Egy valódi látogató percenként 6–20 kérést küld,
// nem hatvanat. Ezért 1000 VU ebben a mérésben nagyjából 150–350 kérés/mp —
// és a kettőt külön is kiírjuk minden jelentésben.
//
// Amit a VU-szám mér: hány ember lehet EGYSZERRE az oldalon.
// Amit a kérés/mp mér: mennyit dolgozik a kiszolgáló.
// A kettő aránya a viselkedés kérdése, nem a kiszolgálóé.

import { Counter, Rate, Trend } from 'k6/metrics'

/** Hová megy a terhelés. Alapból a mérőverem, SOHA nem az éles. */
export const BASE = __ENV.BASE_URL || 'http://127.0.0.1:4100'

/**
 * A sebességkorlát alóli kulcs.
 *
 * Enélkül a mérés 300 kérés/perc után a korlátot méri, nem a terméket. A
 * kivétel a forráscímhez és ehhez a kulcshoz van kötve — lásd
 * apps/api/src/middleware/load-test.ts.
 */
export const KEY = __ENV.LOAD_TEST_KEY || ''

/**
 * A mérőfiókok jelszava — az adatállományból, vagy környezetből.
 *
 * Azért kell, mert a frissítő token forog, és minden fokozat új k6-folyamat:
 * a vetett tokenek egy futás után halottak. Ezzel a mérés újra be tud lépni,
 * ahogy egy valódi felhasználó is tenné.
 */
export const PASSWORD = __ENV.LOAD_PASSWORD || 'load-test-password-9x'

/** Küldjünk-e írásokat (haladás, könyvtár, kedvencek). */
export const WRITES = (__ENV.WRITES || 'on') !== 'off'

/**
 * Gondolkodási idő szorzója. 1 = valósághű.
 *
 * Alacsonyabb érték nem „több felhasználót" jelent, hanem türelmetlenebbet:
 * ugyanannyi ember több kérést küld. Aki ezt elrontja, az VU-ban méri a
 * kérés/mp-et — lásd a fájl elejét.
 */
export const THINK = Number(__ENV.THINK || '1')

/** Egyetlen fokozat VU-száma. A futtató minden fokozatot külön futtat. */
export const VUS = Number(__ENV.VUS || '10')

/** Meddig tart a fokozat terhelt szakasza. */
export const DURATION = __ENV.DURATION || '3m'
export const RAMP = __ENV.RAMP || '30s'

// ---- saját mérőszámok ------------------------------------------------------
//
// A k6 beépített http_req_duration mindent egybemos. Egy kereső-lekérdezés és
// egy statikus konfigurációhívás nem ugyanaz a munka, és ha az összesített
// p95 megugrik, az első kérdés úgyis az, hogy MELYIK lépésen.

export const step = {
  home: new Trend('step_home', true),
  browse: new Trend('step_browse', true),
  search: new Trend('step_search', true),
  suggest: new Trend('step_suggest', true),
  details: new Trend('step_details', true),
  episodes: new Trend('step_episodes', true),
  sources: new Trend('step_sources', true),
  progress: new Trend('step_progress', true),
  library: new Trend('step_library', true),
  favorites: new Trend('step_favorites', true),
  continueWatching: new Trend('step_continue', true),
  schedule: new Trend('step_schedule', true),
  config: new Trend('step_config', true)
}

/** Nem-2xx arány. Ez a hibaarány, amit a jelentés kiír. */
export const failures = new Rate('yume_failed')
/** 429 külön: ha ez nem nulla, a mérés a korlátot méri, nem a terméket. */
export const limited = new Counter('yume_rate_limited')
/** Időtúllépés külön: ez más hiba, mint egy 500. */
export const timeouts = new Counter('yume_timeouts')
/** Állapotkódok eloszlása, osztályonként. */
export const statusClass = {
  c2xx: new Counter('yume_2xx'),
  c3xx: new Counter('yume_3xx'),
  c4xx: new Counter('yume_4xx'),
  c5xx: new Counter('yume_5xx'),
  c0: new Counter('yume_no_response')
}
/** Hány folyamatot fejezett be teljesen egy-egy profil. */
export const journeys = new Counter('yume_journeys')

/**
 * Küszöbök.
 *
 * Ezek nem díszek: a k6 elbukik, ha egy fokozat átlépi őket, és épp ez a
 * módszer arra, hogy a „meddig bírja" kérdésre szám jöjjön válaszul. Nem
 * megítéljük a fokozatot, hanem megmérjük, és a küszöb dönt.
 *
 * Az értékek annak felelnek meg, ami egy böngészőben még nem érződik
 * lassúnak: 500 ms alatt azonnali, 1 s fölött már látszik a várakozás.
 */
export const thresholds = {
  http_req_duration: ['p(95)<1000', 'p(99)<2500'],
  yume_failed: ['rate<0.01'],
  // Egyetlen 429 is elrontja a mérést: ilyenkor nem a terméket mérjük.
  yume_rate_limited: ['count<1'],
  yume_5xx: ['count<1'],
  step_search: ['p(95)<1200'],
  step_details: ['p(95)<800'],
  step_home: ['p(95)<1000']
}

/** A jelentéshez kért százalékos értékek. */
// A `count` nélkül a jelentésből hiányzik, hány hívásból jött egy szám — és
// egy p95 három mérésből nem ugyanaz az állítás, mint háromezerből.
export const summaryTrendStats = ['count', 'avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max']
