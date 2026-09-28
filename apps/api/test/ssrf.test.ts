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

const { isPrivateAddress, checkOutboundUrl } = await import('../src/infrastructure/http/ssrf.ts')

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

describe('address spellings the URL parser produces', () => {
  // `new URL('http://[::ffff:127.0.0.1]/')` becomes `[::ffff:7f00:1]`, a
  // spelling the old pattern did not recognise — the loopback was reachable.
  const INWARD = [
    'http://[::ffff:127.0.0.1]:4000/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[64:ff9b::a9fe:a9fe]/',       // NAT64
    'http://[2002:7f00:1::1]/',           // 6to4 wrapping 127.0.0.1
    'http://[::7f00:1]/',                 // IPv4-compatible
    'http://[2001:db8::1]/'               // documentation range
  ]
  for (const url of INWARD) {
    it(`refuses ${url}`, async () => {
      const verdict = await checkOutboundUrl(url)
      assert.equal(verdict.ok, false, `${url} must be refused`)
    })
  }

  it('still allows a routable IPv6 address', async () => {
    assert.equal((await checkOutboundUrl('http://[2606:4700::1111]/')).ok, true)
  })
})

describe('the guarded client', () => {
  it('does not follow a redirect — even one to an allowed host', async () => {
    const { createServer } = await import('node:http')
    const { guardedRequest } = await import('../src/infrastructure/http/outbound.ts')
    let reached = 0
    const target = createServer((_req, res) => { reached++; res.end('secret') })
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve))
    const targetPort = (target.address() as { port: number }).port
    const redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/admin` })
      res.end()
    })
    await new Promise<void>(resolve => redirector.listen(0, '127.0.0.1', resolve))
    const port = (redirector.address() as { port: number }).port

    const previous = process.env.WEBHOOK_ALLOWED_HOSTS
    process.env.WEBHOOK_ALLOWED_HOSTS = '127.0.0.1'
    try {
      const res = await guardedRequest(`http://127.0.0.1:${port}/hook`, { method: 'POST', body: '{}' })
      assert.equal(res.status, 302)
      assert.equal(res.ok, false, 'a redirect is not a delivery')
      assert.equal(reached, 0, 'the redirect target must never be contacted')
    } finally {
      if (previous === undefined) delete process.env.WEBHOOK_ALLOWED_HOSTS
      else process.env.WEBHOOK_ALLOWED_HOSTS = previous
      redirector.close()
      target.close()
    }
  })

  it('refuses an address literal that points inward', async () => {
    const { guardedRequest, RefusedAddress } = await import('../src/infrastructure/http/outbound.ts')
    await assert.rejects(() => guardedRequest('http://[::ffff:127.0.0.1]:9/'), RefusedAddress)
    await assert.rejects(() => guardedRequest('http://169.254.169.254/latest/meta-data/'), RefusedAddress)
  })

  it('refuses a name that resolves inward, at connect time', async () => {
    const { guardedRequest } = await import('../src/infrastructure/http/outbound.ts')
    // `localhost` resolves to the loopback: the socket's own lookup refuses it.
    await assert.rejects(() => guardedRequest('http://localhost:9/', { timeoutMs: 2_000 }),
      /private or reserved/)
  })
})
