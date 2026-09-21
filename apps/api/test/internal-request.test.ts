// „Belülről jött-e?" — a sebességkorlát alóli mentesség egyetlen kapuja.
//
// Ez biztonsági döntés, tehát a tesztek zöme nem azt bizonyítja, hogy a
// saját forgalmunk átmegy, hanem azt, hogy IDEGEN NEM TUD ÁTJUTNI RAJTA.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isInternalRequest, isLoopback, isPrivateAddress } from '../src/middleware/internal-request.ts'

const req = (address: string | undefined, headers: Record<string, string> = {}) =>
  ({ socket: { remoteAddress: address }, headers } as never)

describe('címfelismerés', () => {
  it('hurokcím minden alakban', () => {
    assert.equal(isLoopback('127.0.0.1'), true)
    assert.equal(isLoopback('127.0.0.53'), true)
    assert.equal(isLoopback('::1'), true)
    // A Node IPv4-et gyakran IPv6-ba ágyazva ad vissza.
    assert.equal(isLoopback('::ffff:127.0.0.1'), true)
    assert.equal(isLoopback('8.8.8.8'), false)
    assert.equal(isLoopback(undefined), false)
  })

  it('magánhálózati tartományok', () => {
    assert.equal(isPrivateAddress('10.0.0.5'), true)
    assert.equal(isPrivateAddress('172.18.0.4'), true)   // a Docker hídja
    assert.equal(isPrivateAddress('192.168.1.10'), true)
    assert.equal(isPrivateAddress('fd00::1'), true)
  })

  it('a szomszédos, de NEM magánhálózati tartományok kimaradnak', () => {
    // A 172.16.0.0/12 a 172.16–172.31 tartomány. A 172.15 és a 172.32 KÍVÜL
    // van rajta, és egy elrontott összehasonlítás pont ezeket engedné be.
    assert.equal(isPrivateAddress('172.15.0.1'), false)
    assert.equal(isPrivateAddress('172.32.0.1'), false)
    assert.equal(isPrivateAddress('11.0.0.1'), false)
    assert.equal(isPrivateAddress('192.169.1.1'), false)
    assert.equal(isPrivateAddress('9.255.255.255'), false)
  })

  it('a hibás bemenetből nem lesz mentesség', () => {
    assert.equal(isPrivateAddress(''), false)
    assert.equal(isPrivateAddress(undefined), false)
    assert.equal(isPrivateAddress('nem-cím'), false)
    assert.equal(isPrivateAddress('10.0.0'), false)
    assert.equal(isPrivateAddress('999.0.0.1'), false)
  })
})

describe('belső kérés', () => {
  it('a worker és a bot átmegy — ők a saját hálózatunkon vannak', () => {
    assert.equal(isInternalRequest(req('172.18.0.9')), true)
    assert.equal(isInternalRequest(req('127.0.0.1')), true)
  })

  it('a proxyn átjött kérés SOHA nem belső', () => {
    // A Caddy magáncímen ül, tehát az első feltétel teljesülne. A rajta
    // átjött kérésen viszont mindig van továbbítófejléc — és az kizárja.
    assert.equal(isInternalRequest(req('172.18.0.2', { 'x-forwarded-for': '8.8.8.8' })), false)
    assert.equal(isInternalRequest(req('172.18.0.2', { 'x-real-ip': '8.8.8.8' })), false)
    assert.equal(isInternalRequest(req('172.18.0.2', { forwarded: 'for=8.8.8.8' })), false)
    assert.equal(isInternalRequest(req('172.18.0.2', { 'cf-connecting-ip': '8.8.8.8' })), false)
  })

  it('a hurokcímre HAZUDOTT fejléc nem ad mentességet', () => {
    // A támadó szándéka pont ez lenne: „én a szerver vagyok". A fejléc
    // viszont nem számít — a kapcsolat túlsó vége dönt, és az az ő címe.
    assert.equal(isInternalRequest(req('8.8.8.8', { 'x-forwarded-for': '127.0.0.1' })), false)
    assert.equal(isInternalRequest(req('203.0.113.7', { 'x-real-ip': '10.0.0.1' })), false)
  })

  it('külső cím fejléc nélkül sem belső', () => {
    assert.equal(isInternalRequest(req('8.8.8.8')), false)
    assert.equal(isInternalRequest(req(undefined)), false)
  })

  it('az üres fejlécérték is proxyra vall', () => {
    // Egy jelen lévő, de üres `X-Forwarded-For` attól még azt jelenti, hogy
    // valami proxy hozzányúlt a kéréshez.
    assert.equal(isInternalRequest(req('172.18.0.2', { 'x-forwarded-for': '' })), false)
  })
})
