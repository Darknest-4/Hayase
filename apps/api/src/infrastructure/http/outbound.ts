// Outbound HTTP to an address somebody else chose.
//
// `checkOutboundUrl` (ssrf.ts) answers "does this URL point inward right now".
// That is not enough on its own, for two reasons that both reached the
// loopback in practice:
//
//   * Redirects. `fetch` follows them, and nothing checked where they led: a
//     public endpoint answering `302 Location: http://127.0.0.1:4000/…` sent
//     the request exactly where the check was there to stop it.
//   * Rebinding. The name was resolved once for the check and again for the
//     connection. A DNS answer with a short TTL can differ between the two.
//
// So the request is made here, with `node:http`: it never follows a redirect
// (a 3xx is returned as-is, and callers treat it as a failure), and the
// address is checked in the socket's own DNS lookup — the one the connection
// actually uses — so there is no second answer to swap in.

import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions, type LookupOneOptions } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'

import { allowedHost, isPrivateAddress } from './ssrf.ts'

export interface GuardedResponse {
  status: number
  ok: boolean
  headers: { get: (name: string) => string | null }
  body: Buffer
}

export interface GuardedInit {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string | undefined
  /** Whole request, connection to last byte. */
  timeoutMs?: number
  /** Response bytes kept; the rest is refused rather than buffered. */
  maxBytes?: number
  signal?: AbortSignal | undefined
}

export class RefusedAddress extends Error {}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

/** A `lookup` for net.connect that refuses private and reserved answers. */
function guardedLookup (hostname: string, options: LookupOneOptions | LookupAllOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, [])
    const list = addresses as LookupAddress[]
    const inward = list.find(entry => isPrivateAddress(entry.address))
    if (!list.length || inward) {
      return callback(new RefusedAddress(
        `${hostname} resolves to ${inward?.address ?? 'nothing'}, a private or reserved address`), [])
    }
    if ((options as LookupAllOptions).all) return callback(null, list)
    const first = list[0]!
    callback(null, first.address, first.family)
  })
}

export async function guardedRequest (raw: string, init: GuardedInit = {}): Promise<GuardedResponse> {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RefusedAddress(`scheme ${url.protocol} is not allowed`)
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const trusted = allowedHost(host)
  // An address literal never goes through `lookup`, so it is checked here.
  if (!trusted && isIP(host) && isPrivateAddress(host)) {
    throw new RefusedAddress(`${host} is a private or reserved address`)
  }

  const client = url.protocol === 'https:' ? https : http
  const maxBytes = init.maxBytes ?? 1_048_576
  const body = init.body === undefined ? undefined : Buffer.from(init.body)

  return await new Promise<GuardedResponse>((resolve, reject) => {
    const request = client.request(url, {
      method: init.method ?? (body ? 'POST' : 'GET'),
      headers: {
        ...init.headers,
        ...(body ? { 'content-length': String(body.length) } : {})
      },
      // An allowed host is the operator saying "this internal service is
      // meant"; everything else is resolved through the guard.
      ...(trusted ? {} : { lookup: guardedLookup as never }),
      agent: false
    }, response => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
          request.destroy(new Error(`response is larger than ${maxBytes} bytes`))
          return
        }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        const status = response.statusCode ?? 0
        resolve({
          status,
          ok: status >= 200 && status < 300,
          headers: {
            get: (name: string) => {
              const value = response.headers[name.toLowerCase()]
              if (value === undefined) return null
              return Array.isArray(value) ? value.join(', ') : String(value)
            }
          },
          body: Buffer.concat(chunks)
        })
      })
    })

    const timeout = setTimeout(() => {
      request.destroy(new Error(`no complete response within ${init.timeoutMs ?? 10_000} ms`))
    }, init.timeoutMs ?? 10_000)
    request.on('close', () => clearTimeout(timeout))
    request.on('error', reject)
    if (init.signal) {
      if (init.signal.aborted) request.destroy(new Error('aborted'))
      else init.signal.addEventListener('abort', () => request.destroy(new Error('aborted')), { once: true })
    }
    if (body) request.write(body)
    request.end()
  })
}
