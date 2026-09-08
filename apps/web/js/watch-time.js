/* global window, document, localStorage, Store */
// Measured watch time.
//
// ---------------------------------------------------------------------------
// What was wrong
// ---------------------------------------------------------------------------
// Watch time was never measured. Five screens computed it the same way:
//
//     entries.reduce((s, e) => s + (e.progress ?? 0) * (e.media?.duration || 24), 0)
//
// — episodes marked watched, times a nominal runtime, with 24 minutes as the
// fallback when the catalogue does not know the real one. That is an estimate
// presented as a measurement, and it has two consequences a viewer notices:
//
//   * The moment an episode is credited, the profile gains a flat 24 minutes,
//     whether it was watched, skipped, or opened and abandoned.
//   * Achievements built on it reward marking things, not watching them.
//
// This module measures instead. It accumulates only the seconds the video was
// genuinely playing, and the episode-completion rule below is written against
// that number rather than against the playhead position.
//
// ---------------------------------------------------------------------------
// Why a tick loop and not `ended - started`
// ---------------------------------------------------------------------------
// Wall-clock between play and pause counts buffering, a laptop lid closing and
// a tab left open overnight. Sampling `currentTime` deltas counts a seek as
// watching. So: a timer that ticks while playing, adding real elapsed time,
// with every tick bounded — a delta larger than the tick interval means the
// timer did not run (throttled tab, sleeping machine), and only the interval
// itself is credited.

