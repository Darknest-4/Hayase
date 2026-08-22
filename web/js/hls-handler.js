/* global window, document, HTMLMediaElement */
// HLS playback for the streaming engine.
//
// The engine has had a `registerHandler` seam since it was written, but no
// handler was ever registered — so `playability()` fell back to asking the
// browser, and outside Safari the answer for HLS is "no". Since the large
// majority of real anime sources are HLS, that meant the engine ranked and
// tried candidates it could never actually play.
//
// Two rules shape this file:
//
//   1. Native first. Safari and iOS play HLS from a plain `video.src`, with
//      hardware decoding and lower memory use than any JS player. hls.js is
//      only for browsers that cannot.
//
//   2. Load hls.js lazily. It is ~578 KB, and most sessions never touch an
//      HLS stream. It is fetched on the first HLS attempt, then reused — so
//      the initial page load is unchanged.
//
// hls.js is vendored at js/vendor/hls.min.mjs (Apache-2.0, see hls.LICENSE)
// rather than pulled from a CDN: the CSP allows scripts from 'self' only, and
// a player that stops working because someone else's CDN went down is not a
// player.

const HlsHandler = {
  /** Resolved module, or a promise while it is loading. Loaded at most once. */
  _module: null,
  _loading: null,

  /** Does this browser play HLS without help? (Safari, iOS, some smart TVs) */
  nativeSupport () {
    if (typeof document === 'undefined') return false
    const probe = document.createElement('video')
    return probe.canPlayType('application/vnd.apple.mpegurl') !== ''
  },

  async _load () {
    if (this._module) return this._module
    if (!this._loading) {
      this._loading = import('./vendor/hls.min.mjs')
        .then(mod => { this._module = mod.default ?? mod; return this._module })
        .catch(error => {
          this._loading = null // a failed load must not poison later attempts
          throw new Error('the HLS player could not be loaded: ' + error.message)
        })
    }
    return this._loading
  },

  /**
   * Attach an HLS stream to a video element.
   *
   * Returns a detach function, which the engine calls before it tries the next
   * candidate. Detaching matters more here than for a plain `src`: an orphaned
   * hls.js instance keeps buffering in the background, so failing over three
   * dead sources would otherwise leave three players fetching segments.
   */
  async attach (video, result) {
    // Native playback needs no library at all.
    if (this.nativeSupport()) {
      video.src = result.url
      video.load()
      return () => { video.removeAttribute('src'); video.load() }
    }

    const Hls = await this._load()
    if (!Hls.isSupported()) {
      throw new Error('this browser cannot play HLS (no Media Source Extensions)')
    }

    const hls = new Hls({
      // Keep memory bounded: a long series left open should not grow without
      // limit, and the engine may be juggling several attempts.
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      backBufferLength: 30,
      // The engine already applies its own timeout per candidate, so give up
      // quickly here rather than stacking two long waits.
      manifestLoadingTimeOut: 8_000,
      manifestLoadingMaxRetry: 1,
      levelLoadingTimeOut: 8_000,
      fragLoadingTimeOut: 20_000,
      // Custom headers cannot be set on media requests from a browser anyway;
      // the desktop client is where result.headers get applied.
      xhrSetup: undefined
    })

    const detach = () => {
      try { hls.destroy() } catch { /* already gone */ }
      video.removeAttribute('src')
      video.load()
    }

    // A fatal error must surface as a rejection so the engine moves on to the
    // next candidate instead of leaving the user on a stalled player.
    const ready = new Promise((resolve, reject) => {
      const onError = (_event, data) => {
        if (!data?.fatal) return // non-fatal errors are hls.js's to recover from
        detach()
        reject(new Error(`HLS ${data.type ?? 'error'}: ${data.details ?? 'playback failed'}`))
      }
      hls.on(Hls.Events.ERROR, onError)
      hls.on(Hls.Events.MANIFEST_PARSED, () => resolve())
    })

    hls.loadSource(result.url)
    hls.attachMedia(video)
    await ready
    return detach
  },

  /** Register with the engine. Safe to call more than once. */
  install () {
    const engine = window.StreamEngine
    if (!engine?.registerHandler) return false
    engine.registerHandler('hls', (video, result) => this.attach(video, result))
    return true
  }
}

window.HlsHandler = HlsHandler
HlsHandler.install()
