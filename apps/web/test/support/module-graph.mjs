// The client's module graph, walked from its entry point.
//
// This exists because a check the old test suite could make stopped being
// possible and a better one became possible in its place. "Is this file
// actually part of the app" used to be answered by looking for its <script>
// tag in index.html — forty of them, in a load-bearing order. There is one now,
// so the question has to be asked of the imports instead, which is both more
// accurate (a tag could exist for a file nothing used) and more useful: it
// also answers "what is orphaned".

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = fileURLToPath(new URL('../../', import.meta.url))
const ENTRY = join(WEB, 'src/app/main.js')

// Az első ág NEM léphet át idézőjelen (`[^'"]*?`): egy import-záradékban a
// `from` előtt nincs idézőjel. Enélkül egy mellékhatás-import (`import './x.js'`)
// a következő import `from`-jáig nyúlt, és a saját célpontja kimaradt — ezért
// kellett eddig az ilyen importot a fájl végére tenni.
const SPEC = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g

/** Every static and dynamic import specifier in one file, resolved to a path. */
function importsOf (file) {
  const source = readFileSync(file, 'utf8')
  const out = []
  for (const match of source.matchAll(SPEC)) {
    const spec = match[1] ?? match[2] ?? match[3]
    if (!spec || !spec.startsWith('.')) continue
    out.push(resolve(dirname(file), spec))
  }
  return out
}

/**
 * Every module the browser would load, as paths relative to apps/web.
 *
 * Follows dynamic imports too: the HLS player is only fetched when a stream
 * needs it, but it is still part of the application rather than an orphan.
 */
export function reachableFromEntry () {
  const seen = new Set()
  const queue = [ENTRY]
  while (queue.length) {
    const file = queue.pop()
    const key = relative(WEB, file)
    if (seen.has(key)) continue
    seen.add(key)
    try {
      queue.push(...importsOf(file))
    } catch {
      // a specifier that does not resolve to a file on disk — reported by
      // the caller as a broken import, not swallowed here
    }
  }
  return seen
}

/** Every .js file under apps/web that ships to the browser. */
export function shippedFiles () {
  const out = []
  const walk = dir => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (['vendor', 'test', 'node_modules'].includes(entry)) continue
        walk(full)
      } else if (full.endsWith('.js')) {
        out.push(relative(WEB, full))
      }
    }
  }
  walk(WEB)
  return out
}

// Csak a statikus importok (a `SPEC` első és harmadik ága, a dinamikus nélkül).
const STATIC = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g
const DYNAMIC = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function specifiers (file, pattern) {
  const source = readFileSync(file, 'utf8')
  const out = []
  for (const match of source.matchAll(pattern)) {
    const spec = match[1] ?? match[2]
    if (spec?.startsWith('.')) out.push(resolve(dirname(file), spec))
  }
  return out
}

/**
 * Egy modul STATIKUS importgráfja, apps/web-hez viszonyított utakkal — amit a
 * böngésző a modullal együtt mindenképp letölt. `except`: ezeken nem megyünk át
 * (a keret moduljai, amik úgyis ott vannak).
 */
export function staticGraph (entry, except = new Set()) {
  const seen = new Set()
  const walk = file => {
    const key = relative(WEB, file)
    if (seen.has(key) || except.has(key)) return
    seen.add(key)
    for (const next of specifiers(file, STATIC)) walk(next)
  }
  walk(resolve(WEB, entry))
  return seen
}

/** A fájlok dinamikus importjainak céljai (apps/web-hez viszonyítva). */
export function dynamicImports (files) {
  const out = new Set()
  for (const file of files) for (const next of specifiers(resolve(WEB, file), DYNAMIC)) out.add(relative(WEB, next))
  return out
}
