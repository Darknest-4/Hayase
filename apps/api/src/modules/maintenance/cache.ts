// A gyorsítótár — a 7. és 8. pont.
//
// A SZABÁLY: kérésenként NINCS adatbázis-lekérdezés. A karbantartás
// ellenőrzése minden egyes HTTP-kérésen lefut, és egy lekérdezés ott azt
// jelentené, hogy a karbantartási rendszer maga a legnagyobb terhelés az
// adatbázison — pont akkor, amikor az adatbázissal lehet a baj.
//
//   PostgreSQL → beállítás → memória → döntés → kérés
//
// Három dolog tartja frissen, és mind a három kell:
//
//   1. LISTEN/NOTIFY — azonnali, de elveszhet;
//   2. LEJÁRATI IDŐ — lassabb, de nem veszhet el;
//   3. INDULÁSI BEOLVASÁS — mert egy friss folyamat semmit nem tud.
//
// ---------------------------------------------------------------------------
// MI TÖRTÉNIK, HA AZ ADATBÁZIS NEM ELÉRHETŐ (8. pont)
//
// A szabály KIMONDVA, mert két rossz kimenetel között kell választani:
//
//   * ha nincs semmilyen ismert beállításunk (hidegindítás + halott
//     adatbázis), akkor NYITVA MARADUNK. Egy rövid kapcsolathiba miatt nem
//     küldünk mindenkit karbantartási oldalra — az a hiba sokkal gyakoribb és
//     sokkal látványosabb, mint az ellenkezője;
//
//   * ha VAN utolsó ismert jó beállításunk, azt TARTJUK, akármeddig. Ez az,
//     ami miatt egy vészhelyzet nem oldódik fel magától attól, hogy az
//     adatbázis elérhetetlen lett: a lezárás megmarad, amíg valaki fel nem
//     oldja.
//
// A kettő együtt determinisztikus: az állapot sosem „ugrik" egy hiba miatt,
// legfeljebb megáll az időben.

import { loadCurrent } from './repository.ts'
import { notifyChannel, subscribe } from '../../infrastructure/queue/wake.ts'
import { offConfig, type MaintenanceConfig } from './policy.ts'

/** A csatorna, amin a példányok szólnak egymásnak. */
export const MAINTENANCE_CHANNEL = 'yume_maintenance_changed'

/**
 * Biztonsági frissítés. Az értesítés az elsődleges út; ez az, ami akkor is
 * helyreállít, ha egy értesítés elveszett.
 *
 * Harminc másodperc: ennyi késés egy karbantartás bekapcsolásánál elfogadható
 * (a bekapcsoló példány azonnal tudja, a többi legfeljebb ennyivel később), és
 * elég ritka ahhoz, hogy a lekérdezés ne számítson terhelésnek.
 */
export const TTL_MS = 30_000

let current: MaintenanceConfig | null = null
let readAt = 0
let inFlight: Promise<MaintenanceConfig> | null = null
let listening = false
let lastError: string | null = null

/**
 * A betöltő — cserélhető.
 *
 * NEM kényelmi mankó a teszteknek: ez a modul egyetlen külső függése, és a
 * viselkedése attól függ, hogy a betöltés SIKERÜL-E. Az „mi történik, ha az
 * adatbázis eltűnik" kérdésre másképp nem lehet választ adni, mint hogy a
 * betöltés elhasal — és egy ES-modul exportját nem lehet kívülről kicserélni.
 *
 * A seam tehát itt van, kimondva, egy helyen.
 */
let load: () => Promise<MaintenanceConfig | null> = loadCurrent

/** A betöltő cseréje. Az alapértelmezettre `setLoader(null)` állít vissza. */
export function setLoader (next: (() => Promise<MaintenanceConfig | null>) | null): void {
  load = next ?? loadCurrent
}

/** Minden állapot eldobása — teszthez és hidegindítás szimulálásához. */
export function reset (): void {
  current = null
  readAt = 0
  inFlight = null
  lastError = null
}

/** A gyorsítótár állapota — az admin felület és a diagnosztika kérdezi. */
export function stats (): { version: number, ageMs: number, hasConfig: boolean, lastError: string | null } {
  return {
    version: current?.version ?? 0,
    ageMs: readAt ? Date.now() - readAt : -1,
    hasConfig: current !== null,
    lastError
  }
}

/**
 * Beolvasás az adatbázisból.
 *
 * EGYSZERRE EGY: ha tíz kérés egyszerre veszi észre, hogy lejárt a
 * gyorsítótár, akkor is egy lekérdezés megy ki. Enélkül egy hideg
 * gyorsítótár egy forgalmas pillanatban lekérdezés-özönt indítana.
 */
async function refresh (): Promise<MaintenanceConfig> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const loaded = await load()
      if (loaded) {
        current = loaded
        readAt = Date.now()
        lastError = null
      }
      // Üres tábla: nincs mit tartani, de ez nem hiba — „nincs karbantartás".
      return current ?? offConfig()
    } catch (error) {
      lastError = (error as Error).message
      // AZ UTOLSÓ ISMERT JÓ ÁLLAPOT MARAD. Az `readAt` NEM frissül, tehát a
      // következő kérés újra megpróbálja — de addig sem esünk szét.
      return current ?? offConfig()
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/**
 * A jelenlegi beállítás. EZT hívja a köztesréteg minden kérésnél.
 *
 * Szinkron a gyakori úton: ha a gyorsítótár friss, egy mezőolvasás. A
 * frissítés a háttérben indul, és a MOSTANI kérés még a régi értékkel megy
 * tovább — mert egy karbantartás fél másodperces késése senkinek nem fáj, egy
 * adatbázis-lekérdezés a kérési úton viszont mindenkinek.
 */
export function config (): MaintenanceConfig {
  if (current && Date.now() - readAt < TTL_MS) return current
  void refresh()
  return current ?? offConfig()
}

/** Ugyanaz, de megvárja a beolvasást. Induláshoz és az admin felülethez. */
export async function configNow (): Promise<MaintenanceConfig> {
  if (current && Date.now() - readAt < TTL_MS) return current
  return refresh()
}

/**
 * Azonnali érvénytelenítés — a saját példányon.
 *
 * A módosító példány ezt hívja, hogy a saját válaszai már az újat mutassák,
 * mielőtt az értesítés körbeérne.
 */
export function invalidate (): void {
  readAt = 0
}

/** Szólás a többi példánynak. Legjobb szándék szerint — a TTL a háló alatta. */
export async function announce (version: number): Promise<void> {
  invalidate()
  await notifyChannel(MAINTENANCE_CHANNEL, String(version))
}

/**
 * Feliratkozás a változásokra.
 *
 * A meglévő, újracsatlakozó hallgató kapcsolatot használja — nem nyit
 * másodikat. Ha az a kapcsolat elveszik és visszatér, ez a feliratkozás vele
 * együtt áll helyre.
 */
export function watch (): void {
  if (listening) return
  listening = true
  subscribe(MAINTENANCE_CHANNEL, () => {
    invalidate()
    // Azonnal be is olvassuk: így a következő kérés már a frisset kapja,
    // nem egy elavultat egy háttérfrissítés közben.
    void refresh()
  })
}