const WatchTime = {
  /** How often the meter ticks while playing. */
  TICK_MS: 1000,

  /**
   * A tick that arrives later than this counts as an interruption, and only
   * TICK_MS is credited for it. Browsers throttle timers in background tabs to
   * once a minute, and a sleeping laptop can produce a gap of hours; without
   * this bound either one would land in the total as watch time.
   */
  MAX_TICK_MS: 2500,

  /**
   * Share of the runtime that has to be genuinely watched before an episode
   * counts as watched.
   *
   * 0.8 rather than 0.85-of-the-playhead, and measured rather than positional:
   * dragging the scrubber to the end is not watching, and it used to be enough.
   */
  COMPLETE_RATIO: 0.8,

  /**
   * Lower bar once the video actually reaches its end. Somebody who skips the
   * intro, a recap and the ending has legitimately watched the episode while
   * accumulating well under 80% of its runtime.
   */
  COMPLETE_RATIO_ON_END: 0.5,

  STORAGE_KEY: 'yume-watchtime',

  // ---------------------------------------------------------------- storage

  _key () {
    return `${this.STORAGE_KEY}::${Store.activeProfileId()}`
  },

  /** { "animeId:episode": seconds } for the active profile. */
  all () {
    try {
      return JSON.parse(localStorage.getItem(this._key()) ?? '{}') ?? {}
    } catch (e) {
      return {}
    }
  },

  _write (map) {
    try {
      localStorage.setItem(this._key(), JSON.stringify(map))
    } catch (e) { /* storage full or unavailable — never worth throwing over */ }
  },

  slot (animeId, episode) {
    return `${animeId}:${episode}`
  },

  /** Seconds genuinely watched of one episode. */
  forEpisode (animeId, episode) {
    return Number(this.all()[this.slot(animeId, episode)]) || 0
  },

  /** Total measured seconds on this profile. */
  totalSeconds () {
    return Object.values(this.all()).reduce((sum, value) => sum + (Number(value) || 0), 0)
  },

  /** How many distinct episodes have any measured time at all. */
  episodesTouched () {
    return Object.values(this.all()).filter(value => (Number(value) || 0) > 0).length
  },

  /**
   * Add measured seconds to an episode.
   *
   * Capped at the episode's runtime plus a margin: a viewer who leaves a
   * finished video looping should not accumulate unbounded time on one
   * episode, and without a cap a single tab can dominate every statistic.
   */
  add (animeId, episode, seconds, runtimeSeconds = 0) {
    if (!(seconds > 0)) return 0
    const map = this.all()
    const key = this.slot(animeId, episode)
    const ceiling = runtimeSeconds > 0 ? runtimeSeconds * 1.2 : Infinity
    const next = Math.min((Number(map[key]) || 0) + seconds, ceiling)
    map[key] = Math.round(next)
    this._write(map)
    return map[key]
  },

  // ---------------------------------------------------------------- metering

  /**
   * Meter one <video>.
   *
   * `onComplete` fires once, when the measured time first clears the bar in
   * COMPLETE_RATIO — that is the signal an episode has actually been watched,
   * and it replaces the old "playhead reached 85%".
   *
   * Returns a detach function. Call it when the player leaves the DOM;
   * anything unflushed is written first.
   */
  attach (video, { animeId, episode, onComplete = () => {} } = {}) {
    if (!video || !animeId) return () => {}

    let timer = null
    let last = 0
    let pending = 0
    let completed = false

    const runtime = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0)

    const flush = () => {
      if (pending < 1) return
      const seconds = Math.floor(pending)
      pending -= seconds
      this.add(animeId, episode, seconds, runtime())
    }

    const checkComplete = () => {
      if (completed) return
      const total = runtime()
      if (!total) return
      const watched = this.forEpisode(animeId, episode) + pending
      const bar = video.ended ? this.COMPLETE_RATIO_ON_END : this.COMPLETE_RATIO
      if (watched >= total * bar) {
        completed = true
        onComplete({ watched, runtime: total })
      }
    }

    // Playing means: not paused, not ended, not mid-seek, and with enough data
    // buffered to be showing frames. `readyState` is what separates playing
    // from stalled — a video that has run out of buffer is not paused, but
    // nobody is watching anything.
    const isPlaying = () => !video.paused && !video.ended && !video.seeking && video.readyState >= 3

    const tick = () => {
      const now = Date.now()
      const elapsed = now - last
      last = now
      if (!isPlaying()) return
      // A gap longer than MAX_TICK_MS means the timer did not run — a
      // background tab, a sleeping machine — so only one interval is credited.
      pending += Math.min(elapsed, this.MAX_TICK_MS) / 1000
      flush()
      checkComplete()
    }

    const start = () => {
      if (timer) return
      last = Date.now()
      timer = setInterval(tick, this.TICK_MS)
    }

    const stop = () => {
      if (!timer) return
      clearInterval(timer)
      timer = null
      flush()
    }

    video.addEventListener('play', start)
    video.addEventListener('playing', start)
    video.addEventListener('pause', stop)
    video.addEventListener('waiting', stop)
    video.addEventListener('ended', () => { stop(); checkComplete() })

    // A hidden tab still plays audio, and that still counts — but the timer is
    // throttled there, which is exactly what MAX_TICK_MS bounds. Flushing on
    // hide means a tab closed while hidden does not lose its last seconds.
    const onVisibility = () => { if (document.hidden) flush() }
    document.addEventListener('visibilitychange', onVisibility)

    if (isPlaying()) start()

    return () => {
      stop()
      video.removeEventListener('play', start)
      video.removeEventListener('playing', start)
      video.removeEventListener('pause', stop)
      video.removeEventListener('waiting', stop)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  },

  // ---------------------------------------------------------------- reporting

  /**
   * Total watch time for a set of library entries, in minutes.
   *
   * Measured seconds where they exist; the old nominal estimate only for
   * episodes credited before this module existed. Without that fallback every
   * existing profile's history would drop to zero on upgrade — but nothing new
   * is ever estimated, so the estimated share shrinks as people watch.
   *
   * `estimatedMinutes` is returned separately so a screen can say how much of
   * the number is measured rather than presenting the mix as one fact.
   */
  minutesFor (entries) {
    const measured = this.all()
    let measuredSeconds = 0
    let estimatedMinutes = 0

    for (const key of Object.keys(measured)) measuredSeconds += Number(measured[key]) || 0

    for (const entry of entries ?? []) {
      const progress = entry?.progress ?? 0
      const nominal = entry?.media?.duration || 24
      for (let ep = 1; ep <= progress; ep++) {
        // Only episodes with no measurement fall back to the estimate.
        if (!measured[this.slot(entry.media?.id ?? entry.id, ep)]) estimatedMinutes += nominal
      }
    }

    return {
      measuredMinutes: Math.round(measuredSeconds / 60),
      estimatedMinutes,
      totalMinutes: Math.round(measuredSeconds / 60) + estimatedMinutes
    }
  }
}

if (typeof window !== 'undefined') window.WatchTime = WatchTime
if (typeof module !== 'undefined' && module.exports) module.exports = WatchTime
