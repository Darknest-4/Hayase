// IP-intelligencia — absztrakcióval, mert az adatforrás cserélhető kell legyen.
//
// AMIT EZ A MODUL NEM CSINÁL: nem tesz úgy, mintha külső adat nélkül meg
// tudná mondani, hogy egy cím VPN-é. Nem tudja. Aki ilyet ígér adatforrás
// nélkül, az találgat, és a találgatásból tiltás lesz.
//
// AMIT CSINÁL:
//   * megad egy PROVIDER-FÜGGETLEN alakot (ASN, szolgáltató, ország,
//     hosting/VPN/proxy/Tor jelzők, hírnév, bizonyosság, forrás);
//   * ad egy helyi providert, ami külső szolgáltatás NÉLKÜL is mond annyit,
//     amennyit tényleg tudni lehet — fenntartott tartományok, és a fordított
//     névfeloldásból következő adatközponti jelek;
//   * a forró úton CSAK a gyorsítótárból és a táblából olvas. Külső hívás a
//     kérési útban nincs: egy lassú provider nem lassíthatja a látogatót.
//
// A bizonyosság (`confidence`) nem dísz. Egy 0.3-as „VPN" és egy 0.95-ös nem
// ugyanaz, és a kockázati pontszám ezt súlyozza is — enélkül egy bizonytalan
// besorolás ugyanúgy tiltana, mint egy biztos.

import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'

import { query, queryOne } from '../../infrastructure/database/index.ts'

export type NetworkType = 'residential' | 'hosting' | 'mobile' | 'business' | 'education' | 'unknown'

export interface IpIntel {
  ip: string
  asn: number | null
  provider: string | null
  country: string | null
  networkType: NetworkType
  isHosting: boolean
  isVpn: boolean
  isProxy: boolean
  isTor: boolean
  /** 0 = ismeretlen/semleges, 100 = biztosan rosszindulatú. */
  reputation: number
  /** 0–1: mennyire hisszük el, amit fent állítunk. */
  confidence: number
  source: string
  checkedAt: Date
}

/**
 * Egy adatforrás.
 *
 * Új provider hozzáadása ennyi: implementáld ezt, és vedd fel a `PROVIDERS`
 * listára. A hívó kód semmit nem tud a forrásról.
 */
export interface IpProvider {
  name: string
  /**
   * Amit erről a címről meg tud mondani. `null`, ha nem tud semmit — az
   * nem hiba, és nem is jelent „tiszta" címet.
   */
  lookup: (ip: string) => Promise<Partial<IpIntel> | null>
}

// ---------------------------------------------------------------- helyi

/**
 * Fenntartott és magánhálózati tartományok.
 *
 * Ezek nem az internetről jönnek: ha egy kérés ilyen címről érkezik, az vagy
 * a saját infrastruktúránk (a fordított proxy, a health probe, a worker),
 * vagy egy rosszul beállított `X-Forwarded-For`. Mindkettő fontos tudni, és
 * egyik sem gyanús önmagában.
 */
const RESERVED: Array<[RegExp, string]> = [
  [/^127\./, 'loopback'],
  [/^::1$/, 'loopback'],
  [/^10\./, 'private'],
  [/^192\.168\./, 'private'],
  [/^172\.(1[6-9]|2\d|3[01])\./, 'private'],
  [/^169\.254\./, 'link-local'],
  [/^(fc|fd)/i, 'private'],
  [/^fe80:/i, 'link-local']
]

/**
 * Adatközponti nyomok a fordított névben.
 *
 * Ez heurisztika, és annak is nevezzük: a `confidence` ezért 0.5, nem 0.9. Egy
 * `ec2-…compute.amazonaws.com` PTR erős jel, egy `static.example.net` nem az.
 * A lista bővíthető, de a bővítése soha nem lesz teljes — ezért van a
 * provider-absztrakció.
 */
const HOSTING_HINTS = /(^|\.)(amazonaws|googleusercontent|azure|cloudapp|digitalocean|linode|vultr|hetzner|ovh|contabo|scaleway|oracle(cloud)?|leaseweb|choopa|colocrossing|datapacket|ip-\d+-\d+-\d+-\d+)\b/i
const VPN_HINTS = /(^|[.-])(vpn|proxy|tor-exit|torexit|exit-node|nordvpn|expressvpn|mullvad|protonvpn|surfshark)\b/i

