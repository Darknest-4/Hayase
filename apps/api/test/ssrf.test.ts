// Outbound-URL guard tests.
//
// The webhook feature fetches an administrator-supplied URL from the server,
// which without a check is a server-side request forgery primitive. Before the
// guard existed this was verified live: the API connected to its own loopback
// (`http://127.0.0.1:4100/v1/health` recorded HTTP 404 in webhook_deliveries)
// and attempted `http://169.254.169.254/latest/meta-data/`, the address that
// hands out instance credentials on every major cloud. Because the delivery
// row records the status or the connection error, the feature also doubled as
// a readable port scanner.
//
// These are pure unit tests — no network, no database, no server.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { isPrivateAddress, checkOutboundUrl } = await import('../src/lib/ssrf.ts')

describe('address classification', () => {
  // Everything here must be judged private. The ones with a comment are the
  // ones that actually cost people money in the wild.
  const PRIVATE = [
    '127.0.0.1', '127.1.2.3',        // loopback
    '169.254.169.254',               // cloud instance metadata
    '169.254.0.1',
    '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.254',
    '192.168.0.1', '192.168.1.1',
    '100.64.0.1',                    // carrier-grade NAT
    '0.0.0.0',
    '192.0.0.1',                     // IETF protocol assignments
    '198.18.0.1',                    // benchmarking
    '224.0.0.1', '239.255.255.250',  // multicast
    '255.255.255.255',
    '::1', '::',
    'fe80::1',                       // link-local
    'fc00::1', 'fd12:3456::1',       // unique local
    'ff02::1',                       // multicast
    '::ffff:127.0.0.1',              // IPv4-mapped loopback — the classic bypass
    '::ffff:169.254.169.254'
  ]

  for (const ip of PRIVATE) {
    it(`refuses ${ip}`, () => {
      assert.equal(isPrivateAddress(ip), true, `${ip} must be treated as private`)
    })
  }

  const PUBLIC = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '172.15.0.1', '2606:4700::1111']
  for (const ip of PUBLIC) {
    it(`allows ${ip}`, () => {
      assert.equal(isPrivateAddress(ip), false, `${ip} is routable and must be allowed`)
    })
  }

  it('refuses anything that is not an address at all', () => {
    // Fail closed: a value we cannot reason about is not evidence of safety.
    for (const junk of ['', 'localhost', 'not-an-ip', '999.999.999.999', '127.0.0.1 ']) {
      assert.equal(isPrivateAddress(junk), true, `${JSON.stringify(junk)} must fail closed`)
    }
  })
})

describe('outbound URL verdicts', () => {
  it('refuses non-http schemes', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/', 'data:text/plain,hi']) {
      const verdict = await checkOutboundUrl(url)
      assert.equal(verdict.ok, false, `${url} must be refused`)
    }
  })

  it('refuses a malformed URL', async () => {
    assert.equal((await checkOutboundUrl('not a url')).ok, false)
    assert.equal((await checkOutboundUrl('')).ok, false)
  })

  it('refuses literal internal addresses', async () => {
    for (const url of [
      'http://127.0.0.1:4100/v1/health',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://[::1]:4100/'
    ]) {
      const verdict = await checkOutboundUrl(url)
      assert.equal(verdict.ok, false, `${url} must be refused`)
      assert.match(String(verdict.reason), /private|reserved/)
    }
  })

  it('refuses a hostname that resolves inward', async () => {
    // "localhost" is a name, not a literal — the text check alone would miss
    // it, which is exactly why the guard resolves DNS.
    const verdict = await checkOutboundUrl('http://localhost:5432/')
    assert.equal(verdict.ok, false)
  })

  it('refuses a hostname that does not resolve', async () => {
    const verdict = await checkOutboundUrl('https://this-host-does-not-exist.invalid/hook')
    assert.equal(verdict.ok, false)
    assert.match(String(verdict.reason), /resolve/)
  })

  it('allows a public literal address', async () => {
    assert.equal((await checkOutboundUrl('https://1.1.1.1/hook')).ok, true)
  })
})
