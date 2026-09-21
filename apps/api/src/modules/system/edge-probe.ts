// A KÜLSŐ szonda: az oldal onnan nézve, ahonnan a látogató látja.
//
// MIÉRT KELL, EGY VALÓDI KIESÉSBŐL. Az audit során az `app` konténer minden
// egészségjelzője zöld volt, az `api.latency_ms` mérőszám rendben, és közben a
// látogatók harminc másodpercig 503-at kaptak: a Caddy egészségellenőrzője a
// konténercsere alatt DNS-hibát kapott, leírta az upstreamet, és a következő
// próbáig senkit nem engedett át. A monitorozás EZT NEM LÁTTA — mert mindent
// belülről nézett.
//
// A különbség nem árnyalat. A belső szonda azt méri, hogy az alkalmazás él-e;
// ez azt, hogy AZ OLDAL MŰKÖDIK-E. A kettő eltérhet, és pont az eltérés az,
// ami miatt a kiesést kézzel kellett megtalálni.
//
// AMIT A HIBÁRÓL TUDNI KELL. Egy „nem megy" mérőszám semmit nem mond arról,
// hol keresd. A szonda ezért megkülönbözteti a hiba FAJTÁJÁT: a névfeloldás, a
// kapcsolat, a TLS és a HTTP-válasz külön dolog, és külön beavatkozást kíván.
//
// MONITORING-HUROK ELLEN. A szonda a `/v1/health`-et kéri, ami nem naplóz
// látogatottságot és nem indít feladatot. Egy percenkénti kérés nem lehet az
// oka annak, hogy a rendszer terhelt.

/** A szonda kimenetele. A számérték a mérőszámba megy, a név a naplóba. */
export type EdgeOutcome =
  | 'healthy'      // 2xx
  | 'http_4xx'
  | 'http_5xx'
  | 'timeout'
  | 'dns_failure'
  | 'tcp_failure'
  | 'tls_failure'
  | 'unknown'

export interface EdgeProbeResult {
  outcome: EdgeOutcome
  /** Számérték a `system_metrics`-hez: 1 = egészséges, 0 = nem. */
  status: 0 | 1
  /** Ezredmásodperc, vagy `null`, ha a kérés el sem jutott a válaszig. */
  latencyMs: number | null
  httpStatus: number | null
  detail: string | null
  /**
   * Hány egymás utáni szonda bukott el, ezzel együtt.
   *
   * A riasztás ERRE szól, nem az egyetlen mintára: egy elbukott kérés lehet egy
   * eldobott csomag, három egymás utáni már kiesés. Enélkül minden apró zavar
   * riasztást szülne, és a harmadik hamis riasztás után senki nem nézi őket.
   */
  downStreak: number
}

/**
 * A hiba FAJTÁJÁNAK megállapítása.
 *
 * A `fetch` egyetlen `TypeError: fetch failed`-et dob mindenre, a valódi ok a
 * `cause`-ban van. Ezt itt fejtjük ki, mert „a szonda elhasalt" üzenetből
 * hajnali háromkor nem derül ki, hogy a DNS ment el, a gép nem válaszol, vagy
 * a tanúsítvány járt le — és a három más-más beavatkozás.
 */
export function classify (error: unknown): { outcome: EdgeOutcome, detail: string } {
  const err = error as { name?: string, message?: string, cause?: { code?: string, message?: string } }
  const code = err?.cause?.code ?? ''
  const message = err?.cause?.message ?? err?.message ?? String(error)

  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || code === 'UND_ERR_HEADERS_TIMEOUT') {
    return { outcome: 'timeout', detail: 'a válasz nem érkezett meg időben' }
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { outcome: 'dns_failure', detail: `névfeloldás: ${code}` }
  }
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ECONNRESET') {
    return { outcome: 'tcp_failure', detail: `kapcsolat: ${code}` }
  }
  // A Node TLS-hibái nem egyetlen kódon jönnek; a nevük viszont beszédes.
  if (/CERT|SSL|TLS|self.signed|ALTNAME|DEPTH_ZERO/i.test(code + ' ' + message)) {
    return { outcome: 'tls_failure', detail: `TLS: ${code || message.slice(0, 80)}` }
  }
  return { outcome: 'unknown', detail: message.slice(0, 120) }
}

/**
 * Egy külső kérés az oldalra.
 *
 * Sosem dob: a hívó egy mérőszámot vár, nem kivételt. Egy monitorozás, ami
 * el tud hasalni, pont akkor hallgat el, amikor a legnagyobb szükség lenne rá.
 */
let consecutiveFailures = 0

export async function probeEdge (
  url = process.env.EDGE_PROBE_URL ?? process.env.PUBLIC_URL ?? '',
  timeoutMs = Number(process.env.EDGE_PROBE_TIMEOUT_MS ?? 10_000)
): Promise<EdgeProbeResult | null> {
  // `trim` előbb: egy csak szóközt tartalmazó beállítás NEM cím. Enélkül a
  // szonda a „   /v1/health"-et kérte volna le, és az eredmény egy hamis
  // „az oldal nem elérhető" riasztás lett volna egy elgépelés miatt.
  const target = url.trim().replace(/\/+$/, '')
  if (!target) return null // nincs mit mérni — nem hiba, csak nincs beállítva

  const started = Date.now()
  try {
    const res = await fetch(`${target}/v1/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
      headers: {
        // MEGNEVEZZÜK MAGUNKAT. Nem azért, hogy kivételt kapjunk — a szonda
        // ugyanazon a sebességkorláton és ugyanazon az élen megy át, mint
        // bárki más, és ez szándékos: ha a saját védelmünk kizárná a saját
        // oldalunkat, azt is meg kell tudnunk. Az azonosító a naplóban segít
        // elkülöníteni a szondát a valódi forgalomtól.
        'user-agent': 'YUME edge probe (internal monitoring)',
        accept: 'application/json'
      }
    })
    const latencyMs = Date.now() - started

    if (res.status >= 500) {
      return { outcome: 'http_5xx', status: 0, latencyMs, httpStatus: res.status, detail: `a kiszolgáló ${res.status}-t adott`, downStreak: ++consecutiveFailures }
    }
    if (res.status >= 400) {
      return { outcome: 'http_4xx', status: 0, latencyMs, httpStatus: res.status, detail: `a kérés ${res.status}-t kapott`, downStreak: ++consecutiveFailures }
    }
    if (res.status >= 300) {
      return { outcome: 'unknown', status: 0, latencyMs, httpStatus: res.status, detail: `váratlan átirányítás (${res.status})`, downStreak: ++consecutiveFailures }
    }
    consecutiveFailures = 0
    return { outcome: 'healthy', status: 1, latencyMs, httpStatus: res.status, detail: null, downStreak: 0 }
  } catch (error) {
    const { outcome, detail } = classify(error)
    return { outcome, status: 0, latencyMs: null, httpStatus: null, detail, downStreak: ++consecutiveFailures }
  }
}

/** Teszthez: a sorozatszámláló nullázása két eset között. */
export function resetStreak (): void { consecutiveFailures = 0 }
