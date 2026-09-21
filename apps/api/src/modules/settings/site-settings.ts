// Site settings: the handful of key/value rows an administrator can change.
//
// Read on paths that run on every request — registration, the login gate — so
// they are cached rather than fetched each time. The cache is invalidated on
// write instead of merely expiring, so "Saved" in the admin panel means the
// next request already sees it. The TTL is the backstop for the case the
// invalidation cannot cover: a second app instance, which writes to the same
// database but holds its own cache.
//
// Why this file exists at all: `registration_open` and `require_login` were
// stored, echoed back to the client, and enforced *nowhere*. An administrator
// closing registration got a "Saved" toast and an instance that kept accepting
// registrations. A setting that does not change behaviour is worse than a
// missing one — it is a control that lies about what it did.
//
// The readers are grouped on one exported object rather than being loose
// named exports. Every caller reaches them through it at call time, which is
// what lets a test replace one for the length of a test without writing to
// `site_settings` — a shared table, in a suite whose files run in parallel
// against one database, where flipping `require_login` for a second would
// hand unrelated suites a 401.

import { query } from '../../infrastructure/database/index.ts'

export interface RateLimit { max: number, windowSeconds: number }
export interface RateLimits { global: RateLimit, auth: RateLimit, write: RateLimit, refresh: RateLimit }

/**
 * Az alapértékek, ugyanazok a környezeti változók, amik eddig is voltak.
 *
 * Nem seed és nem migráció: a beállítás hiánya azt jelenti, hogy „maradjon,
 * ahogy a telepítés mondja". Így egy panelen soha nem járt példány pontosan
 * úgy viselkedik, mint eddig.
 */
export function rateLimitDefaults (): RateLimits {
  // Függvény, nem konstans: a környezetet hívásonként olvassuk. Konstansként
  // az importáláskor rögzült volna, és egy teszt, ami a saját korlátját
  // állítja be a `buildApp()` előtt, a régi értéket kapta volna. A gyártásban
  // ez ugyanaz az érték; a különbség az, hogy mikor kérdezzük meg.
  /*
   * A GLOBÁLIS KORLÁT MÉRÉSBŐL, NEM TIPPBŐL.
   *
   * Megszámolva, mennyibe kerül egy valódi látogatás: a főoldal 13 API-kérés,
   * a többi képernyő 1–5, tehát egy átlagos oldalváltás ~5. A régi 300/perc
   * ezzel egyetlen látogatónak bőven elég lett volna — csakhogy a korlát
   * CÍMENKÉNT számol, és egy cím mögött sokan vannak:
   *
   *   * mobilszolgáltatói NAT — több száz előfizető egy címen;
   *   * munkahely, iskola, kollégium — egy kijárat;
   *   * a saját mérőfutásaink, amik közben 429-et kaptak.
   *
   * Húsz ember egy cím mögött 300/perc mellett fejenként három oldalt nézhet
   * meg percenként. Ez nem védelem, hanem egy elrontott élmény.
   *
   * 1200/perc mellett ugyanez húsz ember × tizenkét oldal. Egyetlen gépi
   * gyűjtőnek viszont továbbra is valódi plafon, és a MINTA-alapú védelem
   * (edge) ettől függetlenül fut: ott a nagy forgalom pontot ad, nem
   * mentességet.
   */
  /**
   * Egy környezeti változó értéke, ha értelmes szám — különben az alapérték.
   *
   * A `Number(process.env.X ?? alap)` csapda: egy ÜRES sztring nem nullish,
   * tehát átmegy a `??`-on, és `Number('')` az NULLA. Egy elfelejtett
   * `RATE_LIMIT_MAX=` sor így nem az alapértéket adta volna vissza, hanem
   * nulla kérés/percet — vagyis az egész oldal 429-et adna mindenkinek.
   */
  const fromEnv = (name: string, fallback: number): number => {
    const raw = process.env[name]
    if (raw === undefined || raw === null || raw.trim() === '') return fallback
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : fallback
  }

  return {
    global: { max: fromEnv('RATE_LIMIT_MAX', 1200), windowSeconds: 60 },
    // A belépés SZÁNDÉKOSAN szoros marad: ez a jelszókitalálás elleni védelem,
    // és tíz próbálkozás negyedóránként egy valódi embernek is elég.
    auth: { max: fromEnv('AUTH_RATE_LIMIT_MAX', 10), windowSeconds: 15 * 60 },
    // Az írás enyhül, de nem szabadul el: aki egy beszélgetésben aktívan
    // hozzászól, öt perc alatt harmincat is írhat.
    write: { max: fromEnv('WRITE_RATE_LIMIT_MAX', 60), windowSeconds: 5 * 60 },
    refresh: { max: fromEnv('REFRESH_RATE_LIMIT_MAX', 60), windowSeconds: 15 * 60 }
  }
}

