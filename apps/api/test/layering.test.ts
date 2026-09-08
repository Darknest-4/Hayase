// The rules the structure is supposed to hold, asserted rather than hoped for.
//
// A directory layout decays the moment it is only a convention. These are the
// three rules this restructure was actually for, each of which was broken
// before it and each of which is invisible in review:
//
//   1. Infrastructure does not know what a feature is. The queue used to
//      import the webhooks module to announce a dead job.
//   2. A module talks to the database through one address. `src/db.ts` had 77
//      direct importers and no two of them agreed on where SQL should live.
//   3. Where a module has a repository, its route handlers hold no SQL — or
//      the repository is decoration and the next query goes back in the
//      handler.
//
// Rule 3 is scoped to modules that have opted in. The thin CRUD modules
// deliberately keep their SQL in the handler; a repository for an 80-line
// module is ceremony. What is not allowed is a module with a repository that
// is bypassed.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function walk (dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

const files = walk(SRC).map(path => ({
  path,
  rel: path.slice(SRC.length),
  source: readFileSync(path, 'utf8')
}))

/** Static and dynamic import specifiers, in source order. */
function importsOf (source: string): string[] {
  return [...source.matchAll(/(?:from|import\()\s*'([^']+)'/g)].map(m => m[1] as string)
}

describe('dependency direction', () => {
  test('infrastructure never imports a feature module', () => {
    // The mechanism must be usable without the features built on it. A lazy
    // `await import()` counts: it keeps the module graph acyclic while leaving
    // the dependency pointing the wrong way.
    const offences: string[] = []
    for (const file of files) {
      if (!file.rel.startsWith('infrastructure/')) continue
      for (const spec of importsOf(file.source)) {
        if (spec.includes('/modules/')) offences.push(`${file.rel} -> ${spec}`)
      }
    }
    assert.deepEqual(offences, [], 'infrastructure reached into a feature module')
  })

  test('infrastructure never imports the request pipeline', () => {
    const offences: string[] = []
    for (const file of files) {
      if (!file.rel.startsWith('infrastructure/')) continue
      for (const spec of importsOf(file.source)) {
        if (spec.includes('/middleware/')) offences.push(`${file.rel} -> ${spec}`)
      }
    }
    assert.deepEqual(offences, [], 'infrastructure depends on HTTP middleware')
  })

  test('one module never reaches into another module\'s internals', () => {
    // Crossing to a sibling's routes.ts or repository.ts is how two modules
    // quietly become one. Shared helpers belong in infrastructure or a package.
    const offences: string[] = []
    for (const file of files) {
      const own = file.rel.startsWith('modules/') ? file.rel.split('/')[1] : null
      if (!own) continue
      for (const spec of importsOf(file.source)) {
        const match = /modules\/([^/]+)\/(repository|routes)\.ts$/.exec(spec)
        if (match && match[1] !== own) offences.push(`${file.rel} -> ${spec}`)
      }
    }
    // admin/routes.ts is the composer for the surface it names, so it is
    // allowed to register its siblings' route plugins — that is its whole job.
    const real = offences.filter(o => !o.startsWith('modules/admin/routes.ts'))
    assert.deepEqual(real, [], 'a module imported another module\'s internals')
  })
})

describe('database access', () => {
  test('nothing builds its own pool', () => {
    // One pool per process. A second one silently doubles the connection
    // count and ignores every timeout configured for the first.
    const offences = files
      .filter(f => f.rel !== 'infrastructure/database/index.ts')
      .filter(f => /new pg\.Pool|createPool\(/.test(f.source))
      .map(f => f.rel)
    assert.deepEqual(offences, [], 'a second connection pool is being created')
  })

  test('the database is reached through one address', () => {
    const offences: string[] = []
    for (const file of files) {
      for (const spec of importsOf(file.source)) {
        if (/\/db\.ts$/.test(spec)) offences.push(`${file.rel} -> ${spec}`)
      }
    }
    assert.deepEqual(offences, [], 'something still imports the old src/db.ts')
  })
})

describe('modules that have a repository use it', () => {
  const SQL = /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\s/

  // `repository.ts`, or `<aggregate>-repository.ts` for a module big enough
  // that one file would be unreadable — the catalogue has two, one for anime
  // and one for episodes and what hangs off them.
  const isRepository = (rel: string): boolean => /^modules\/[^/]+\/[a-z-]*repository\.ts$/.test(rel)

  const withRepository = [...new Set(
    files.filter(f => isRepository(f.rel)).map(f => f.rel.split('/')[1] as string)
  )]

  test('at least one module has one, or this file asserts nothing', () => {
    assert.ok(withRepository.length >= 1, 'no module has a repository')
  })

  for (const name of withRepository) {
    test(`${name}: no SQL outside its repository`, () => {
      const offenders = files
        .filter(f => f.rel.startsWith(`modules/${name}/`) && !isRepository(f.rel))
        .filter(f => {
          // Comments are allowed to discuss SQL; only code counts.
          const code = f.source
            .split('\n')
            .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .join('\n')
          return SQL.test(code)
        })
        .map(f => f.rel)
      assert.deepEqual(offenders, [],
        `${name} has a repository, but SQL is still written outside it`)
    })
  }
})
