// A feladatsor ébresztése — hogy az üresjárat ne kerüljön semmibe, és a
// felvétel mégse késsen.
//
// A PROBLÉMA, MÉRVE: a lekérdező hurok másodpercenként 22,2-szer kérdezte meg,
// van-e munka, miközben három perc alatt 8 feladat futott le. Éjjel-nappal,
// tranzakciónként BEGIN + SELECT + COMMIT, kapcsolatfoglalással.
//
// A KÉZENFEKVŐ MEGOLDÁS ROSSZ CSERE. Ha a hurok üresjáratban lassul, a
// lekérdezések megszűnnek — de egy frissen beütemezett webhook a visszalépés
// tetejéig vár. Mérve, tizenöt másodperces plafonnal: húsz másodperc alatt
// egyetlen feladatot sem vettek fel.
//
// A HELYES MEGOLDÁS a PostgreSQL saját `LISTEN`/`NOTIFY`-a. A beszúró
// megpingeli a csatornát, a worker egy külön kapcsolaton hallgatja, és a
// sávok azonnal felébrednek. Így az üresjárati lekérdezés hosszú lehet — az
// csak biztonsági háló arra az esetre, ha egy értesítés elveszne —, a
// felvétel mégis ezredmásodperces.
//
// Nem új infrastruktúra: ugyanaz az adatbázis, amit már használunk.

import pg from 'pg'

import { pool } from '../database/index.ts'

/** A csatorna neve. Egy YUME-példány egy csatornát használ. */
export const JOB_CHANNEL = 'yume_jobs'

/*
 * Az alvó sávok. Mindegyik egy függvényt hagy itt, amit az ébresztés meghív.
 * Tömb, nem halmaz: a sorrend nem számít, a duplikáció nem fordulhat elő (egy
 * sáv egyszerre egy helyen alszik), és a `splice(0)` egy lépésben üríti.
 */
const sleepers: Array<() => void> = []

/** Minden alvó sáv felébresztése. A hallgató és a tesztek hívják. */
export function wakeAll (): void {
  for (const wake of sleepers.splice(0)) wake()
}

/**
 * Alvás `ms` ideig, VAGY amíg munka nem érkezik.
 *
 * Ez váltja ki a `setTimeout`-ot a lekérdező hurokban. A visszatérés oka nem
 * érdekli a hívót: mindkét esetben egy új lekérdezés következik.
 */
export function sleepUntilWork (ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      const at = sleepers.indexOf(finish)
      if (at !== -1) sleepers.splice(at, 1)
      resolve()
    }

    /*
     * AZ IDŐZÍTŐ NEM `unref`-ELT, és ez fontos.
     *
     * Elsőre `unref`-eltem, hogy egy alvó sáv ne tartsa életben a folyamatot
     * leálláskor. Csakhogy egy `unref`-elt időzítő nem tartja életben az
     * eseményhurkot SEMMIKOR — tehát ha más nem fut, a hurok lefut, és az
     * ígéret sosem oldódik fel. A tesztek pontosan ezt mutatták:
     * „Promise resolution is still pending but the event loop has already
     * resolved". A biztonsági hálóból így lyukas háló lett.
     *
     * A leállítás a MEGSZAKÍTÁSI JELÉ, nem az időzítőé: egy alvó sáv arra
     * azonnal felébred, és a hurok tisztán ér véget.
     */
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
    sleepers.push(finish)
  })
}

/**
 * A hallgató.
 *
 * SAJÁT KAPCSOLATON, nem a készletből: a `LISTEN` a kapcsolathoz kötődik, és
 * egy készletbeli kapcsolat visszakerülne a többi lekérdezés alá.
 *
 * ÚJRAKAPCSOLÓDIK. Ez nem óvatoskodás: ma tanultuk meg, hogy egy
 * adatbázis-újraindítás mit csinál a hosszan élő kapcsolatokkal. Ha a
 * hallgató elveszik és nem tér vissza, az értesítések elmaradnak, a sor pedig
 * csendben a biztonsági hálóra, a hosszú lekérdezésre esik vissza — működik,
 * csak lassan, és semmi nem szól róla.
 */
/**
 * A csatornák, amikre figyelünk, és mi történjen egy értesítésre.
 *
 * EGY KAPCSOLAT, TÖBB CSATORNA. A karbantartási alrendszernek is kell
 * értesítés a gyorsítótára érvénytelenítéséhez, és a kézenfekvő megoldás egy
 * második `pg.Client` lenne — csakhogy egy hosszan élő kapcsolat nem ingyen
 * van: figyelni kell a hibáit, újra kell csatlakoztatni, és ha elfelejtjük,
 * csendben elnémul.
 *
 * A PostgreSQL egy kapcsolaton tetszőleges sok csatornát hallgat. A regiszter
 * ezt használja ki: aki figyelni akar valamire, feliratkozik, és a meglévő,
 * már újracsatlakozó kapcsolat kiszolgálja.
 */
const subscribers = new Map<string, Set<(payload: string) => void>>()

/**
 * Feliratkozás egy csatornára.
 *
 * Akkor is működik, ha a kapcsolat még nem áll: a `LISTEN` a csatlakozáskor
 * megy ki minden regisztrált csatornára. A visszaadott függvény leiratkozik.
 */
