// A szolgáltatók regisztere.
//
// KÉT FORRÁSBÓL ÁLL, ÉS EZ SZÁNDÉKOS:
//
//   a KÓD mondja meg, mit TUD egy szolgáltató (az adapter maga);
//   a TÁBLA mondja meg, HASZNÁLJUK-E, és milyen sorrendben.
//
// Ezért nem lehet egy szolgáltatót „regisztrálni" az adatbázisból: kód nélkül
// nincs mit hívni. És ezért nem lehet kikapcsolni a kódból: az üzemeltető
// döntése nem telepítés kérdése.
//
// A MEGSZŰNT SZOLGÁLTATÓ ELTÁVOLÍTÁSA EGY KAPCSOLÓ. Ha egy oldal holnap
// eltűnik, az `enabled = false` elég: a feloldás átlép rajta, a lejátszó nem
// tud róla, és az adaptert ráérünk később kiszedni. A sora megmarad, tehát a
// beállításai is — ha visszajön, nem kell újra beállítani.

import { query } from '../../infrastructure/database/index.ts'

import type { AnimeProvider } from './types.ts'

/** Egy szolgáltató a regiszterben: az adapter és a hozzá tartozó döntések. */
export interface RegisteredProvider {
  provider: AnimeProvider
  enabled: boolean
  priority: number
  label: string
  config: Record<string, unknown>
}

interface Row {
  slug: string
  label: string | null
  enabled: boolean
  priority: number
  config: Record<string, unknown>
}

/** Amit a kód regisztrált. Kulcs: `provider.id`. */
const adapters = new Map<string, AnimeProvider>()

/**
 * A táblából olvasott döntések, rövid életű gyorsítótárral.
 *
 * MIÉRT GYORSÍTÓTÁR. A feloldás forró út: egy lejátszásindítás nem futtathat
 * egy `SELECT`-et minden szolgáltatóra. Tíz másodperc elég rövid ahhoz, hogy
 * egy adminfelületen átállított kapcsoló azonnalinak érződjön, és elég hosszú
 * ahhoz, hogy egy nézői roham ne terhelje az adatbázist.
 *
 * Az adminfelület ezen felül `forget()`-et hív, tehát ott a hatás AZONNALI —
 * a tíz másodperc csak a másik példányra vonatkozik, ahol a változás nem
 * történt.
 */
const TTL_MS = 10_000
let cache: { at: number, rows: Map<string, Row> } | null = null

/**
 * Egy adapter bejelentkezése.
 *
 * Azonos azonosítóval kétszer: az UTOLSÓ nyer, és ez nem véletlen — egy teszt
 * így tud hamis adaptert tenni egy valódi helyére anélkül, hogy a regiszter
 * külön „tesztüzemmódot" ismerne.
 */
export function register (provider: AnimeProvider): void {
  adapters.set(provider.id, provider)
}

/** Csak tesztekhez: üres lap. */
export function reset (): void {
  adapters.clear()
  cache = null
}

/** A gyorsítótár eldobása — az adminfelület hívja írás után. */
export function forget (): void {
  cache = null
}

/** Minden regisztrált adapter, a táblától függetlenül. */
export function known (): AnimeProvider[] {
  return [...adapters.values()]
}

async function decisions (): Promise<Map<string, Row>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows
  let rows: Row[] = []
  try {
    rows = await query<Row>('SELECT slug, label, enabled, priority, config FROM providers')
  } catch (error) {
    /*
     * AZ ADATBÁZIS ELÉRHETETLEN — és ilyenkor NEM engedünk mindent.
     *
     * Ha a táblát nem tudjuk elolvasni, nem tudjuk, mit kapcsoltak ki. Egy
     * kikapcsolt szolgáltató kikapcsolva marad a legutóbb ismert állás
     * szerint; ha soha nem olvastuk, üres a lista, és akkor az
     * alapértelmezés dönt (lásd `ranked`).
     */
    console.error('a szolgáltatók beállítása nem olvasható', error)
    return cache?.rows ?? new Map()
  }
  const map = new Map(rows.map(row => [row.slug, row]))
  cache = { at: Date.now(), rows: map }
  return map
}

/**
 * A használható szolgáltatók, próbálkozási sorrendben.
 *
 * SORREND: prioritás, majd azonosító. Az egészség NEM itt számít bele — azt a
 * `resolve.ts` veszi figyelembe, mert az egy pillanatnyi állapot, ez pedig egy
 * beállítás. A kettő keverése oda vezetne, hogy egy adminfelületen látott
 * sorrend nem az, ami tényleg fut.
 *
 * AMIHEZ NINCS SOR A TÁBLÁBAN, az BE VAN KAPCSOLVA. Egy frissen telepített
 * adapter működjön anélkül, hogy valaki kézzel felvenné — a kikapcsolás a
 * kifejezett döntés, nem a bekapcsolás.
 */
export async function ranked (): Promise<RegisteredProvider[]> {
  const rows = await decisions()
  return [...adapters.values()]
    .map(provider => {
      const row = rows.get(provider.id)
      return {
        provider,
        enabled: row?.enabled ?? true,
        priority: row?.priority ?? provider.defaultPriority ?? 100,
        label: row?.label ?? provider.label,
        config: row?.config ?? {}
      }
    })
    .filter(entry => entry.enabled)
    .sort((a, b) => a.priority - b.priority || a.provider.id.localeCompare(b.provider.id))
}

/** Minden szolgáltató a döntéseivel — a kikapcsoltak IS. Az adminfelületnek. */
export async function all (): Promise<RegisteredProvider[]> {
  const rows = await decisions()
  return [...adapters.values()]
    .map(provider => {
      const row = rows.get(provider.id)
      return {
        provider,
        enabled: row?.enabled ?? true,
        priority: row?.priority ?? provider.defaultPriority ?? 100,
        label: row?.label ?? provider.label,
        config: row?.config ?? {}
      }
    })
    .sort((a, b) => a.priority - b.priority || a.provider.id.localeCompare(b.provider.id))
}

/**
 * Egy szolgáltató beállításának írása.
 *
 * `UPSERT`, mert a sor hiánya nem jelent semmit: az alapértelmezés szerint
 * működik, és az első kapcsolás hozza létre a sort.
 */
export async function setState (
  slug: string,
  patch: { enabled?: boolean, priority?: number, label?: string | null }
): Promise<void> {
  if (!adapters.has(slug)) throw new Error(`nincs ilyen szolgáltató: ${slug}`)
  const current = (await decisions()).get(slug)
  const adapter = adapters.get(slug)!
  await query(
    `INSERT INTO providers (slug, label, enabled, priority)
          VALUES ($1, $2, $3, $4)
     ON CONFLICT (slug) DO UPDATE
            SET label = EXCLUDED.label,
                enabled = EXCLUDED.enabled,
                priority = EXCLUDED.priority,
                updated_at = now()`,
    [
      slug,
      patch.label !== undefined ? patch.label : (current?.label ?? null),
      patch.enabled ?? current?.enabled ?? true,
      patch.priority ?? current?.priority ?? adapter.defaultPriority ?? 100
    ]
  )
  forget()
}
