// Cloudflare Turnstile — emberpróba a hitelesítési végpontokon.
//
// MIT VÉD. Nem a jelszót: azt a sebességkorlát és a drága hasítás védi. Ez a
// TÖMEGET fogja — a percenként húsz kitalált e-mail-címmel nyitott fiókot, a
// végigpróbált jelszólistát, az idegen postaládára zúdított jelszó-emlékeztetőt.
// Egy ilyen kérés önmagában szabályos; csak az a gyanús benne, hogy nem ember
// küldte.
//
// KIKAPCSOLVA ALAPÉRTELMEZÉS SZERINT. Kulcsok nélkül a modul minden kérést
// átenged, és ezt nem kell külön beállítani: egy friss telepítésen nincs
// Cloudflare-fiók, és egy ellenőrzés, ami titok híján mindenkit kizár, nem
// biztonság, hanem kiesés. A kikapcsoláshoz elég a titkot kivenni a `.env`-ből
// — ez az a fogantyú, amihez éjjel is hozzá lehet nyúlni.
//
// ──────────────────────────────────────────────────────────────────────────
// A HIBA IRÁNYA — ez a fájl legfontosabb döntése
// ──────────────────────────────────────────────────────────────────────────
//
// Egy emberpróba kétféleképpen hibázhat, és a kettőt NEM szabad egyformán
// kezelni:
//
//   * A LÁTOGATÓ oldalán — nincs token, lejárt, már felhasználták, nem
//     stimmel a művelet vagy a gazda. Ilyenkor ZÁRUNK. Pontosan ez a
//     dolgunk;
//
//   * A MI oldalunkon — rossz titok, hálózati hiba, időtúllépés, a Cloudflare
//     kiesése. Ilyenkor ÁTENGEDÜNK, és hangosan naplózunk.
//
// A második azért van így, mert a másik választás elfogadhatatlan: egy
// Cloudflare-kiesés nem zárhatja ki a tulajdonost a saját oldaláról, és nem
// állíthatja meg a regisztrációt olyan hibából, amiről a látogató nem tehet.
// Ilyenkor a sebességkorlát továbbra is áll — a védelem gyengül, de nem tűnik
// el, és a napló megmondja, hogy épp gyengébb.
//
// A csendes átengedés lenne a rossz megoldás. Ezért nem csendes.

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** A Cloudflare ennyinél hosszabb tokent nem ad; ami hosszabb, az nem tőle van. */
const MAX_TOKEN_LENGTH = 2048

/** Tíz másodperc. Ennél tovább egy belépés nem várhat egy külső szolgáltatásra. */
const TIMEOUT_MS = 10_000

/** A védhető végpontok. A `TURNSTILE_PROTECT` ezek közül válogat. */
export const PROTECTABLE = ['register', 'login', 'forgot'] as const
export type Protected = typeof PROTECTABLE[number]

/**
 * A HELYSZÍN KULCSA NYILVÁNOS — a kliensbe kerül, és ez rendben van.
 *
 * A Turnstile két kulcsot ad: a helyszínét (`site key`), ami a widget HTML-jébe
 * megy, és a titkot, ami sosem hagyja el a kiszolgálót. A kettő összekeverése
 * a klasszikus hiba, ezért van két külön függvény, és ezért nincs olyan
 * export, ami a titkot visszaadná.
 */
export function siteKey (): string | null {
  const value = process.env.TURNSTILE_SITE_KEY?.trim()
  return value ? value : null
}

/** Be van-e egyáltalán állítva. Mindkét kulcs kell hozzá. */
export function enabled (): boolean {
  return Boolean(siteKey()) && Boolean(process.env.TURNSTILE_SECRET_KEY?.trim())
}

/**
 * Védett-e ez a végpont.
 *
 * A `TURNSTILE_PROTECT` vesszős lista; beállítás nélkül az alapértelmezés áll.
 *
 * AZ ALAPÉRTELMEZÉSBEN NINCS BENNE A `forgot`, és ez nem feledékenység. Egy
 * emberpróba csak ott működik, ahol van űrlap, ami tokent tud szerezni — a
 * jelszó-emlékeztetőnek a webkliensben ma NINCS ilyen űrlapja. Bevenni annyi
 * lenne, mint csendben bezárni egy végpontot: minden hívása 403-at kapna, és
 * senki nem tudná, miért. Amikor készül hozzá felület, a lista bővíthető:
 *
 *     TURNSTILE_PROTECT=register,login,forgot
 *
 * A belépés BENNE VAN, mert arra van űrlap, és mert a jelszólista-próbálgatás
 * pont az a minta, amit a sebességkorlát önmagában lassít, de nem állít meg.
 */
const PROTECT_BY_DEFAULT: Protected[] = ['register', 'login']

export function protects (what: Protected): boolean {
  if (!enabled()) return false
  const raw = process.env.TURNSTILE_PROTECT?.trim()
  if (!raw) return PROTECT_BY_DEFAULT.includes(what)
  return raw.split(',').map(s => s.trim().toLowerCase()).includes(what)
}

/**
 * Mely gazdanevekről fogadunk el tokent.
 *
 * A Cloudflare megmondja, MELYIK oldalon futott a widget. Ha ezt nem néznénk,
 * egy máshol szerzett token is jó lenne — a helyszín kulcsa nyilvános, tehát
 * bárki kitehetné a saját lapjára.
 *
 * A lista a `PUBLIC_URL` gazdájából indul, és a `TURNSTILE_HOSTNAMES`
 * egészíti ki. Üres listánál NEM ellenőrzünk: egy olyan telepítésen, ahol a
 * `PUBLIC_URL` sincs beállítva, egy kitalált gazdanév mindenkit kizárna.
 */