/**
 * A helyi provider: külső szolgáltatás nélkül.
 *
 * A fordított névfeloldás hálózati hívás, tehát SOHA nem a kérési útban fut —
 * a frissítő feladat hívja, a worker folyamatban. A forró út a táblát olvassa.
 */
export const localProvider: IpProvider = {
  name: 'local',
  async lookup (ip: string): Promise<Partial<IpIntel> | null> {
    const reserved = RESERVED.find(([pattern]) => pattern.test(ip))
    if (reserved) {
      return {
        networkType: 'unknown',
        provider: reserved[1],
        // Fenntartott cím: nem az internetről jön, tehát se hosting, se VPN.
        // A bizonyosság itt 1: ez nem becslés, hanem a címtartomány definíciója.
        isHosting: false,
        isVpn: false,
        reputation: 0,
        confidence: 1,
        source: 'local:reserved'
      }
    }

    let hostname: string | null = null
    try {
      const names = await dns.reverse(ip)
      hostname = names[0] ?? null
    } catch {
      // Nincs PTR. Ez önmagában semmit nem jelent — sok lakossági cím sem
      // oldható vissza —, tehát nem adunk érte pontot.
      hostname = null
    }

    if (!hostname) return { source: 'local:no-ptr', confidence: 0 }

    const hosting = HOSTING_HINTS.test(hostname)
    const vpn = VPN_HINTS.test(hostname)

    return {
      provider: hostname.split('.').slice(-2).join('.'),
      networkType: hosting ? 'hosting' : 'unknown',
      isHosting: hosting,
      isVpn: vpn,
      isTor: /tor-?exit/i.test(hostname),
      reputation: 0,
      // Heurisztika, és annak is nevezzük.
      confidence: hosting || vpn ? 0.5 : 0.2,
      source: 'local:ptr'
    }
  }
}

/**
 * A beállított providerek, sorrendben.
 *
 * A későbbieket az korábbiak fölé olvassuk: egy valódi adatszolgáltató
 * felülírja a helyi heurisztikát. Ma csak a helyi van — és ezt a
 * dokumentáció is kimondja, ahelyett hogy úgy tenne, mintha lenne VPN-adatunk.
 */
export const PROVIDERS: IpProvider[] = [localProvider]

// ------------------------------------------------------------ gyorsítótár

/**
 * Folyamaton belüli gyorsítótár.
 *
 * A forró út ezt olvassa. Egy támadás alatt ugyanaz a néhány cím jön
 * ezerszer — adatbázis-lekérdezés nélkül kell tudni róluk.
 *
 * Nem Redis: egy app-példány fut, és a `docs/redis.md` leírja, mikor nem lesz
 * ez így. Több példánynál ez a map lesz az első, amit ki kell cserélni — a
 * hívói felület (`intelOf`) viszont nem változik.
 */
const cache = new Map<string, { value: IpIntel | null, at: number }>()
const CACHE_MS = Number(process.env.EDGE_IP_CACHE_MS ?? 5 * 60_000)
const CACHE_MAX = 10_000

function remember (ip: string, value: IpIntel | null): void {
  if (cache.size >= CACHE_MAX) {
    // A legrégebbi ötöd eldobása. Nem LRU: egy pontos LRU karbantartása
    // kérésenként több, mint amennyit egy ilyen méretnél megspórol.
    const cutoff = Date.now() - CACHE_MS / 2
    for (const [key, entry] of cache) if (entry.at < cutoff) cache.delete(key)
    if (cache.size >= CACHE_MAX) cache.clear()
  }
  cache.set(ip, { value, at: Date.now() })
}

/** Teszthez és a beállítás módosításához. */
export function forgetCache (): void { cache.clear() }

interface Row {
  ip: string
  asn: number | null
  provider: string | null
  country: string | null
  network_type: NetworkType
  is_hosting: boolean
  is_vpn: boolean
  is_proxy: boolean
  is_tor: boolean
  reputation: number
  confidence: string
  source: string
  checked_at: Date
}

const fromRow = (row: Row): IpIntel => ({
  ip: row.ip,
  asn: row.asn,
  provider: row.provider,
  country: row.country,
  networkType: row.network_type,
  isHosting: row.is_hosting,
  isVpn: row.is_vpn,
  isProxy: row.is_proxy,
  isTor: row.is_tor,
  reputation: Number(row.reputation),
  confidence: Number(row.confidence),
  source: row.source,
  checkedAt: row.checked_at
})