const TTL_MS = 30_000

let cache: Record<string, unknown> | null = null
let readAt = 0

export const settings = {
  /** Drop the cache. Called by the write path so a change lands immediately. */
  invalidate (): void {
    cache = null
    readAt = 0
  },

  async load (): Promise<Record<string, unknown>> {
    if (cache && Date.now() - readAt < TTL_MS) return cache
    const rows = await query<{ key: string, value: unknown }>('SELECT key, value FROM site_settings')
    cache = Object.fromEntries(rows.map(row => [row.key, row.value]))
    readAt = Date.now()
    return cache
  },

  /**
   * May anybody still create an account here?
   *
   * Absent means yes. An instance that has never been configured should behave
   * like a normal public one, and only an explicit `false` closes the door —
   * otherwise a missing row would lock a fresh deployment out of its own first
   * account.
   */
  async registrationOpen (): Promise<boolean> {
    return (await settings.load()).registration_open !== false
  },

  /**
   * Is this a private instance?
   *
   * The inverse default, and for the same reason read the other way: absent
   * means public. Turning a site private is a deliberate act, and a missing
   * row must not do it by accident.
   */
  async requiresLogin (): Promise<boolean> {
    return (await settings.load()).require_login === true
  },

  /**
   * Is the instance refusing writes?
   *
   * The emergency lever. Absent means no, for the same reason the two above
   * default the permissive way: a missing row is an instance nobody has
   * configured, not one somebody froze.
   */
  async readOnly (): Promise<boolean> {
    return (await settings.load()).read_only === true
  },

  /**
   * May we talk to AniList and MyAnimeList?
   *
   * Absent means yes. This is the lever for an upstream that has started
   * returning nonsense, or that has started rate-limiting us into the ground —
   * the cost of leaving it on when it should be off is outbound traffic and
   * bad metadata written over good.
   */
  async externalSyncEnabled (): Promise<boolean> {
    return (await settings.load()).external_sync_enabled !== false
  },

  /** May we deliver outbound webhooks? Absent means yes. */
  async webhooksEnabled (): Promise<boolean> {
    return (await settings.load()).webhooks_enabled !== false
  },

  /** The site's name, for anywhere the server renders it. */
  async siteName (): Promise<string> {
    const value = (await settings.load()).site_name
    return typeof value === 'string' && value.trim() ? value.trim() : 'Yume'
  },

  /**
   * A sebességkorlátok, ahogy most érvényesek.
   *
   * Eddig kizárólag környezeti változók voltak, tehát az átállításuk
   * újraindítást jelentett — és az az egyetlen pillanat, amikor egy korlátot
   * állítani kell, az az, amikor épp folyik valami. Egy védelem, amihez
   * telepítés kell, nem védelem, hanem terv.
   *
   * A környezeti változó marad az alapérték: ha a beállítás hiányzik vagy
   * hibás, azt kapjuk, amit eddig. A panelen írt érték felülírja.
   *
   * Az ablak másodpercben tárolódik, nem „1 minute" alakban: egy számot lehet
   * ellenőrizni, egy szabad szöveget nem.
   */
  async rateLimits (): Promise<RateLimits> {
    const defaults = rateLimitDefaults()
    const stored = (await settings.load()).rate_limits
    const table = typeof stored === 'object' && stored !== null ? stored as Record<string, unknown> : {}

    const read = (name: keyof RateLimits): RateLimit => {
      const fallback = defaults[name]
      const row = table[name]
      if (typeof row !== 'object' || row === null) return fallback
      const { max, windowSeconds } = row as { max?: unknown, windowSeconds?: unknown }
      return {
        max: Number.isInteger(max) && (max as number) > 0 ? max as number : fallback.max,
        windowSeconds: Number.isInteger(windowSeconds) && (windowSeconds as number) > 0
          ? windowSeconds as number
          : fallback.windowSeconds
      }
    }

    return { global: read('global'), auth: read('auth'), write: read('write'), refresh: read('refresh') }
  }
}
