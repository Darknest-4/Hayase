// WAF — moduláris szabályréteg.
//
// AMIT EZ NEM AKAR LENNI: egyetlen nagy reguláris kifejezés, ami „mindent"
// megfog. Az ilyen szabály pontosan két dolgot csinál jól: megfogja a
// tankönyvi példákat, és megfogja a felhasználók felét, akik egy
// hozzászólásban leírják, hogy `1=1` vagy hogy `<script>`. Egy anime-oldalon a
// második gyakoribb, mint az első.
//
// AMIT EZ CSINÁL: nevesített szabályok, mindegyiknek saját súlyossága,
// pontszáma, hatóköre és be-/kikapcsolhatósága. Egy találat nem feltétlenül
// tiltás — pontot ad, és a döntést a policy hozza. Ez a különbség aközött,
// hogy „ez a kérés gyanús" és aközött, hogy „ez a kérés támadás".
//
// HOL VIZSGÁL: a lekérdezési sztringben, az útvonalban és a kéréstörzsben. A
// fejlécekben külön szabályok néznek (lásd `headers`).
//
// AMIT SZÁNDÉKOSAN NEM VIZSGÁL: a hozzászólások és értékelések szövegét
// tartalmi szabályokkal. Ott a védelem a paraméteres lekérdezés és a CSP, és
// azok tényleg védenek; egy WAF-szabály ott csak hamis riasztást termelne.
// Lásd a `skipBody` hatóköröket lent.

export type Severity = 'low' | 'medium' | 'high' | 'critical'

export interface Rule {
  /** Stabil azonosító. Ez kerül a naplóba és a tiltás indoklásába. */
  id: string
  /** Mit fog meg, egy mondatban, magyarul — ez jelenik meg a panelen. */
  title: string
  severity: Severity
  /** Hány kockázati pontot ad egy találat. */
  score: number
  /** Hol nézzen: útvonal, lekérdezés, törzs, fejléc. */
  where: Array<'path' | 'query' | 'body' | 'header'>
  test: RegExp
  /**
   * Útvonal-előtagok, ahol ez a szabály NEM fut. A false positive elleni
   * legfontosabb eszköz: a legtöbb hamis találat onnan jön, hogy egy
   * tartalmi végponton futtatunk kódinjekciós mintát.
   */
  except?: string[]
  enabled: boolean
}

export interface Hit {
  rule: string
  title: string
  severity: Severity
  score: number
  /** Hol találtuk. A megtalált SZÖVEGET nem tesszük el — az lehet jelszó. */
  at: 'path' | 'query' | 'body' | 'header'
}

/*
 * A tartalmi végpontok, ahol a felhasználó szövege él.
 *
 * Egy fórumhozzászólásban a `' OR 1=1--` nem támadás, hanem beszélgetés az
 * SQL-injekcióról; egy `<script>` egy kódrészletről szóló üzenetben ugyanez.
 * Ezeken a végpontokon a védelem a paraméteres lekérdezés és a CSP — mindkettő
 * a helyén van, és mindkettő tényleg véd. Egy mintaillesztés itt csak abban
 * segítene, hogy a felhasználók ne tudjanak a biztonságról beszélni.
 */
const USER_TEXT = ['/v1/comments', '/v1/forum', '/v1/chat', '/v1/reports', '/v1/reviews']

