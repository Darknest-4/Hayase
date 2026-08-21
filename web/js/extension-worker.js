/* eslint-env worker */
// Extension sandbox — the worker half.
//
// This file is served from our own origin (so `worker-src 'self'` is enough)
// and runs ONE extension. Before any extension code is evaluated it removes
// every ambient capability from the worker global: an extension has no network,
// no storage, no nested workers and no DOM. Everything it is allowed to do goes
// back to the host over postMessage, where the declared permissions are
// enforced. Capability removal happens here as defence in depth — the host
// checks every request again regardless of what the worker claims.

// ---------------------------------------------------------------- lockdown

const REMOVED = [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts',
  'Worker', 'SharedWorker', 'indexedDB', 'caches', 'BroadcastChannel',
  'Notification', 'navigator', 'crypto'
]

for (const name of REMOVED) {
  try {
    Object.defineProperty(self, name, {
      configurable: false,
      get () { throw new Error(`${name} is not available to extensions — use the yume API`) }
    })
  } catch (e) { /* already non-configurable in this engine */ }
}

// ---------------------------------------------------------------- host bridge

let seq = 0
const waiting = new Map()

function hostCall (op, payload) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    self.postMessage({ kind: 'host-call', id, op, payload })
  })
}

/** The only surface an extension gets. Each method is permission-checked host-side. */
const yume = {
  /** Permission net:fetch — the host rejects any host outside the manifest allowlist. */
  async fetch (url, init) {
    const res = await hostCall('fetch', { url: String(url), init: init ?? {} })
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      text: async () => res.body,
      json: async () => JSON.parse(res.body)
    }
  },
  /** Permission storage:local — namespaced per extension, host-enforced. */
  storage: {
    get: key => hostCall('storage:get', { key: String(key) }),
    set: (key, value) => hostCall('storage:set', { key: String(key), value }),
    remove: key => hostCall('storage:remove', { key: String(key) })
  },
  log: (...args) => { self.postMessage({ kind: 'log', args: args.map(a => String(a).slice(0, 500)) }) }
}
self.yume = yume

// ---------------------------------------------------------------- accuracy

// Hayase's accuracy heuristic: an extension may only claim the accuracy its
// inputs can support. Matching on an external episode id can be exact; matching
// on a title string cannot. The query is handed over as a recording Proxy so
// the cap is derived from what the code actually read, not from what it claims.
const ACCURACY_RANK = { high: 3, medium: 2, low: 1 }
let touched = new Set()

function recordingQuery (query) {
  return new Proxy(query, {
    get (target, prop) {
      if (typeof prop === 'string') touched.add(prop)
      return target[prop]
    }
  })
}

function accuracyCap () {
  // reading titles or the whole media object caps the claim at medium
  if (touched.has('titles') || touched.has('media')) return 'medium'
  return 'high'
}

const clampAccuracy = claimed => {
  const cap = accuracyCap()
  const value = ACCURACY_RANK[claimed] ? claimed : 'low'
  return ACCURACY_RANK[value] > ACCURACY_RANK[cap] ? cap : value
}

// ---------------------------------------------------------------- sanitising

const str = (value, max) => typeof value === 'string' ? value.slice(0, max) : ''
const num = (value, max) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0
}

/** Results cross the boundary as plain, bounded data — never live objects. */
function sanitiseResult (item) {
  if (typeof item !== 'object' || item === null) return null
  const title = str(item.title, 500)
  if (!title) return null
  return {
    title,
    link: str(item.link, 2000),
    hash: /^[a-fA-F0-9]{40}$|^[A-Z2-7]{32}$/.test(String(item.hash ?? '')) ? String(item.hash) : '',
    seeders: num(item.seeders, 1e6),
    leechers: num(item.leechers, 1e6),
    downloads: num(item.downloads, 1e9),
    size: num(item.size, 1e13),
    date: item.date ? new Date(item.date).toISOString() : null,
    accuracy: clampAccuracy(item.accuracy),
    type: str(item.type, 40) || undefined
  }
}

const MAX_RESULTS = 200

// ---------------------------------------------------------------- lifecycle

let impl = null
let options = {}

self.onmessage = async event => {
  const message = event.data

  // a reply to something this worker asked the host for
  if (message.kind === 'host-reply') {
    const pending = waiting.get(message.id)
    if (!pending) return
    waiting.delete(message.id)
    if (message.error) pending.reject(new Error(message.error))
    else pending.resolve(message.result)
    return
  }

  if (message.kind === 'init') {
    try {
      options = message.options ?? {}
      // The source is imported as a module from a blob the host built from the
      // hash-verified package, so the bytes executed are the bytes that were
      // reviewed. Remote imports cannot happen: the CSP allows only 'self' and
      // blob:, and no network primitive exists in here.
      const url = URL.createObjectURL(new Blob([message.source], { type: 'text/javascript' }))
      try {
        const mod = await import(url)
        impl = mod.default
      } finally {
        URL.revokeObjectURL(url)
      }
      if (!impl || typeof impl !== 'object') throw new Error('extension must default-export an object')
      self.postMessage({ kind: 'ready', methods: ['test', 'single', 'batch', 'movie'].filter(m => typeof impl[m] === 'function') })
    } catch (error) {
      self.postMessage({ kind: 'init-failed', error: String(error?.message ?? error).slice(0, 500) })
    }
    return
  }

  if (message.kind === 'call') {
    const { id, method, query } = message
    try {
      if (!impl || typeof impl[method] !== 'function') throw new Error(`extension does not implement ${method}()`)
      touched = new Set()
      const result = await impl[method](query ? recordingQuery(query) : undefined, options)

      let payload
      if (method === 'test') {
        payload = result === true
      } else if (Array.isArray(result)) {
        payload = result.slice(0, MAX_RESULTS).map(sanitiseResult).filter(Boolean)
      } else {
        payload = []
      }
      self.postMessage({ kind: 'result', id, result: payload, accuracyCap: accuracyCap() })
    } catch (error) {
      self.postMessage({ kind: 'error', id, error: String(error?.message ?? error).slice(0, 500) })
    }
  }
}