export function allowedHostnames (): string[] {
  const names = new Set<string>()
  const publicUrl = process.env.PUBLIC_URL?.trim()
  if (publicUrl) {
    try { names.add(new URL(publicUrl).hostname.toLowerCase()) } catch { /* elrontott beállítás */ }
  }
  for (const name of (process.env.TURNSTILE_HOSTNAMES ?? '').split(',')) {
    const clean = name.trim().toLowerCase()
    if (clean) names.add(clean)
  }
  return [...names]
}

export interface Verdict {
  ok: boolean
  /** Egy mondat a látogatónak, ha visszautasítjuk. */
  detail?: string
  /** Amit a naplóba írunk. Sosem megy ki válaszban. */
  reason?: string
  /** Átengedtük-e a SAJÁT hibánk miatt. Ilyenkor a napló hangos. */
  degraded?: boolean
}

const PASS: Verdict = { ok: true }

/**
 * A titok kitörlése abból, ami naplóba megy.
 *
 * Nem elméleti óvatosság: a titok a kérés TÖRZSÉBEN utazik, és egy hálózati
 * hiba üzenete előbb-utóbb tartalmazza azt, amit a könyvtár épp a kezében
 * tartott. Egy naplófájlba került titok évekig ott ül, és senki nem néz rá.
 *
 * Itt a végén szűrünk, nem a hívási helyeken: egy „ne felejtsd el kiszűrni"
 * szabály pontosan egyszer szokott elfelejtődni.
 */
function scrub (text: string): string {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim()
  return secret ? text.split(secret).join('«titok»') : text
}

/**
 * A MI oldalunk hibái. Ezekre átengedünk.
 *
 * `invalid-input-secret` és `bad-request` azt jelenti, hogy a beállításunk
 * rossz — ettől egyetlen látogató sem lesz gyanús. Ha ezekre zárnánk, egy
 * elgépelt titok az egész hitelesítést leállítaná, és a hibaüzenetből a
 * látogató annyit látna, hogy „nem sikerült az ellenőrzés".
 */
const OUR_FAULT = new Set(['invalid-input-secret', 'missing-input-secret', 'bad-request', 'internal-error'])

/**
 * Egy token ellenőrzése.
 *
 * `action`: amit a widget a kliensen deklarált. A Cloudflare visszaadja, és
 * összevetjük — enélkül egy regisztrációra szerzett token belépésre is jó
 * lenne, és fordítva.
 */
export async function verify (
  token: unknown,
  remoteIp: string | null,
  action: Protected,
  log?: { warn: (data: unknown, message: string) => void }
): Promise<Verdict> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim()
  if (!secret || !siteKey()) return PASS

  // ---- a látogató oldala: ami eleve nem lehet jó ----
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, detail: 'Hiányzik az emberpróba. Frissítsd az oldalt, és próbáld újra.', reason: 'nincs token' }
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, detail: 'Érvénytelen emberpróba.', reason: `túl hosszú token (${token.length})` }
  }

  const body = new URLSearchParams({ secret, response: token })
  // A cím SEGÍT a Cloudflare-nek, de nem kötelező — és ha a `TRUST_PROXY`
  // rosszul áll, egy hibás cím rontana, nem javítana. Csak ha van.
  if (remoteIp) body.set('remoteip', remoteIp)

  let payload: {
    success?: boolean
    action?: string
    hostname?: string
    'error-codes'?: string[]
  }
  try {
    const response = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    payload = await response.json() as typeof payload
  } catch (error) {
    // A MI oldalunk: a Cloudflare nem válaszolt. Átengedünk, hangosan.
    log?.warn(
      { action, err: scrub((error as Error).message) },
      'AZ EMBERPRÓBA NEM FUTOTT LE, és a kérést átengedtük. A Cloudflare nem ' +
      'válaszolt. A sebességkorlát továbbra is áll; ha ez tartós, vedd ki a ' +
      'TURNSTILE_SECRET_KEY sort, hogy a napló ne teljen meg.'
    )
    return { ok: true, degraded: true, reason: scrub(`nem elérhető: ${(error as Error).message}`) }
  }

  const codes = Array.isArray(payload['error-codes']) ? payload['error-codes'] : []

  if (payload.success !== true) {
    if (codes.some(code => OUR_FAULT.has(code))) {
      log?.warn(
        { action, codes },
        'AZ EMBERPRÓBA A MI HIBÁNKBÓL BUKOTT EL, és a kérést átengedtük. ' +
        'Nézd meg a TURNSTILE_SECRET_KEY-t: a helyszín kulcsa és a titok egy ' +
        'widgethez tartozik-e.'
      )
      return { ok: true, degraded: true, reason: `saját hiba: ${codes.join(', ')}` }
    }
    return {
      ok: false,
      detail: 'Az emberpróba nem sikerült. Frissítsd az oldalt, és próbáld újra.',
      reason: `visszautasítva: ${codes.join(', ') || 'ok nélkül'}`
    }
  }

  // ---- a siker UTÁNI ellenőrzések ----
  // A `success: true` annyit jelent, hogy a token valódi és friss. Azt NEM,
  // hogy a mi oldalunkon, erre a műveletre szerezték.
  if (payload.action && payload.action !== action) {
    return {
      ok: false,
      detail: 'Az emberpróba nem ehhez a művelethez készült.',
      reason: `művelet nem egyezik: ${payload.action} ≠ ${action}`
    }
  }

  const allowed = allowedHostnames()
  if (allowed.length > 0 && payload.hostname && !allowed.includes(payload.hostname.toLowerCase())) {
    return {
      ok: false,
      detail: 'Az emberpróba nem erről az oldalról származik.',
      reason: `idegen gazda: ${payload.hostname}`
    }
  }

  return PASS
}
