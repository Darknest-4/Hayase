// Outbound request guard.
//
// Webhook URLs are supplied by an administrator and fetched by the server, so
// without a check the feature is a server-side request forgery primitive: the
// URL only had to match `^https?://`, which admits
//
//   http://169.254.169.254/latest/meta-data/   cloud instance credentials
//   http://127.0.0.1:4100/v1/admin/…           the API's own loopback
//   http://postgres:5432/                      anything on the compose network
//
// and webhook_deliveries records the status code or connection error, turning
// it into a readable port scanner. Verified before this existed: the server
// connected to its own loopback and attempted the metadata address.
//
// The permission needed to configure a webhook is not the same as permission
// to reach the internal network, so the two are separated here.

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** Reserved IPv4 ranges that must never be reachable from a user-supplied URL. */
function isPrivateV4 (ip: string): boolean {
  const [a = 0, b = 0, c = 0] = ip.split('.').map(Number)
  return (
    a === 0 ||                          // 0.0.0.0/8 "this host"
    a === 10 ||                         // private
    a === 127 ||                        // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||         // link-local — cloud metadata lives here
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) ||         // private
    (a === 192 && b === 0) ||           // IETF protocol assignments, TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 198 && b >= 18 && b <= 19) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224                            // multicast and reserved
  )
}

/**
 * An IPv6 address as eight 16-bit groups, or null when it is not one.
 *
 * Parsed rather than pattern-matched, because the same address has many
 * spellings. The URL parser, for one, rewrites `[::ffff:127.0.0.1]` to
 * `[::ffff:7f00:1]` — a spelling the old `^::ffff:(\d+\.…)$` test did not
 * recognise, so `http://[::ffff:127.0.0.1]/` reached the loopback.
 */
function groupsOf (ip: string): number[] | null {
  let text = (ip.toLowerCase().split('%')[0] ?? '')
  // A trailing dotted quad is two groups written in decimal: rewrite it so
  // every spelling goes through the same parse.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (dotted) {
    const octets = dotted.slice(1, 5).map(Number)
    if (octets.some(n => n > 255)) return null
    const [a = 0, b = 0, c = 0, d = 0] = octets
    text = text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): number[] | null => {
    if (part === '') return []
    const groups = part.split(':')
    if (groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null
    return groups.map(group => parseInt(group, 16))
  }
  const head = parse(halves[0] ?? '')
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : []
  if (!head || !rest) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  if (head.length + rest.length > 7) return null
  return [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest]
}

/** The IPv4 address carried in two 16-bit groups. */
const v4Of = (high: number, low: number): string =>
  `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`

function isPrivateV6 (ip: string): boolean {
  const g = groupsOf(ip)
  if (!g) return true // not something we can reason about — refuse
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g
  const zeroThrough = (n: number): boolean => g.slice(0, n).every(x => x === 0)

  if (zeroThrough(8)) return true                                   // :: unspecified
  if (zeroThrough(7) && g7 === 1) return true                       // ::1 loopback
  if (zeroThrough(5) && g5 === 0xffff) return isPrivateV4(v4Of(g6, g7)) // ::ffff:a.b.c.d mapped
  if (zeroThrough(4) && g4 === 0xffff && g5 === 0) return isPrivateV4(v4Of(g6, g7)) // ::ffff:0:a.b.c.d
  if (zeroThrough(6)) return true                                   // ::a.b.c.d compatible (deprecated)
  if (g0 === 0x64 && g1 === 0xff9b) return true                     // 64:ff9b::/32 NAT64, incl. local-use
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true // 100::/64 discard
  if (g0 === 0x2002) return isPrivateV4(v4Of(g1, g2))              // 2002::/16 6to4
  if (g0 === 0x2001 && g1 === 0) return true                        // 2001::/32 Teredo
  if (g0 === 0x2001 && g1 === 0x0db8) return true                   // 2001:db8::/32 documentation
  if ((g0 & 0xffc0) === 0xfe80) return true                         // fe80::/10 link-local
  if ((g0 & 0xfe00) === 0xfc00) return true                         // fc00::/7 unique local
  if ((g0 & 0xff00) === 0xff00) return true                         // ff00::/8 multicast
  return false
}

export function isPrivateAddress (ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) return isPrivateV4(ip)
  if (version === 6) return isPrivateV6(ip)
  return true // not an address we can reason about — refuse
}

/**
 * Hosts an operator has deliberately allowed despite pointing inward. Needed
 * for a webhook that targets another service on the same compose network,
 * which is a legitimate thing to want.
 */
export function allowedHost (host: string): boolean {
  return (process.env.WEBHOOK_ALLOWED_HOSTS ?? '')
    .split(',').map(h => h.trim().toLowerCase()).filter(Boolean)
    .includes(host.toLowerCase())
}

export interface UrlVerdict {
  ok: boolean
  reason?: string
}

/**
 * Decide whether an outbound URL may be fetched.
 *
 * DNS is resolved, because a hostname is not a promise: `evil.example` can
 * point at 127.0.0.1, and checking the text alone would miss it. Every
 * resolved address must pass — a host with one public and one private answer
 * is refused rather than raced.
 *
 * Residual risk: an attacker who controls DNS can return a public address for
 * this check and a private one for the fetch that follows (rebinding). Closing
 * that needs the connection pinned to the address that was checked, which
 * fetch() does not expose. The window is small and the permission required is
 * already high, so it is documented rather than left implied.
 */
export async function checkOutboundUrl (raw: string): Promise<UrlVerdict> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'not a valid URL' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `scheme ${url.protocol} is not allowed` }
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (allowedHost(host)) return { ok: true }

  // A literal address needs no lookup.
  if (isIP(host)) {
    return isPrivateAddress(host)
      ? { ok: false, reason: 'points at a private or reserved address' }
      : { ok: true }
  }

  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    return { ok: false, reason: 'hostname does not resolve' }
  }
  if (!addresses.length) return { ok: false, reason: 'hostname does not resolve' }

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      return { ok: false, reason: 'resolves to a private or reserved address' }
    }
  }
  return { ok: true }
}
