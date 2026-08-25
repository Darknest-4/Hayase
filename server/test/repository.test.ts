// Importing extensions from somebody else's repository.
//
// The whole feature rests on one rule: the index never gets to say what its
// packages hash to. Everything else here is the consequence of treating an
// index written by a stranger as hostile input — the shapes it may take, the
// entries it may lie about, and the hosts it may claim to need.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { hostsFrom, manifestFor, parseIndex, slugify } from '../src/lib/repository.ts'
import { validateManifest } from '../src/lib/extension-manifest.ts'

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'example.extension.thing',
  name: 'Thing',
  version: '1.0.2',
  type: 'torrent',
  code: 'https://example.com/thing.js',
  ...over
})

describe('reading an index', () => {
  it('accepts a bare array', () => {
    const { entries, problems } = parseIndex([entry()])
    assert.equal(entries.length, 1)
    assert.deepEqual(problems, [])
  })

  it('accepts an object wrapping an extensions array', () => {
    assert.equal(parseIndex({ extensions: [entry()] }).entries.length, 1)
  })

  it('rejects anything that is not a list of packages', () => {
    for (const body of [null, 'text', 42, { nope: true }]) {
      const { entries, problems } = parseIndex(body)
      assert.equal(entries.length, 0)
      assert.equal(problems.length, 1)
    }
  })

  it('reports what it skipped rather than dropping it silently', () => {
    // An operator importing ten and getting seven wants to know which three.
    const { entries, problems } = parseIndex([
      entry(),
      entry({ id: undefined, name: 'No id' }),
      entry({ version: 'latest', name: 'Bad version' }),
      entry({ type: 'malware', name: 'Bad type' }),
      entry({ code: 'http://insecure.example.com/x.js', name: 'Insecure' })
    ])
    assert.equal(entries.length, 1)
    assert.deepEqual(problems.map(p => p.entry).sort(), ['Bad type', 'Bad version', 'Insecure', 'No id'])
  })

  it('refuses a code URL that is not https', () => {
    // The bytes become executable code in a viewer's browser; fetching them
    // over a channel anybody can rewrite is not a risk worth taking.
    assert.equal(parseIndex([entry({ code: 'http://example.com/x.js' })]).entries.length, 0)
    assert.equal(parseIndex([entry({ code: 'file:///etc/passwd' })]).entries.length, 0)
  })

  it('bounds the strings it copies out of the index', () => {
    const { entries } = parseIndex([entry({ name: 'x'.repeat(500), summary: 'y'.repeat(500) })])
    assert.ok(entries[0]!.name.length <= 120)
    assert.ok((entries[0]!.summary ?? '').length <= 200)
  })

  it('ignores an accuracy or media the store does not have', () => {
    const { entries } = parseIndex([entry({ accuracy: 'perfect', media: 'holographic' })])
    assert.equal(entries[0]!.accuracy, undefined)
    assert.equal(entries[0]!.media, undefined)
  })
})

describe('slugs', () => {
  it('flattens a namespaced id into something the store can hold', () => {
    // Repository ids look like `hayase.extension.nyaa`; the slug column takes
    // lowercase letters, digits and hyphens.
    assert.equal(slugify('hayase.extension.thing'), 'hayase-extension-thing')
    assert.equal(slugify('Some_Thing!!'), 'some-thing')
  })

  it('produces a slug the schema accepts', () => {
    for (const id of ['a.b.c', 'UPPER', 'with spaces', 'trailing---']) {
      assert.match(slugify(id), /^[a-z0-9-]{1,64}$/)
    }
  })
})

describe('deciding what a package may reach', () => {
  it('reads the hosts out of the code, not out of the index', () => {
    // The index is the thing being checked; its claim about what a package
    // needs is not evidence.
    const hosts = hostsFrom(`
      const base = 'https://api.example.org/search'
      fetch('https://cdn.example.net/thing.json')
    `)
    assert.deepEqual(hosts, ['api.example.org', 'cdn.example.net'])
  })

  it('deduplicates and bounds the list', () => {
    const source = Array.from({ length: 40 }, (_, i) => `https://h${i}.example.org/`).join(' ') +
      ' https://h1.example.org/again'
    const hosts = hostsFrom(source)
    assert.ok(hosts.length <= 20)
    assert.equal(new Set(hosts).size, hosts.length)
  })

  it('skips placeholder hosts', () => {
    assert.deepEqual(hostsFrom("fetch('https://your-server.example.com/x')"), [])
  })

  it('finds nothing in code that reaches nothing', () => {
    assert.deepEqual(hostsFrom('export default { async test () { return true } }'), [])
  })
})

describe('the manifest it builds', () => {
  const source = "const base = 'https://api.example.org/'"

  it('passes the same validator the publish endpoint uses', () => {
    const manifest = manifestFor(parseIndex([entry()]).entries[0]!, source, 'https://repo.example.com/index.json')
    const result = validateManifest(manifest)
    assert.equal(result.valid, true, result.errors.join('; '))
  })

  it('declares the hosts the code actually names', () => {
    const manifest = manifestFor(parseIndex([entry()]).entries[0]!, source, 'https://repo.example.com/index.json')
    const result = validateManifest(manifest)
    assert.deepEqual(result.permissions.find(p => p.permission === 'net:fetch')?.hosts, ['api.example.org'])
  })

  it('asks for no network permission at all when the code reaches nothing', () => {
    const manifest = manifestFor(parseIndex([entry()]).entries[0]!, 'export default {}', 'https://repo.example.com/i.json')
    const result = validateManifest(manifest)
    assert.equal(result.permissions.some(p => p.permission === 'net:fetch'), false)
  })

  it('runs the package in compatibility mode, declared rather than implied', () => {
    // These packages call the bare global `fetch`, which the sandbox removed.
    // The alias is visible in the manifest so a reviewer can see it.
    const manifest = manifestFor(parseIndex([entry()]).entries[0]!, source, 'https://repo.example.com/i.json')
    assert.equal(manifest.compat, 'hayase')
  })

  it('says in the listing where the package came from', () => {
    const manifest = manifestFor(parseIndex([entry()]).entries[0]!, source, 'https://repo.example.com/index.json')
    assert.match(String(manifest.description), /repo\.example\.com/)
    assert.match(String(manifest.description), /third-party/)
  })

  it('repeats the publisher\'s NSFW marking rather than hiding it', () => {
    const nsfw = manifestFor(parseIndex([entry({ nsfw: true })]).entries[0]!, source, 'https://r.example.com/i.json')
    assert.match(String(nsfw.description), /NSFW/)
  })

  it('defaults an unstated accuracy to the lowest, not the highest', () => {
    // An imported package has made no claim this store can check.
    const manifest = manifestFor(parseIndex([entry()]).entries[0]!, source, 'https://r.example.com/i.json')
    assert.equal(manifest.accuracy, 'low')
  })

  it('carries the id through as a slug the store can hold', () => {
    const manifest = manifestFor(parseIndex([entry()]).entries[0]!, source, 'https://r.example.com/i.json')
    assert.equal(manifest.id, 'example-extension-thing')
  })
})