export const RULES: Rule[] = [
  // ---- SQL-injekció ----
  // Nem az „SQL-szavak" jelenlétét nézzük, hanem a SZERKEZETET: egy union
  // select, egy mindig igaz feltétel idézőjellel, egy megjegyzésbe zárt
  // utasításvég. Ezek egy URL-paraméterben nem fordulnak elő véletlenül.
  {
    id: 'sqli.union',
    title: 'UNION SELECT egy paraméterben',
    severity: 'critical',
    score: 60,
    where: ['query', 'path', 'body'],
    test: /\bunion\b[\s\S]{0,40}\bselect\b/i,
    except: USER_TEXT,
    enabled: true
  },
  {
    id: 'sqli.tautology',
    title: 'Mindig igaz feltétel idézőjellel',
    severity: 'high',
    score: 45,
    where: ['query', 'path'],
    // '1'='1, " or 1=1, ') or ('a'='a — idézőjel KELL hozzá, különben egy
    // `?page=1&limit=1` is találat lenne.
    test: /['"`]\s*(\)|\s)*\s*(or|and)\s+['"`]?[\w]+['"`]?\s*=\s*['"`]?[\w]+/i,
    except: USER_TEXT,
    enabled: true
  },
  {
    id: 'sqli.comment',
    title: 'Lezáró idézőjel és SQL-megjegyzés',
    severity: 'high',
    score: 40,
    where: ['query', 'path'],
    test: /['"`]\s*(--|#|\/\*)/,
    except: USER_TEXT,
    enabled: true
  },
  {
    id: 'sqli.stacked',
    title: 'Egymásra fűzött utasítás (; DROP/INSERT/UPDATE)',
    severity: 'critical',
    score: 60,
    where: ['query', 'path', 'body'],
    test: /;\s*(drop|truncate|alter|insert|update|delete)\s+\w/i,
    except: USER_TEXT,
    enabled: true
  },
  {
    id: 'sqli.function',
    title: 'Adatbázis-függvény hívása paraméterben',
    severity: 'high',
    score: 40,
    where: ['query', 'path'],
    test: /\b(pg_sleep|pg_read_file|load_file|benchmark|waitfor\s+delay|information_schema)\b/i,
    except: USER_TEXT,
    enabled: true
  },

  // ---- XSS ----
  // A CSP (`script-src 'self'`, unsafe-inline nélkül) az, ami élesben tényleg
  // megfogja az XSS-t — egy korábbi kör ezt mérte is. Ez a réteg a PONTSZÁMOT
  // adja, nem a védelmet: aki ilyet küld egy API-paraméterben, az próbálkozik.
  {
    id: 'xss.script',
    title: '<script> egy paraméterben',
    severity: 'high',
    score: 35,
    where: ['query', 'path'],
    test: /<\s*script\b|<\s*\/\s*script\s*>/i,
    except: USER_TEXT,
    enabled: true
  },
  {
    id: 'xss.handler',
    title: 'Inline eseménykezelő vagy javascript: séma',
    severity: 'medium',
    score: 25,
    where: ['query', 'path'],
    test: /\bon(error|load|click|mouseover|focus)\s*=|javascript:\s*[^/\s]/i,
    except: USER_TEXT,
    enabled: true
  },
  {
    id: 'xss.svg',
    title: 'Beágyazott SVG/iframe/object paraméterben',
    severity: 'medium',
    score: 25,
    where: ['query'],
    test: /<\s*(svg|iframe|object|embed|base)\b/i,
    except: USER_TEXT,
    enabled: true
  },

  // ---- útvonal-bejárás ----
  // A Fastify a legtöbbet amúgy is normalizálja; ez a kódolt változatokra és
  // a statikus kiszolgálóra való próbálkozásra megy.
  {
    id: 'traversal.dotdot',
    title: 'Könyvtárváltás az útvonalban (../)',
    severity: 'high',
    score: 45,
    where: ['path', 'query'],
    test: /(\.\.[/\\]){2,}|%2e%2e[/\\%]/i,
    enabled: true
  },
  {
    id: 'traversal.sensitive',
    title: 'Ismert rendszerfájl kérése',
    severity: 'critical',
    score: 60,
    where: ['path', 'query'],
    test: /\/(etc\/passwd|etc\/shadow|proc\/self\/environ|\.env|\.git\/config|id_rsa)\b/i,
    enabled: true
  },

  // ---- parancsinjekció ----
  {
    id: 'cmdi.shell',
    title: 'Héjparancs-elválasztó és ismert parancs',
    severity: 'critical',
    score: 55,
    where: ['query', 'body'],
    test: /[;|`]\s*(cat|curl|wget|nc|bash|sh|python|perl|chmod|rm)\s+[-/\w]/i,
    except: USER_TEXT,
    enabled: true
  },
  {
    id: 'cmdi.substitution',
    title: 'Parancsbehelyettesítés ($(…) vagy `…`)',
    severity: 'high',
    score: 40,
    where: ['query'],
    test: /\$\([^)]{2,}\)|`[^`]{3,}`/,
    except: USER_TEXT,
    enabled: true
  },

  // ---- szerveroldali kérés-hamisítás ----
  // A katalógus- és képvégpontok URL-t is kaphatnak; a belső címekre mutató
  // kérés ott a veszélyes.
  {
    id: 'ssrf.internal',
    title: 'Belső vagy metaadat-cím egy paraméterben',
    severity: 'critical',
    score: 55,
    where: ['query', 'body'],
    test: /\b(169\.254\.169\.254|metadata\.google|127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)\b/i,
    except: USER_TEXT,
    enabled: true
  },

  // ---- ismert felderítés ----
  // Nem támadás önmagában, de aki ezeket kéri, az nem a katalógust nézi.
  {
    id: 'probe.admin',
    title: 'Idegen rendszerek adminfelületének keresése',
    severity: 'medium',
    score: 30,
    where: ['path'],
    test: /\/(wp-admin|wp-login|xmlrpc\.php|phpmyadmin|\.well-known\/security\.txt\/|administrator\/index\.php|solr\/|struts)/i,
    enabled: true
  },
  {
    id: 'probe.extension',
    title: 'Nem létező futtatható kiterjesztés kérése',
    severity: 'low',
    score: 15,
    where: ['path'],
    // Ez a platform nem szolgál ki PHP-t, ASP-t vagy JSP-t. Aki ilyet kér,
    // egy másik rendszert keres.
    test: /\.(php|asp|aspx|jsp|cgi|cfm)($|\?)/i,
    enabled: true
  },

  // ---- fejlécek ----
  {
    id: 'header.injection',
    title: 'Sortörés egy fejlécben (válaszhamisítás)',
    severity: 'high',
    score: 45,
    where: ['header'],
    test: /[\r\n]/,
    enabled: true
  }
]

/** A be nem kapcsolt szabályokat a panel írja felül — lásd `edge/config.ts`. */
export interface WafOptions {
  /** Szabályazonosítók, amiket a beállítás kikapcsolt. */
  disabled?: Set<string>
}

/**
 * Egy érték átvizsgálása.
 *
 * A kéréstörzset szövegként nézzük, korlátozott hosszban: egy 1 MB-os törzs
 * teljes végigpásztázása minden szabállyal a forró úton nem fér bele. A
 * támadások eleje amúgy is az elején van — egy injekció, ami a 32. kilobájton
 * kezdődik, nem a bemenetet célozza, hanem a feldolgozót.
 */
const MAX_SCAN = 32 * 1024

function scan (
  value: string,
  at: Hit['at'],
  url: string,
  options: WafOptions
): Hit[] {
  if (!value) return []
  const text = value.length > MAX_SCAN ? value.slice(0, MAX_SCAN) : value
  const hits: Hit[] = []
  for (const rule of RULES) {
    if (!rule.enabled) continue
    if (options.disabled?.has(rule.id)) continue
    if (!rule.where.includes(at)) continue
    if (rule.except?.some(prefix => url.startsWith(prefix))) continue
    if (rule.test.test(text)) {
      hits.push({ rule: rule.id, title: rule.title, severity: rule.severity, score: rule.score, at })
    }
  }
  return hits
}

export interface Inspectable {
  url: string
  /** A nyers lekérdezési sztring, `?` nélkül. */
  query: string
  /** A kéréstörzs, ha szöveggé alakítható. */
  body?: unknown
  headers: Record<string, unknown>
}

/**
 * A teljes kérés átvizsgálása.
 *
 * Visszaad minden találatot, nem csak az elsőt: két közepes találat együtt
 * mást jelent, mint egy, és a pontozás ezt tudni akarja.
 */
export function inspect (request: Inspectable, options: WafOptions = {}): Hit[] {
  const path = request.url.split('?')[0] ?? ''
  const hits: Hit[] = [
    ...scan(decodeSafely(path), 'path', path, options),
    ...scan(decodeSafely(request.query), 'query', path, options)
  ]

  if (request.body !== undefined && request.body !== null) {
    const text = typeof request.body === 'string'
      ? request.body
      : safeStringify(request.body)
    hits.push(...scan(text, 'body', path, options))
  }

  // A fejlécek közül csak azokat, amiket a kliens szabadon választ, és amik
  // továbbadódhatnak. Az `authorization` és a `cookie` SOHA nem kerül
  // vizsgálatra: hitelesítő adat, aminek a naplóba se szabad kerülnie.
  for (const name of ['referer', 'x-forwarded-for', 'x-real-ip', 'origin']) {
    const value = request.headers[name]
    if (typeof value === 'string') hits.push(...scan(value, 'header', path, options))
  }

  return hits
}

/**
 * Egyszer dekódolva nézzük.
 *
 * A `%2e%2e%2f` ugyanaz, mint a `../`, és a szabályok nagy része a dekódolt
 * alakra van írva. Kétszer nem dekódolunk: egy dupla dekódolás olyan
 * támadást is „megtalálna", amit a kiszolgáló sosem fog úgy értelmezni, és a
 * hamis találat itt drágább, mint a kihagyott.
 */
function decodeSafely (value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // Hibás százalékkódolás. Ez önmagában is jelzés, de nem itt kezeljük.
    return value
  }
}

function safeStringify (value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** A találatok együttes pontszáma. */
export function totalScore (hits: Hit[]): number {
  return hits.reduce((sum, hit) => sum + hit.score, 0)
}

/** A legsúlyosabb találat — ez kerül a naplóba és az indoklásba. */
export function worst (hits: Hit[]): Hit | undefined {
  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 }
  return [...hits].sort((a, b) => order[a.severity] - order[b.severity] || b.score - a.score)[0]
}
