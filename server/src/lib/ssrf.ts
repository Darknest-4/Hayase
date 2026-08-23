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
  const [a = 0, b = 0] = ip.split('.').map(Number)
  return (
    a === 0 ||                          // 0.0.0.0/8 "this host"
    a === 10 ||                         // private
    a === 127 ||                        // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||         // link-local — cloud metadata lives here
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) ||         // private
    (a === 192 && b === 0) ||           // IETF protocol assignments
    (a === 198 && b >= 18 && b <= 19) || // benchmarking
    a >= 224                            // multicast and reserved
  )
}

function isPrivateV6 (ip: string): boolean {
  const address = ip.toLowerCase().split('%')[0] ?? ''
  if (address === '::1' || address === '::') return true
  if (address.startsWith('fe80')) return true            // link-local
  if (/^f[cd]/.test(address)) return true                // unique local
  if (address.startsWith('ff')) return true              // multicast
  // IPv4-mapped (::ffff:127.0.0.1) must be judged as the IPv4 address it wraps
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)
  if (mapped?.[1]) return isPrivateV4(mapped[1])
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
const ALLOWED = (process.env.WEBHOOK_ALLOWED_HOSTS ?? '')
  .split(',').map(h => h.trim().toLowerCase()).filter(Boolean)

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
  if (ALLOWED.includes(host)) return { ok: true }

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
