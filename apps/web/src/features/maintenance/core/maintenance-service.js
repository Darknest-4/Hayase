/* global fetch */
// A karbantartás állapota a kliens oldalán.
//
// EGY FONTOS HATÁR: ez a modul MEGJELENÍT, nem véd. A `/v1/status` válasza
// alapján tudjuk, mit mutassunk — de ha egy kérés mégis átmenne, azt a
// SZERVER utasítja vissza. A 4. pont ezt kifejezetten kimondja: a frontend
// soha ne legyen biztonsági határ.
//
// Ezért itt nincs „letiltjuk a gombot és kész": a gomb letiltása kényelem, a
// tiltás a szerveren történik.

export const MODE = Object.freeze({
  OFF: 'OFF',
  SCHEDULED: 'SCHEDULED',
  ACTIVE: 'ACTIVE',
  DEGRADED: 'DEGRADED',
  READ_ONLY: 'READ_ONLY',
  EMERGENCY: 'EMERGENCY'
})

/** Ennyit várunk két lekérdezés között, amikor MEGY az oldal. */
export const IDLE_POLL_MS = 120_000
/** Karbantartás alatt sűrűbben — de nem agresszíven (25. pont). */
export const ACTIVE_POLL_MS = 20_000

/** Üres állapot: amíg nem tudunk semmit, az oldal működik. */
export function unknownStatus () {
  return {
    status: 'operational',
    mode: MODE.OFF,
    scope: 'global',
    title: null,
    message: null,
    startsAt: null,
    estimatedEnd: null,
    retryAfter: null,
    version: 0,
    video: null
  }
}

/**
 * @param {object} options `fetch`, `now`, `onChange(status)`
 */
export function createMaintenanceService (options = {}) {
  const request = options.fetch ?? fetch
  const now = options.now ?? (() => Date.now())
  const listeners = new Set()
  let current = unknownStatus()
  let timer = null
  let stopped = false
  let failures = 0

  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener(current) } catch (error) { console.error('[maintenance]', error) }
    }
  }

  const apply = (next) => {
    // A VERZIÓ dönti el, változott-e valami. Enélkül minden lekérdezés
    // értesítést váltana ki, és a felület húszmásodpercenként újraépülne.
    const changed = next.version !== current.version || next.mode !== current.mode
    current = next
    if (changed) notify()
    return changed
  }

  const poll = async () => {
    try {
      const response = await request('/v1/status', { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`státusz: ${response.status}`)
      const body = await response.json()
      failures = 0
      apply({ ...unknownStatus(), ...body })
    } catch (error) {
      /*
       * A LEKÉRDEZÉS HIBÁJA NEM KARBANTARTÁS.
       *
       * Ha nem érjük el a szervert, az lehet a mi hálózatunk is. Ilyenkor
       * MEGTARTJUK, amit tudunk — nem ugrunk karbantartási oldalra, és nem is
       * mondjuk azt, hogy minden rendben.
       */
      failures += 1
      if (failures === 1) console.warn('[maintenance] a státusz nem elérhető:', error.message)
    }
    schedule()
  }

  const schedule = () => {
    if (stopped) return
    clearTimeout(timer)
    const restricting = current.mode !== MODE.OFF && current.mode !== MODE.SCHEDULED
    // Hiba után ritkítunk: egy elérhetetlen szervert nem ver tovább a lap.
    const backoff = Math.min(failures, 4) * 15_000
    timer = setTimeout(() => { poll() }, (restricting ? ACTIVE_POLL_MS : IDLE_POLL_MS) + backoff)
  }

  return {
    get status () { return current },
    get restricting () {
      return current.mode !== MODE.OFF && current.mode !== MODE.SCHEDULED
    },
    /** Hány másodperc van hátra a következő változásig. `null`, ha nem tudjuk. */
    secondsLeft () {
      const target = current.estimatedEnd ?? current.startsAt
      if (!target) return Number.isFinite(current.retryAfter) ? current.retryAfter : null
      const left = Math.round((new Date(target).getTime() - now()) / 1000)
      return Number.isFinite(left) ? Math.max(0, left) : null
    },
    subscribe (listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Azonnali lekérdezés — az „Újra" gomb ezt hívja. */
    async refresh () {
      await poll()
      return current
    },
    start () {
      stopped = false
      poll()
    },
    stop () {
      stopped = true
      clearTimeout(timer)
      timer = null
    },
    /**
     * Egy válasz megvizsgálása: karbantartás-e.
     *
     * A SZERVER FEJLÉCE dönt, nem a státuszkód: egy 503 jöhet máshonnan is
     * (egy elhasalt függőség, egy túlterhelt végpont), és arra nem
     * karbantartási oldal jár.
     */
    isMaintenanceResponse (response) {
      return Boolean(response) && response.status === 503 &&
        String(response.headers?.get?.('x-yume-maintenance') ?? '') === 'true'
    }
  }
}
