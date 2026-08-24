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

/**
 * Schemes a result may name. The host only ever hands these to a <video>
 * element or a torrent client, and anything else — javascript:, data:, blob:,
 * file: — would be an injection dressed up as a stream, so it is dropped at
 * the boundary rather than trusted to be rejected further downstream.
 */
const SAFE_SCHEMES = ['http:', 'https:', 'magnet:']

function safeUrl (value, max = 2000) {
  const raw = str(value, max)
  if (!raw) return ''
  try {
    return SAFE_SCHEMES.includes(new URL(raw).protocol) ? raw : ''
  } catch {
    return '' // not a URL at all
  }
}

/**
 * Subtitle tracks travel as plain bounded records. The host turns these into
 * <track> elements, so the url gets the same scheme check as the stream.
 */
function sanitiseSubtitles (value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 20).map(track => {
    if (typeof track !== 'object' || track === null) return null
    const url = safeUrl(track.url)
    return url ? { url, label: str(track.label, 60) || 'Subtitles', lang: str(track.lang, 12) } : null
  }).filter(Boolean)
}

/**
 * Request headers a source needs. The browser player cannot apply them (a
 * <video> element sends no custom headers) but the desktop client can, so they
 * are carried across as bounded strings and nothing more.
 */
function sanitiseHeaders (value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out = {}
  for (const [name, header] of Object.entries(value).slice(0, 10)) {
    if (!/^[A-Za-z0-9-]{1,40}$/.test(name)) continue // not a header name
    const headerValue = str(header, 500)
    if (headerValue) out[name] = headerValue
  }
  return out
}

/**
 * Results cross the boundary as plain, bounded data — never live objects.
 *
 * The shape covers both source families the store declares. Torrent and NZB
 * extensions return a link plus swarm health; http and subtitle extensions
 * return a playable url with quality, audio, container and subtitle tracks.
 * Until these direct-source fields existed the sanitiser dropped them, so an
 * http extension could return a perfectly good stream and the engine would
 * see nothing at all.
 */
function sanitiseResult (item) {
  if (typeof item !== 'object' || item === null) return null
  const title = str(item.title, 500)
  if (!title) return null

  const link = safeUrl(item.link)
  const url = safeUrl(item.url)
  // a result that names no location is not a source
  if (!link && !url) return null

  return {
    title,
    link,
    hash: /^[a-fA-F0-9]{40}$|^[A-Z2-7]{32}$/.test(String(item.hash ?? '')) ? String(item.hash) : '',
    seeders: num(item.seeders, 1e6),
    leechers: num(item.leechers, 1e6),
    downloads: num(item.downloads, 1e9),
    size: num(item.size, 1e13),
    date: item.date ? new Date(item.date).toISOString() : null,
    accuracy: clampAccuracy(item.accuracy),
    type: str(item.type, 40) || undefined,

    // ---- direct-source fields (http / subtitle extensions) ----
    url,
    quality: str(item.quality, 20),
    audio: str(item.audio, 40),
    container: str(item.container, 60),
    subtitles: sanitiseSubtitles(item.subtitles),
    headers: sanitiseHeaders(item.headers),
    expiresAt: item.expiresAt ? new Date(item.expiresAt).getTime() || null : null,
    mode: item.mode === 'proxy' ? 'proxy' : 'direct'
  }
}

/**
 * A subtitle track, from a `subtitle` extension.
 *
 * Shaped differently from a stream result on purpose. Until this existed the
 * worker ran every array through sanitiseResult(), so a subtitle extension's
 * output arrived looking like a playable stream — and the engine dutifully
 * offered a .vtt file to the player as a video. A subtitle is not a source.
 */
/** A subtitle file is text; 512 KB is far past any real one. */
const MAX_SUBTITLE_BYTES = 512 * 1024

