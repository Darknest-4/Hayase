// The client's dependency direction, asserted rather than hoped for.
//
// Making the client ES modules is what made this checkable at all: for as long
// as every file hung its object off `window`, there were no imports to look
// at and no direction to enforce. There were 51 reference cycles and nothing
// that could say so.
//
// The layers, from the bottom up. Each may import from the ones below it and
// from nothing above:
//
//   shared      lib, state, ui, api, i18n — the foundation. Knows nothing
//               about this product: no catalogue, no router, no screens.
//   entities    the business objects, and how they are fetched.
//   features    one folder per thing the product does.
//   pages       the route-level screens.
//   app         the router and the composition root, which is allowed to
//               reach anywhere — wiring is its whole job.
//
// Every one of these rules was broken before it was written. shared/ui asked
// the router whether a feature was on and fetched banner images through the
// catalogue; shared/state reached up into the library-sync feature and the
// achievements *page* to report what had changed. Each is a registration at
// the composition root now, which is the same fix three times: the lower layer
// declares what it needs, and app/main.js supplies it.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { reachableFromEntry, shippedFiles } from './support/module-graph.mjs'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/** Every client module, with the specifiers it imports. */
const modules = (function collect (dir = SRC, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== 'vendor') collect(full, out)
    } else if (full.endsWith('.js')) {
      const source = readFileSync(full, 'utf8')
      out.push({
        path: relative(SRC, full).replaceAll('\\', '/'),
        imports: [...source.matchAll(/(?:from|import\(|import)\s*'([^']+)'/g)]
          .map(m => m[1])
          .filter(spec => spec.startsWith('.'))
      })
    }
  }
  return out
})()

/** Which layer a path belongs to. */
const layerOf = path => path.split('/')[0]

/** Resolve an import against the file that made it, back to a layer. */
function targetLayer (fromPath, specifier) {
  const dir = fromPath.split('/').slice(0, -1)
  for (const part of specifier.split('/')) {
    if (part === '.') continue
    else if (part === '..') dir.pop()
    else dir.push(part)
  }
  return dir[0]
}

const ORDER = ['shared', 'entities', 'features', 'pages', 'app']

describe('the client\'s layers', () => {
  it('has files in every layer, or this file asserts nothing', () => {
    for (const layer of ORDER) {
      assert.ok(modules.some(m => layerOf(m.path) === layer), `no modules in ${layer}/`)
    }
  })

  it('never imports from a layer above its own', () => {
    // app/ is the composition root and is exempt: wiring the layers together
    // is the one job that has to see all of them.
    const offences = []
    for (const module of modules) {
      const from = layerOf(module.path)
      if (from === 'app') continue
      for (const spec of module.imports) {
        const to = targetLayer(module.path, spec)
        if (!ORDER.includes(to) || to === from) continue
        if (ORDER.indexOf(to) > ORDER.indexOf(from)) {
          offences.push(`${module.path} -> ${spec}  (${from} reaching into ${to})`)
        }
      }
    }
    assert.deepEqual(offences, [], 'the dependency direction is inverted somewhere')
  })

  it('shared/ knows nothing about this particular product', () => {
    // The strongest form of the rule above, and the one that decides whether
    // this layer could ever be lifted into a package the admin panel shares.
    const offences = []
    for (const module of modules) {
      if (layerOf(module.path) !== 'shared') continue
      for (const spec of module.imports) {
        if (targetLayer(module.path, spec) !== 'shared') offences.push(`${module.path} -> ${spec}`)
      }
    }
    assert.deepEqual(offences, [], 'shared/ imports something outside itself')
  })

  it('no page imports another page', () => {
    // Two screens that import each other are one screen with two URLs. What
    // they share belongs in features/ or shared/ui.
    const offences = []
    for (const module of modules) {
      if (layerOf(module.path) !== 'pages') continue
      for (const spec of module.imports) {
        if (!targetLayer(module.path, spec)) continue
        const resolved = spec.replace(/^\.\//, 'pages/')
        if (targetLayer(module.path, spec) === 'pages' && spec.startsWith('./')) {
          offences.push(`${module.path} -> ${resolved}`)
        }
      }
    }
    // The profile screen composes two sub-screens that are also routes of
    // their own — the analytics and history tabs. That is a real composition
    // rather than a tangle, so it is named here rather than the rule being
    // dropped; the third thing it used to reach for, the achievements
    // catalogue, turned out to be a feature and moved.
    const allowed = new Set(['pages/profile.js'])
    assert.deepEqual(offences.filter(o => !allowed.has(o.split(' ')[0])), [])
  })
})

describe('what ships', () => {
  it('has no orphan: every file is reachable from the entry point', () => {
    const reachable = reachableFromEntry()
    const orphans = shippedFiles().filter(f => !reachable.has(f))
    assert.deepEqual(orphans, [], 'these files ship but nothing imports them')
  })

  it('imports nothing that does not exist', () => {
    const missing = []
    for (const module of modules) {
      for (const spec of module.imports) {
        const dir = module.path.split('/').slice(0, -1)
        for (const part of spec.split('/')) {
          if (part === '.') continue
          else if (part === '..') dir.pop()
          else dir.push(part)
        }
        try {
          statSync(join(SRC, dir.join('/')))
        } catch {
          missing.push(`${module.path} -> ${spec}`)
        }
      }
    }
    assert.deepEqual(missing, [])
  })
})
