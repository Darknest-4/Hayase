/* global window, document */
// Streaming engine — the layer between "the catalogue has a reference" and
// "the player has a video".
//
//   Source → Resolver → StreamResult → Player
//
// The player must not care where a stream came from, so every reference is
// normalised into one StreamResult shape here, ranked, and handed over one at
// a time. If a stream fails to start, the engine silently advances to the next
// candidate instead of showing the user a dead end.
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

  // ---------------------------------------------------------------- variant

  /**
   * Sub / dub, and which languages.
   *
   * Viewers ask for "dub", not for "a Japanese-audio release with a Hungarian
   * subtitle track", so the switch on the watch page is sub/dub and everything
   * below exists to answer that one question from whatever a source happened
   * to send.
   *
   * Three signals, in order of how much they can be trusted:
   *
   *   1. An explicit `audio` language from the source. A source that says
   *      "audio: hu" for a Hungarian audience is telling us it is a dub.
   *   2. Subtitle tracks. Original audio plus a subtitle track is a sub.
   *   3. The release title. Least reliable, and last — but in practice it is
   *      the only signal most sources give, so it cannot be skipped.
   *
   * Returns 'dub' | 'sub' | 'raw' | 'unknown'. 'unknown' is a real answer and
   * is never guessed into one of the others: a wrong guess starts the wrong
   * audio, which is worse than admitting we do not know.
   */
  VARIANT_PATTERNS: {
    // Word-bounded so "Subaru" is not a subtitle and "Dubai" is not a dub.
    dub: /\b(dub|dubbed|dual[\s.-]?audio|szinkron(os)?|magyar[\s.-]?szinkron)\b/i,
    sub: /\b(sub|subbed|subtitled|softsub|hardsub|multi[\s.-]?sub|felirat(os)?|magyar[\s.-]?felirat)\b/i,
    raw: /\b(raw|no[\s.-]?subs?|unsubbed)\b/i
  },

  /** Language codes we can name, mapped from the spellings sources use. */
  LANGUAGE_ALIASES: {
    hu: ['hu', 'hun', 'hungarian', 'magyar'],
    en: ['en', 'eng', 'english', 'angol'],
    ja: ['ja', 'jp', 'jpn', 'japanese', 'japán']
  },

  /** Normalise whatever spelling a source used into a two-letter code. */
  languageCode (value) {
    const raw = String(value ?? '').trim().toLowerCase()
    if (!raw) return null
    // 'hu-HU' and 'hu' are the same language.
    const base = raw.split(/[-_]/)[0]
    for (const [code, aliases] of Object.entries(this.LANGUAGE_ALIASES)) {
      if (aliases.includes(raw) || aliases.includes(base)) return code
    }
    return base.slice(0, 3) || null
  },

  classifyVariant (raw, subtitles) {
    const audioLang = this.languageCode(raw?.audio)
    const subLangs = [...new Set((subtitles ?? []).map(s => this.languageCode(s.lang)).filter(Boolean))]
    const title = String(raw?.title ?? '')

    // An explicit non-Japanese audio language is a dub by definition.
    if (audioLang && audioLang !== 'ja') return { variant: 'dub', audioLang, subLangs }
    // Japanese audio with subtitles is a sub, whatever the title claims.
    if (audioLang === 'ja' && subLangs.length) return { variant: 'sub', audioLang, subLangs }

    // Title, in a deliberate order: "Dual Audio" releases carry both and match
    // the dub pattern too, and someone who asked for a dub can use them, so dub
    // is tested first. `raw` last because a title can say "raw" about one of
    // several tracks.
    if (this.VARIANT_PATTERNS.dub.test(title)) return { variant: 'dub', audioLang, subLangs }
    if (this.VARIANT_PATTERNS.sub.test(title)) return { variant: 'sub', audioLang, subLangs }
    if (this.VARIANT_PATTERNS.raw.test(title)) return { variant: 'raw', audioLang, subLangs }

    // Subtitle tracks with no audio claim still mean a sub.
    if (subLangs.length) return { variant: 'sub', audioLang, subLangs }
    return { variant: 'unknown', audioLang, subLangs }
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
   * Normalise a raw source record into a StreamResult.
   *
   * Every field is coerced and bounded. The records come from the catalogue
   * and from what a viewer typed, and neither is a reason to trust a shape.
   */
  normalise (raw, source) {
    // `||`, not `??`. A record may carry both keys with one of them an empty
    // string, and `??` treats '' as present — so an empty `url` won the
    // fallback and every link-only result normalised to '' and was dropped
    // here with no error at all. That bug reported zero candidates and no
    // failure, which looked exactly like "nothing found".
    const url = String(raw?.url || raw?.link || '')
    if (!url) return null
    const kind = this.classify(url)
    const container = raw?.container ? String(raw.container).slice(0, 60) : null
    const { playable, reason } = this.playability(kind, container)

    const subtitles = Array.isArray(raw?.subtitles)
      ? raw.subtitles.slice(0, 20)
        .filter(s => s && typeof s.url === 'string')
        .map(s => ({ url: String(s.url), label: String(s.label ?? 'Subtitles').slice(0, 60), lang: String(s.lang ?? '').slice(0, 12) }))
      : []

    const { variant, audioLang, subLangs } = this.classifyVariant(raw, subtitles)

    return {
      id: `${source?.slug ?? 'manual'}:${url.slice(0, 120)}`,
      url,
      kind,
      container,
      // sub / dub / raw / unknown — what the watch page's switch reads
      variant,
      audioLang,
      subLangs,
      // quality may arrive as a number (1080), a label ("1080p") or not at
      // all, in which case it is parsed out of the release title
      quality: Number(raw?.quality) || this.detectQuality(raw?.quality) || this.detectQuality(raw?.title),
      audio: raw?.audio ? String(raw.audio).slice(0, 40) : null,
      subtitles,
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
   * How well a candidate matches what the viewer asked for.
   *
   * Separate from rank() so the watch page can show the same reasoning it
   * sorts by, and so a preference can be applied without re-fetching.
   *
   *   2  exactly the requested variant
   *   1  unknown variant — might be right, worth trying before a known wrong one
   *   0  the other variant
   *
   * 'any' scores everything equally, which is what "no preference" has to mean
   * for the rest of the ranking to decide.
   */
  variantScore (candidate, wanted) {
    if (!wanted || wanted === 'any') return 2
    if (candidate.variant === wanted) return 2
    if (candidate.variant === 'unknown') return 1
    return 0
  },

  /** Does this candidate carry the subtitle language the viewer wants? */
  subtitleScore (candidate, wanted) {
    if (!wanted || wanted === 'off') return 1
    return candidate.subLangs?.includes(wanted) ? 1 : 0
  },

  /**
   * Best candidate first.
   *
   * Playability dominates — an unplayable stream is never worth trying — and
   * the viewer's sub/dub choice comes immediately after it, ahead of source
   * health and quality. That order is the point of the preference: a 1080p
   * subbed release is the wrong answer for someone who asked for a dub, and
   * ranking it first would make the setting decorative.
   */
  rank (results, prefs = {}) {
    const wantVariant = prefs.variant ?? null
    const wantSubs = prefs.subtitles ?? null
    return [...results].sort((a, b) => {
      if (a.playable !== b.playable) return a.playable ? -1 : 1

      const variant = this.variantScore(b, wantVariant) - this.variantScore(a, wantVariant)
      if (variant) return variant

      const subs = this.subtitleScore(b, wantSubs) - this.subtitleScore(a, wantSubs)
      if (subs) return subs

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

  /** The identifiers a source lookup is made with. */
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
   * Normalise and rank what the caller has.
   *
   * `errors` is still returned, and still empty: the shape is what the watch
   * page reads, and a caller that gathers sources from somewhere that can fail
   * has somewhere to put the failure.
   */
  async candidates (media, episode, { sources = [], prefs = {} } = {}) {
    const results = []
    const errors = []

    for (const raw of sources) {
      const normalised = this.normalise(raw, raw.source)
      if (normalised) results.push(normalised)
    }

    return { results: this.rank(results, prefs), errors }
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

  /**
   * Subtitle tracks travel with the StreamResult, whatever produced it.
   *
   * Attaching them was only half the job: a <track> without `default` loads
   * as `disabled`, so every subtitle a source supplied was present in the DOM
   * and invisible on screen. The viewer's `playback.subtitles` preference is
   * what decides which one is showing.
   */
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
    this.selectSubtitleTrack(video, window.Prefs?.get('playback.subtitles') ?? null)
    this.selectAudioTrack(video, window.Prefs?.get('playback.audio') ?? null)
  },

  /**
   * Show the subtitle track in `language`, or none when it is 'off'.
   *
   * Matching is by language code rather than by label, because labels are
   * whatever a source felt like writing ("HU", "Magyar felirat", "hun-full").
   * Returns the index that ended up showing, or -1.
   */
  selectSubtitleTrack (video, language) {
    const tracks = video?.textTracks
    if (!tracks) return -1

    // Everything off first: leaving two showing stacks two sets of captions
    // on top of each other, which is worse than none.
    for (const track of tracks) {
      if (track.kind === 'subtitles' || track.kind === 'captions') track.mode = 'disabled'
    }
    if (!language || language === 'off') return -1

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]
      if (track.kind !== 'subtitles' && track.kind !== 'captions') continue
      if (this.languageCode(track.language) === language) {
        track.mode = 'showing'
        return i
      }
    }
    return -1
  },

  /**
   * Pick the audio track in `language`.
   *
   * `video.audioTracks` is not implemented in every browser — Chrome does not
   * expose it — so this is best-effort by design and reports what it managed.
   * The sub/dub preference does not depend on it: that is decided when ranking
   * candidates, where a dub is a different stream rather than a track inside
   * one. This only helps the multi-audio streams that do exist.
   */
  selectAudioTrack (video, language) {
    const tracks = video?.audioTracks
    if (!tracks || !tracks.length || !language) return -1
    for (let i = 0; i < tracks.length; i++) {
      if (this.languageCode(tracks[i].language) === language) {
        for (let j = 0; j < tracks.length; j++) tracks[j].enabled = j === i
        return i
      }
    }
    return -1
  },

  /** The subtitle tracks currently attached, for a picker to render. */
  subtitleTracks (video) {
    const tracks = video?.textTracks
    if (!tracks) return []
    const out = []
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]
      if (track.kind !== 'subtitles' && track.kind !== 'captions') continue
      out.push({
        index: i,
        label: track.label || track.language || `Track ${i + 1}`,
        language: this.languageCode(track.language),
        showing: track.mode === 'showing'
      })
    }
    return out
  },

  /**
   * SubRip to WebVTT.
   *
   * Browsers render only WebVTT in a <track>, and most subtitles in the world
   * are SubRip. The two differ in almost nothing: a header line, and a comma
   * where WebVTT wants a dot in the timestamps. Converting is a handful of
   * lines and the alternative is refusing most of the subtitles that exist.
   */
  srtToVtt (text) {
    const body = String(text ?? '')
      .replace(/\r\n?/g, '\n')
      // 00:00:12,500 --> 00:00:14,000   becomes   00:00:12.500 --> 00:00:14.000
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2')
    return body.startsWith('WEBVTT') ? body : 'WEBVTT\n\n' + body
  },

  /**
   * Turn subtitle text into something a <track> can load.
   *
   * A blob URL, because the alternative is asking the browser to fetch the
   * file itself — which needs the service to send CORS headers for track
   * elements, and most do not.
   *
   * Returns null rather than throwing: a subtitle that cannot be prepared is a
   * missing subtitle, not a broken player.
   */
  subtitleObjectUrl (content, format) {
    try {
      // The *source* is checked, not the converted text: srtToVtt() prepends a
      // WEBVTT header, so empty input converts to a non-empty string and an
      // empty subtitle would be attached as a valid track with no cues.
      if (!String(content ?? '').trim()) return null
      // ASS/SSA is not WebVTT and is not converted here; handing it over
      // unchanged would render a screenful of style directives.
      if (format === 'ass' || format === 'ssa') return null
      const text = format === 'srt' ? this.srtToVtt(content) : String(content)
      return URL.createObjectURL(new Blob([text], { type: 'text/vtt' }))
    } catch (e) {
      return null
    }
  },

  /**
   * Merge external subtitle tracks into a candidate before it is attached.
   *
   * De-duplicated on URL: the same file offered by two providers is one track,
   * and a picker listing it twice looks broken.
   */
  withExternalSubtitles (candidate, tracks) {
    if (!tracks?.length) return candidate
    const seen = new Set((candidate.subtitles ?? []).map(s => s.url))
    const extra = tracks.filter(track => track.url && !seen.has(track.url))
    if (!extra.length) return candidate
    return { ...candidate, subtitles: [...(candidate.subtitles ?? []), ...extra] }
  },

  /**
   * A failed stream is a data point about its source.
   *
   * It went to a telemetry endpoint that no longer exists. The console is
   * where it lands until there is somewhere better:
   * the equivalent for a registered source would be a health column on
   * `video_sources`, which is a feature and not a rename.
   */
  _report (candidate, reason) {
    if (candidate.source?.slug && candidate.source.slug !== 'manual') {
      console.warn(`[stream] ${candidate.source.name ?? candidate.source.slug} failed: ${reason}`)
    }
  }
}

window.StreamEngine = StreamEngine
