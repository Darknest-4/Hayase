/* global window, document */
// Streaming engine — the layer between "an extension found something" and
// "the player has a video".
//
//   Extension → Source → Resolver → StreamResult → Player
//
// The player must not care which extension produced a stream, so everything an
// extension returns is normalised into one StreamResult shape here, ranked, and
// handed over one at a time. If a stream fails to start, the engine silently
// advances to the next candidate instead of showing the user a dead end.
//
// It plays what a source gives it and nothing more: no scraping, no bypassing
// of provider access controls, and formats the browser cannot handle are
// reported honestly rather than pretended away.

const StreamEngine = {
  /** How long a stream gets to produce data before it counts as failed. */
  START_TIMEOUT_MS: 12_000,

  /** Optional handlers for container formats the browser cannot play natively. */
  _handlers: new Map(),

  /**
   * Register support for a format (e.g. an hls.js adapter):
   *   StreamEngine.registerHandler('hls', (video, result) => detach)
   * Without a handler an unsupported format is skipped with a clear reason
   * rather than failing silently in the player.
   */
  registerHandler (kind, attach) {
    this._handlers.set(kind, attach)
  },

  // ---------------------------------------------------------------- shaping

  /** Classify a URL into the transport the player has to deal with. */
  classify (url) {
    const value = String(url ?? '')
    if (value.startsWith('magnet:')) return 'magnet'
    const path = value.split('?')[0].toLowerCase()
    if (path.endsWith('.m3u8')) return 'hls'
    if (path.endsWith('.mpd')) return 'dash'
    if (/^https?:/.test(value)) return 'direct'
    return 'unknown'
  },

  /** Pull a resolution out of a release title when the source did not say. */
  detectQuality (title) {
    const match = /(\d{3,4})[pP]\b/.exec(String(title ?? ''))
    if (match) return Number(match[1])
    if (/\b4k\b|\buhd\b/i.test(String(title ?? ''))) return 2160
    return null
  },

  /**
   * Can this runtime actually play it? A browser cannot open a magnet link,
   * and without a registered handler it cannot play HLS or DASH either unless
   * the codec is natively supported.
   */
  playability (kind, container) {
    if (kind === 'magnet') {
      return { playable: false, reason: 'torrent sources need the desktop client' }
    }
    if (kind === 'hls' || kind === 'dash') {
      if (this._handlers.has(kind)) return { playable: true, reason: null }
      const probe = document.createElement('video')
      const mime = kind === 'hls' ? 'application/vnd.apple.mpegurl' : 'application/dash+xml'
      if (probe.canPlayType(mime)) return { playable: true, reason: null }
      return { playable: false, reason: `${kind.toUpperCase()} is not supported by this browser` }
    }
    if (kind === 'unknown') return { playable: false, reason: 'unrecognised stream URL' }
    if (container && !document.createElement('video').canPlayType(container)) {
      return { playable: false, reason: `codec ${container} is not supported by this browser` }
    }
    return { playable: true, reason: null }
  },

  /**
   * Normalise whatever an extension returned into a StreamResult.
   * Extensions are untrusted, so every field is coerced and bounded.
   */
  normalise (raw, source) {
    const url = String(raw?.url ?? raw?.link ?? '')
    if (!url) return null
    const kind = this.classify(url)
    const container = raw?.container ? String(raw.container).slice(0, 60) : null
    const { playable, reason } = this.playability(kind, container)

    return {
      id: `${source?.slug ?? 'manual'}:${url.slice(0, 120)}`,
      url,
      kind,
      container,
      // quality may arrive as a number (1080), a label ("1080p") or not at
      // all, in which case it is parsed out of the release title
      quality: Number(raw?.quality) || this.detectQuality(raw?.quality) || this.detectQuality(raw?.title),
      audio: raw?.audio ? String(raw.audio).slice(0, 40) : null,
      subtitles: Array.isArray(raw?.subtitles)
        ? raw.subtitles.slice(0, 20)
            .filter(s => s && typeof s.url === 'string')
            .map(s => ({ url: String(s.url), label: String(s.label ?? 'Subtitles').slice(0, 60), lang: String(s.lang ?? '').slice(0, 12) }))
        : [],
      // headers a source needs are recorded but NOT applied by the browser
      // player — a <video> element cannot send custom headers. They exist for
      // the desktop client, which can.
      headers: raw?.headers && typeof raw.headers === 'object' ? raw.headers : {},
      expiresAt: raw?.expiresAt ? Number(raw.expiresAt) : null,
      mode: raw?.mode === 'proxy' ? 'proxy' : 'direct',
      source: source ?? { slug: 'manual', name: 'Manual URL', accuracy: 'low', health: 'unknown' },
      playable,
      reason,
      metadata: {
        title: String(raw?.title ?? '').slice(0, 300),
        seeders: Number(raw?.seeders) || 0,
        size: Number(raw?.size) || 0
      }
    }
  },

  // ---------------------------------------------------------------- ranking

  _HEALTH_RANK: { healthy: 3, unknown: 2, unstable: 1, broken: 0 },
  _ACCURACY_RANK: { high: 3, medium: 2, low: 1 },

  /**
   * Best candidate first. Playability dominates — an unplayable stream is never
   * worth trying — then source health, then how exactly the source matched,
   * then quality and swarm size.
   */
  rank (results) {
    return [...results].sort((a, b) => {
      if (a.playable !== b.playable) return a.playable ? -1 : 1
      const health = (this._HEALTH_RANK[b.source.health] ?? 2) - (this._HEALTH_RANK[a.source.health] ?? 2)
      if (health) return health
      const accuracy = (this._ACCURACY_RANK[b.source.accuracy] ?? 1) - (this._ACCURACY_RANK[a.source.accuracy] ?? 1)
      if (accuracy) return accuracy
      const quality = (b.quality ?? 0) - (a.quality ?? 0)
      if (quality) return quality
      return b.metadata.seeders - a.metadata.seeders
    })
  },

  // ---------------------------------------------------------------- gathering

  /** The query handed to extensions. Only what they declared may reach them. */
  buildQuery (media, episode) {
    return {
      titles: [media?.title?.userPreferred, media?.title?.romaji, media?.title?.english, media?.title?.native]
        .filter(Boolean).slice(0, 4),
      episode,
      anilistId: media?.id ?? null,
      malId: media?.idMal ?? null,
      media
    }
  },

  /**
   * Ask every loaded extension for candidates. One failing extension never
   * blocks the others — its error is recorded and the rest still answer.
   */
  async candidates (media, episode, { sources = [], extensions = [] } = {}) {
    const query = this.buildQuery(media, episode)
    const results = []
    const errors = []

    for (const raw of sources) {
      const normalised = this.normalise(raw, raw.source)
      if (normalised) results.push(normalised)
    }

    const host = window.ExtensionHost
    if (host) {
      const settled = await Promise.allSettled(extensions.map(async ext => {
        const items = await host.call(ext.slug, 'single', query)
        return { ext, items }
      }))
      for (const outcome of settled) {
        if (outcome.status === 'rejected') {
          errors.push(String(outcome.reason?.message ?? outcome.reason))
          continue
        }
        const { ext, items } = outcome.value
        for (const item of items ?? []) {
          const normalised = this.normalise(item, {
            slug: ext.slug, name: ext.name ?? ext.slug,
            accuracy: item.accuracy ?? ext.accuracy ?? 'low',
            health: ext.health ?? 'unknown'
          })
          if (normalised) results.push(normalised)
        }
      }
    }

    return { results: this.rank(results), errors }
  },

  // ---------------------------------------------------------------- playing

  /**
   * Attach the first candidate that actually starts.
   *
   * A stream counts as working once the browser reports it can play; anything
   * else — an error event, an expired link, or silence past the timeout — moves
   * on to the next candidate. Resolves with the winning StreamResult, or throws
   * once every candidate is exhausted.
   */
  async play (video, candidates, { onAttempt, onFallback } = {}) {
    const attempts = []
    for (const candidate of candidates) {
      if (!candidate.playable) {
        attempts.push({ candidate, error: candidate.reason })
        continue
      }
      if (candidate.expiresAt && candidate.expiresAt < Date.now()) {
        attempts.push({ candidate, error: 'link expired' })
        continue
      }

      onAttempt?.(candidate)
      try {
        await this._attach(video, candidate)
        return { candidate, attempts }
      } catch (error) {
        const reason = String(error?.message ?? error)
        attempts.push({ candidate, error: reason })
        onFallback?.(candidate, reason)
        this._report(candidate, reason)
      }
    }
    const detail = attempts.length ? attempts[attempts.length - 1].error : 'no sources available'
    const failure = new Error(detail)
    failure.attempts = attempts
    throw failure
  },

  /** Attach one candidate and wait for it to prove it can play. */
  _attach (video, candidate) {
    return new Promise((resolve, reject) => {
      const handler = this._handlers.get(candidate.kind)
      let detach = null
      let settled = false

      const cleanup = () => {
        video.removeEventListener('canplay', onCanPlay)
        video.removeEventListener('loadeddata', onCanPlay)
        video.removeEventListener('error', onError)
        clearTimeout(timer)
      }
      const succeed = () => { if (settled) return; settled = true; cleanup(); resolve() }
      const fail = message => {
        if (settled) return
        settled = true
        cleanup()
        try { detach?.() } catch (e) { /* handler teardown is best-effort */ }
        reject(new Error(message))
      }

      const onCanPlay = () => succeed()
      const onError = () => fail(video.error?.message || 'the stream could not be played')

      video.addEventListener('canplay', onCanPlay, { once: true })
      video.addEventListener('loadeddata', onCanPlay, { once: true })
      video.addEventListener('error', onError)
      const timer = setTimeout(() => fail('the stream did not start in time'), this.START_TIMEOUT_MS)

      this._applySubtitles(video, candidate)
      try {
        if (handler) {
          // A handler may be async — the HLS one has to fetch its player
          // before it can attach anything. Either way the detach function is
          // captured, and a rejection fails this candidate so the engine
          // moves on to the next instead of stalling on a dead source.
          const attached = handler(video, candidate)
          if (attached && typeof attached.then === 'function') {
            attached.then(
              teardown => { detach = typeof teardown === 'function' ? teardown : null },
              error => fail(String(error?.message ?? error))
            )
          } else if (typeof attached === 'function') {
            detach = attached
          }
        } else { video.src = candidate.url; video.load() }
      } catch (error) {
        fail(String(error?.message ?? error))
      }
    })
  },

  /** Subtitle tracks travel with the StreamResult, whatever produced it. */
  _applySubtitles (video, candidate) {
    for (const track of [...video.querySelectorAll('track[data-engine]')]) track.remove()
    for (const subtitle of candidate.subtitles) {
      const track = document.createElement('track')
      track.kind = 'subtitles'
      track.label = subtitle.label
      if (subtitle.lang) track.srclang = subtitle.lang
      track.src = subtitle.url
      track.dataset.engine = '1'
      video.append(track)
    }
  },

  /** A failed stream is a data point about its source. */
  _report (candidate, reason) {
    if (candidate.source?.slug && candidate.source.slug !== 'manual') {
      window.YumeAPI?.reportExtensionEvent?.(candidate.source.slug, 'error', {
        message: `stream failed: ${reason}`.slice(0, 200)
      })
    }
  }
}

window.StreamEngine = StreamEngine