export function subscribe (channel: string, handler: (payload: string) => void): () => void {
  if (!/^[a-z_][a-z0-9_]*$/.test(channel)) {
    // A csatorna neve a `LISTEN` parancsba kerül, ahol nincs paraméterezés.
    // Ezért nem szabad szabad szöveget elfogadni.
    throw new Error(`érvénytelen csatornanév: ${channel}`)
  }
  if (!subscribers.has(channel)) subscribers.set(channel, new Set())
  subscribers.get(channel)!.add(handler)
  /*
   * A FELIRATKOZÁS MAGA ELINDÍTJA A KAPCSOLATOT, ha még nem áll.
   *
   * Enélkül a hallgató csak a WORKER folyamatban futott (a `runWorker`
   * indítja), az API folyamatban nem — és a karbantartás gyorsítótárát pont
   * ott kell érvényteleníteni, ahol a kérések érkeznek. A lejárati idő
   * biztonsági hálóként ott is helyreállt volna, de fél percnyi késéssel.
   */
  ensureListener()
  void listenOnActive(channel)
  return () => { subscribers.get(channel)?.delete(handler) }
}

/** Az éppen élő hallgató kapcsolat — hogy egy friss feliratkozás se maradjon le. */
let active: pg.Client | null = null

async function listenOnActive (channel: string): Promise<void> {
  if (!active) return
  try { await active.query(`LISTEN ${channel}`) } catch { /* a csatlakozáskor újra megy */ }
}

/** Fut-e már a hallgató. Egy folyamatban egy kapcsolat elég. */
let started = false
/** A futó hallgató leállítója — a folyamat rendezett lezárásához. */
let stopListenerFn: (() => void) | null = null

/**
 * A hallgató leállítása.
 *
 * KELL, és nem csak a takarítás kedvéért: egy élő PostgreSQL-kapcsolat
 * ÉLETBEN TARTJA az eseményhurkot. A tesztfuttató emiatt lefutott, mindent
 * zöldnek írt, és utána örökre várt — pontosan ez történt az első futáson,
 * miután a karbantartás feliratkozása az API folyamatban is elindította a
 * hallgatót.
 */
export function stopListener (): void {
  stopListenerFn?.()
  stopListenerFn = null
  started = false
}

/**
 * A hallgató kapcsolat, ha még nincs.
 *
 * Idempotens: akárhányszor hívható. A feladatsor és a karbantartás egyaránt
 * ezt hívja, és ugyanazt a kapcsolatot kapják.
 */
export function ensureListener (signal?: AbortSignal): void {
  if (started) return
  started = true
  connectListener(signal)
}

export function listenForJobs (signal?: AbortSignal): void {
  subscribers.set(JOB_CHANNEL, subscribers.get(JOB_CHANNEL) ?? new Set())
  ensureListener(signal)
}

function connectListener (signal?: AbortSignal): void {
  let client: pg.Client | null = null
  let stopped = false
  let delay = 1_000

  const stop = (): void => {
    stopped = true
    started = false
    void client?.end().catch(() => {})
    client = null
    active = null
  }
  stopListenerFn = stop
  signal?.addEventListener('abort', stop, { once: true })

  const connect = async (): Promise<void> => {
    if (stopped) return
    try {
      const next = new pg.Client({ connectionString: process.env.DATABASE_URL })
      // A hibafigyelő ELŐBB, mint a kapcsolódás: egy bontott kapcsolat
      // `error` eseménye figyelő nélkül kilőné a folyamatot.
      next.on('error', error => {
        console.error('a feladatsor hallgatója elvesztette a kapcsolatot:', (error as Error).message)
        void next.end().catch(() => {})
        if (client === next) { client = null; active = null }
        schedule()
      })
      await next.connect()
      // MINDEN regisztrált csatorna, nem csak a feladatsoré. Újracsatlakozás
      // után is: enélkül egy adatbázis-újraindítás után a karbantartás
      // értesítései csendben elmaradnának.
      for (const channel of subscribers.keys()) await next.query(`LISTEN ${channel}`)
      next.on('notification', message => {
        if (message.channel === JOB_CHANNEL) wakeAll()
        for (const handler of subscribers.get(message.channel) ?? []) {
          try { handler(message.payload ?? '') } catch (error) {
            console.error(`a(z) ${message.channel} csatorna figyelője hibázott:`, (error as Error).message)
          }
        }
      })
      client = next
      active = next
      delay = 1_000
    } catch (error) {
      console.error('a feladatsor hallgatója nem tudott kapcsolódni:', (error as Error).message)
      schedule()
    }
  }

  const schedule = (): void => {
    if (stopped) return
    const wait = delay
    delay = Math.min(delay * 2, 30_000)
    setTimeout(() => { void connect() }, wait).unref?.()
  }

  void connect()
}

/**
 * Értesítés arról, hogy munka érkezett.
 *
 * Legjobb szándék szerint: ha az értesítés nem megy ki, a sor a hosszú
 * lekérdezésen akkor is megtalálja a feladatot. Egy elhasalt `NOTIFY` nem
 * buktathatja el a beszúrást, ami már megtörtént.
 */
/**
 * Értesítés egy tetszőleges csatornára.
 *
 * Legjobb szándék szerint, mint a `notifyJob`: ami már megtörtént az
 * adatbázisban, azt egy elhasalt értesítés nem teheti meg nem történtté. A
 * hívó oldalán ezért mindig kell egy lejárati idős biztonsági háló is.
 */
export async function notifyChannel (channel: string, payload = ''): Promise<void> {
  try {
    await pool.query('SELECT pg_notify($1, $2)', [channel, payload])
  } catch (error) {
    console.error(`a(z) ${channel} értesítés nem ment ki:`, (error as Error).message)
  }
}

export async function notifyJob (queue: string): Promise<void> {
  try {
    await pool.query('SELECT pg_notify($1, $2)', [JOB_CHANNEL, queue])
  } catch {
    // A sor a lekérdezésen is megtalálja. Nem érdemes érte hibát dobni.
  }
}