function sanitiseSubtitle (item) {
  if (typeof item !== 'object' || item === null) return null

  // A track arrives either as a URL the player can hand to a <track>, or as
  // the text itself.
  //
  // Content matters more than it looks. A <track> element fetches its src
  // itself, which means the file has to be CORS-readable from the page — most
  // subtitle services are not — and browsers render only WebVTT there, while
  // most of the world ships SubRip. An extension that has already fetched the
  // file through the host proxy can hand over the text and sidestep both.
  const url = safeUrl(item.url)
  const content = typeof item.content === 'string' && item.content.trim()
    ? item.content.slice(0, MAX_SUBTITLE_BYTES)
    : null
  if (!url && !content) return null

  return {
    url,
    content,
    lang: str(item.lang, 12),
    label: str(item.label, 60) || str(item.lang, 12) || 'Subtitles',
    format: /^(vtt|srt|ass|ssa)$/i.test(String(item.format ?? '')) ? String(item.format).toLowerCase() : 'vtt',
    // A hint the player uses to pick a default when nothing else decides.
    forced: item.forced === true
  }
}

/** Keys whose string value is treated as a URL and must survive safeUrl. */
const URL_KEYS = /(^|_)(url|image|icon|thumbnail|banner)$/i

/**
 * A metadata record, from a `metadata` extension.
 *
 * Deliberately a flat, bounded bag rather than a per-feature schema: skip
 * segments, characters, staff and recommendations are all metadata, and a
 * schema per kind here would mean editing the sandbox every time a new one is
 * wanted. `kind` says what it is; the consumer validates the fields it needs.
 *
 * Only primitives cross, one level deep — a nested object is an easy route to
 * a prototype-pollution bug on the other side of the boundary, and nothing
 * needs one.
 */
function sanitiseMetadata (item) {
  if (typeof item !== 'object' || item === null) return null
  const kind = str(item.kind, 40)
  if (!kind) return null

  const out = { kind }
  let fields = 0
  for (const [rawKey, value] of Object.entries(item)) {
    if (rawKey === 'kind' || rawKey === '__proto__' || rawKey === 'constructor') continue
    if (fields >= 24) break
    const key = str(rawKey, 40)
    if (!key) continue

    if (typeof value === 'number' && Number.isFinite(value)) { out[key] = value; fields++ } else if (typeof value === 'boolean') { out[key] = value; fields++ } else if (typeof value === 'string') {
      if (URL_KEYS.test(key)) {
        const url = safeUrl(value)
        if (url) { out[key] = url; fields++ }
      } else {
        out[key] = value.slice(0, 1000)
        fields++
      }
    }
  }
  return out
}

const MAX_RESULTS = 200

// ---------------------------------------------------------------- lifecycle

/**
 * Every method an extension may implement, and how its result is sanitised.
 *
 * The three added here are what makes the non-stream extension types mean
 * anything: `subtitle`, `metadata` and `theme` were valid in the manifest
 * validator but nothing ever called them, and anything they returned was
 * sanitised as a stream.
 */
const SANITISERS = {
  single: sanitiseResult,
  batch: sanitiseResult,
  movie: sanitiseResult,
  subtitles: sanitiseSubtitle,
  metadata: sanitiseMetadata,
  theme: sanitiseMetadata
}
const METHODS = ['test', ...Object.keys(SANITISERS)]

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
      self.postMessage({ kind: 'ready', methods: METHODS.filter(m => typeof impl[m] === 'function') })
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
        // Per method, not one shape for everything: a subtitle track and a
        // stream have nothing in common, and running both through the stream
        // sanitiser is what made the non-stream types unusable.
        const sanitise = SANITISERS[method] ?? sanitiseResult
        payload = result.slice(0, MAX_RESULTS).map(sanitise).filter(Boolean)
      } else {
        payload = []
      }
      self.postMessage({ kind: 'result', id, result: payload, accuracyCap: accuracyCap() })
    } catch (error) {
      self.postMessage({ kind: 'error', id, error: String(error?.message ?? error).slice(0, 500) })
    }
  }
}
