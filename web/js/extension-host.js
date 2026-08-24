/* global window, Worker, crypto, fetch, localStorage, AbortController, TextDecoder */
// Extension sandbox — the host half.
//
// The worker deliberately has no capabilities; everything it wants goes through
// here, and every request is checked against the permissions that version
// declared in its manifest. The worker's own lockdown is defence in depth —
// this file is the boundary that actually matters, so it never trusts anything
// the worker says about itself.
//
// Enforced here:
//   * sha256 of the package must match extension_versions.package_hash
//   * suspended extensions and incompatible minAppVersion never load (kill switch)
//   * net:fetch only to hostnames declared in the manifest, credentials omitted
//   * storage:local is namespaced per extension and size-capped
//   * every call is bounded by a timeout; a hung worker is terminated
//   * failures are isolated and reported as telemetry, never thrown at the UI

const ExtensionHost = {
  /** The client version that manifest.minAppVersion is checked against. */
  APP_VERSION: '1.0.0',

  CALL_TIMEOUT_MS: 10_000,
  FETCH_TIMEOUT_MS: 8000,
  MAX_RESPONSE_BYTES: 2 * 1024 * 1024, // 2 MB per extension request
  MAX_STORAGE_BYTES: 64 * 1024, // 64 KB per extension
  ALLOWED_METHODS: ['GET', 'POST'],

  _instances: new Map(), // slug → instance

  // ---------------------------------------------------------------- helpers

  async sha256Hex (text) {
    const bytes = new TextEncoder().encode(text)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  },

  compareVersions (a, b) {
    const parse = v => String(v).split('-')[0].split('.').map(Number)
    const left = parse(a); const right = parse(b)
    for (let i = 0; i < 3; i++) {
      const diff = (left[i] || 0) - (right[i] || 0)
      if (diff !== 0) return diff > 0 ? 1 : -1
    }
    return 0
  },

  /** Hostname allowlist check. Exact match or a subdomain of a declared host. */
  hostAllowed (url, hosts) {
    let parsed
    try { parsed = new URL(url) } catch (e) { return false }
    // only real web traffic — no file:, data:, blob: or other schemes
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    const hostname = parsed.hostname.toLowerCase()
    return hosts.some(host => hostname === host || hostname.endsWith('.' + host))
  },

  // ---------------------------------------------------------------- loading

  /**
   * Load an extension into its own worker.
   * `ext` needs: slug, status, version, packageHash, source, permissions, options.
   */
  async load (ext) {
    this.unload(ext.slug) // a reload always starts from a clean worker

    // kill switch: the store can disable an extension remotely
    if (ext.status && ext.status !== 'published') {
      throw new Error(`${ext.slug} is ${ext.status} and will not be loaded`)
    }
    if (ext.minAppVersion && this.compareVersions(this.APP_VERSION, ext.minAppVersion) < 0) {
      throw new Error(`${ext.slug} needs Yume ${ext.minAppVersion} or newer (this client is ${this.APP_VERSION})`)
    }

    // integrity: execute exactly the bytes that were reviewed
    if (ext.packageHash) {
      const actual = await this.sha256Hex(ext.source)
      if (actual !== ext.packageHash) {
        throw new Error(`${ext.slug} failed its integrity check — the package does not match its published hash`)
      }
    }

    const permissions = new Map((ext.permissions ?? []).map(p => [p.permission, p.hosts ?? []]))
    const worker = new Worker('/js/extension-worker.js', { type: 'module' })
    const instance = {
      slug: ext.slug,
      // The declared type decides who is allowed to ask this extension for
      // what. Without it every loaded extension was asked for stream
      // candidates, so a subtitle extension's .vtt arrived as a video source.
      // The install record has carried `type` all along; only this line was
      // missing.
      type: ext.type ?? 'http',
      worker,
      permissions,
      pending: new Map(),
      seq: 0,
      versionId: ext.versionId ?? null
    }
    this._instances.set(ext.slug, instance)

    worker.onmessage = event => this._onMessage(instance, event.data)
    worker.onerror = event => {
      this._failAll(instance, event.message || 'worker crashed')
      this.report(instance, 'error', { message: String(event.message ?? 'worker error').slice(0, 200) })
    }

    const ready = new Promise((resolve, reject) => {
      instance.onReady = resolve
      instance.onInitFailed = reject
    })
    worker.postMessage({ kind: 'init', source: ext.source, options: ext.options ?? {} })

    const timer = setTimeout(() => instance.onInitFailed?.(new Error('extension did not initialise in time')), this.CALL_TIMEOUT_MS)
    try {
      instance.methods = await ready
      return instance
    } catch (error) {
      this.unload(ext.slug)
      this.report(instance, 'load_failure', { message: String(error.message).slice(0, 200) })
      throw error
    } finally {
      clearTimeout(timer)
    }
  },

  unload (slug) {
    const instance = this._instances.get(slug)
    if (!instance) return
    this._failAll(instance, 'extension unloaded')
    instance.worker.terminate()
    this._instances.delete(slug)
  },

  unloadAll () {
    for (const slug of [...this._instances.keys()]) this.unload(slug)
  },

  /**
   * Loaded extension slugs.
   *
   * `loaded()` keeps returning slugs so existing callers are unaffected.
   * `loaded({ types })` narrows to the declared types, which is how each
   * consumer asks only the extensions that can answer it.
   */
  loaded (filter) {
    const types = filter?.types
    const entries = [...this._instances.values()]
    const wanted = types ? entries.filter(i => types.includes(i.type)) : entries
    return wanted.map(i => i.slug)
  },

  /** The declared type of one loaded extension, or null. */
  typeOf (slug) {
    return this._instances.get(slug)?.type ?? null
  },

  /**
   * Ask every extension of the given types for `method`, tolerating failure.
   *
   * One extension being broken must never deny the others, so each is settled
   * independently and its error recorded rather than thrown — the same rule
   * the streaming engine already applied to sources, now available to every
   * consumer instead of reimplemented per caller.
   */
  async collect (method, query, { types } = {}) {
    const slugs = this.loaded(types ? { types } : undefined)
    const results = []
    const errors = []
    const settled = await Promise.allSettled(slugs.map(async slug => ({
      slug,
      items: await this.call(slug, method, query)
    })))
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        errors.push(String(outcome.reason?.message ?? outcome.reason))
        continue
      }
      for (const item of outcome.value.items ?? []) results.push({ ...item, _source: outcome.value.slug })
    }
    return { results, errors }
  },

  // ---------------------------------------------------------------- calling

  /** Invoke a method on a loaded extension. Always resolves within the timeout. */
  call (slug, method, query) {
    const instance = this._instances.get(slug)
    if (!instance) return Promise.reject(new Error(`${slug} is not loaded`))

    const id = ++instance.seq
    const started = performance.now()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        instance.pending.delete(id)
        // a worker that ignores a call is wedged; replace it rather than leak it
        this.unload(slug)
        this.report(instance, 'error', { message: `${method}() timed out` })
        reject(new Error(`${slug}.${method}() timed out after ${this.CALL_TIMEOUT_MS}ms`))
      }, this.CALL_TIMEOUT_MS)

      instance.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
        started,
        method
      })
      instance.worker.postMessage({ kind: 'call', id, method, query })
    })
  },

  _failAll (instance, reason) {
    for (const [, pending] of instance.pending) pending.reject(new Error(reason))
    instance.pending.clear()
  },

  async _onMessage (instance, message) {
    switch (message.kind) {
      case 'ready':
        instance.onReady?.(message.methods ?? [])
        break

      case 'init-failed':
        instance.onInitFailed?.(new Error(message.error))
        break

      case 'log':
        console.info(`[ext:${instance.slug}]`, ...(message.args ?? []))
        break

      case 'result': {
        const pending = instance.pending.get(message.id)
        instance.pending.delete(message.id)
        pending?.resolve(message.result)
        break
      }

      case 'error': {
        const pending = instance.pending.get(message.id)
        instance.pending.delete(message.id)
        this.report(instance, 'error', { message: String(message.error).slice(0, 200) })
        pending?.reject(new Error(message.error))
        break
      }

      case 'host-call':
        await this._hostCall(instance, message)
        break
    }
  },

  // ------------------------------------------------------ permission gateway

  async _hostCall (instance, message) {
    const reply = (result, error) =>
      instance.worker.postMessage({ kind: 'host-reply', id: message.id, result, error })

    try {
      switch (message.op) {
        case 'fetch':
          reply(await this._proxyFetch(instance, message.payload))
          break
        case 'storage:get':
          reply(this._storage(instance, 'get', message.payload))
          break
        case 'storage:set':
          reply(this._storage(instance, 'set', message.payload))
          break
        case 'storage:remove':
          reply(this._storage(instance, 'remove', message.payload))
          break
        default:
          reply(undefined, `unknown host operation: ${message.op}`)
      }
    } catch (error) {
      reply(undefined, String(error?.message ?? error).slice(0, 300))
    }
  },

  async _proxyFetch (instance, { url, init = {} }) {
    const hosts = instance.permissions.get('net:fetch')
    if (!hosts) throw new Error('this extension did not declare the net:fetch permission')
    if (!this.hostAllowed(url, hosts)) {
      throw new Error(`blocked: ${url} is not in the declared host allowlist (${hosts.join(', ')})`)
    }

    const method = String(init.method ?? 'GET').toUpperCase()
    if (!this.ALLOWED_METHODS.includes(method)) throw new Error(`method ${method} is not allowed`)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        method,
        // extensions never act as the signed-in user
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'follow',
        signal: controller.signal,
        headers: this._safeHeaders(init.headers),
        body: method === 'POST' ? String(init.body ?? '').slice(0, 64 * 1024) : undefined
      })

      const body = await this._readCapped(res)
      return {
        ok: res.ok,
        status: res.status,
        // only the content type crosses back; response headers can carry
        // tracking and cookie material that extensions have no need for
        headers: { 'content-type': res.headers.get('content-type') ?? '' },
        body
      }
    } finally {
      clearTimeout(timer)
    }
  },

  /** Drop headers that could carry identity or confuse the origin server. */
  _safeHeaders (headers) {
    const blocked = ['authorization', 'cookie', 'set-cookie', 'host', 'origin', 'referer']
    const safe = {}
    for (const [key, value] of Object.entries(headers ?? {})) {
      const name = String(key).toLowerCase()
      if (blocked.includes(name) || name.startsWith('sec-') || name.startsWith('proxy-')) continue
      safe[name] = String(value).slice(0, 1000)
    }
    return safe
  },

  /** Read a response body, aborting past the cap instead of buffering it all. */
  async _readCapped (res) {
    const declared = Number(res.headers.get('content-length') ?? 0)
    if (declared > this.MAX_RESPONSE_BYTES) throw new Error('response exceeds the size limit')
    if (!res.body) return await res.text()

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let size = 0
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > this.MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('response exceeds the size limit')
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  },

  _storage (instance, action, { key, value }) {
    if (!instance.permissions.has('storage:local')) {
      throw new Error('this extension did not declare the storage:local permission')
    }
    // namespaced so one extension can never read or clobber another's data
    const storageKey = `ext:${instance.slug}:${String(key).slice(0, 120)}`
    if (action === 'get') {
      const raw = localStorage.getItem(storageKey)
      return raw === null ? null : JSON.parse(raw)
    }
    if (action === 'remove') {
      localStorage.removeItem(storageKey)
      return true
    }
    const serialised = JSON.stringify(value ?? null)
    if (serialised.length > this.MAX_STORAGE_BYTES) throw new Error('stored value exceeds the size limit')
    localStorage.setItem(storageKey, serialised)
    return true
  },

  // ---------------------------------------------------------------- bootstrap

  /**
   * Load every enabled extension this account has installed.
   *
   * Until this existed the sandbox was unreachable: packages had nowhere to be
   * stored and nothing ever called load(), so the streaming engine could only
   * ever see manually pasted URLs. This is the path that turns an install into
   * a working source.
   *
   * One extension failing must never stop the others, so each is loaded
   * independently and failures are reported rather than thrown.
   */
  async bootstrap () {
    if (!window.YumeAPI?.user?.()) return { loaded: [], failed: [] }

    let installed
    try {
      installed = await window.YumeAPI.installedExtensions()
    } catch (error) {
      return { loaded: [], failed: [], unavailable: error.message }
    }

    const loaded = []
    const failed = []

    await Promise.all(installed.filter(ext => ext.enabled).map(async ext => {
      try {
        const source = await window.YumeAPI.extensionPackage(ext.slug, ext.version)
        await this.load({
          slug: ext.slug,
          type: ext.type,
          status: ext.status,
          version: ext.version,
          versionId: ext.version_id,
          packageHash: ext.package_hash,
          minAppVersion: ext.min_app_version,
          permissions: ext.permissions,
          options: ext.options,
          source
        })
        loaded.push(ext.slug)
      } catch (error) {
        failed.push({ slug: ext.slug, error: error.message })
        console.warn('[extensions] could not load', ext.slug, '—', error.message)
      }
    }))

    return { loaded, failed }
  },

  // ---------------------------------------------------------------- telemetry

  /**
   * Report a failure so the developer portal shows breakage before users do.
   * Best-effort and anonymous — never blocks or surfaces an error itself.
   */
  report (instance, event, detail) {
    if (!window.YumeAPI?.user?.()) return
    window.YumeAPI.reportExtensionEvent?.(instance.slug, event, {
      ...detail,
      versionId: instance.versionId ?? undefined,
      appVersion: this.APP_VERSION
    })
  }
}

window.ExtensionHost = ExtensionHost