/**
 * Amit erről a címről tudunk — a FORRÓ ÚTON.
 *
 * Gyorsítótár, aztán tábla. Külső hívás nincs, és ha a cím ismeretlen,
 * `null`-t ad: az „nem tudjuk", nem „tiszta". A kockázatszámítás a `null`-ra
 * nem ad pontot, se pozitívat, se negatívat.
 *
 * Az ismeretlen címeket felveszi a frissítendők közé, de nem várja meg.
 */
export async function intelOf (ip: string): Promise<IpIntel | null> {
  if (!ip || isIP(ip) === 0) return null

  const hit = cache.get(ip)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value

  try {
    const row = await queryOne<Row>('SELECT * FROM ip_intel WHERE ip = $1', [ip])
    const value = row ? fromRow(row) : null
    remember(ip, value)
    if (!row) void enqueueLookup(ip)
    return value
  } catch {
    // Az adatbázis hibája nem állíthatja meg a kérést. „Nem tudjuk" a helyes
    // válasz, és a policy ezzel tud mit kezdeni.
    return null
  }
}

/**
 * Egy cím felvétele a frissítendők közé.
 *
 * Nem a providert hívja: sort ír. A tényleges lekérdezés a workerben történik,
 * ahol egy lassú DNS vagy egy külső API senkinek nem tartja fel a kérését.
 */
async function enqueueLookup (ip: string): Promise<void> {
  try {
    await query(
      `INSERT INTO ip_intel (ip, source, confidence, checked_at)
       VALUES ($1, 'pending', 0, now() - interval '1 year')
       ON CONFLICT (ip) DO NOTHING`,
      [ip]
    )
  } catch { /* legjobb szándék szerint */ }
}

/**
 * Egy cím kivizsgálása és eltárolása — a WORKERBŐL hívva.
 *
 * Minden providert megkérdez, sorrendben, és a későbbi eredményt a korábbira
 * olvassa. Egy elhasaló provider nem viszi magával a többit.
 */
export async function refresh (ip: string): Promise<IpIntel | null> {
  if (!ip || isIP(ip) === 0) return null

  let merged: Partial<IpIntel> = {}
  const sources: string[] = []

  for (const provider of PROVIDERS) {
    try {
      const result = await provider.lookup(ip)
      if (!result) continue
      merged = { ...merged, ...result }
      sources.push(result.source ?? provider.name)
    } catch {
      // Egy provider kiesése nem hiba, csak kevesebb adat.
    }
  }

  const value: IpIntel = {
    ip,
    asn: merged.asn ?? null,
    provider: merged.provider ?? null,
    country: merged.country ?? null,
    networkType: merged.networkType ?? 'unknown',
    isHosting: merged.isHosting ?? false,
    isVpn: merged.isVpn ?? false,
    isProxy: merged.isProxy ?? false,
    isTor: merged.isTor ?? false,
    reputation: Math.max(0, Math.min(100, Math.round(merged.reputation ?? 0))),
    confidence: Math.max(0, Math.min(1, merged.confidence ?? 0)),
    source: sources.join('+') || 'none',
    checkedAt: new Date()
  }

  await query(
    `INSERT INTO ip_intel
       (ip, asn, provider, country, network_type, is_hosting, is_vpn, is_proxy, is_tor,
        reputation, confidence, source, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     ON CONFLICT (ip) DO UPDATE SET
       asn = EXCLUDED.asn, provider = EXCLUDED.provider, country = EXCLUDED.country,
       network_type = EXCLUDED.network_type, is_hosting = EXCLUDED.is_hosting,
       is_vpn = EXCLUDED.is_vpn, is_proxy = EXCLUDED.is_proxy, is_tor = EXCLUDED.is_tor,
       reputation = EXCLUDED.reputation, confidence = EXCLUDED.confidence,
       source = EXCLUDED.source, checked_at = now()`,
    [ip, value.asn, value.provider, value.country, value.networkType, value.isHosting,
      value.isVpn, value.isProxy, value.isTor, value.reputation, value.confidence, value.source]
  )

  remember(ip, value)
  return value
}

/** A frissítendő címek: amiket még sosem néztünk meg, vagy régen. */
export async function stale (limit = 50, olderThanHours = 24 * 7): Promise<string[]> {
  const rows = await query<{ ip: string }>(
    `SELECT ip::text FROM ip_intel
      WHERE checked_at < now() - ($1 || ' hours')::interval
      ORDER BY checked_at ASC LIMIT $2`,
    [olderThanHours, limit]
  )
  return rows.map(r => r.ip)
}
