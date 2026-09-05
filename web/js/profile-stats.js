/* global window, localStorage, Store */
// Profile numbers: the account's, when there is an account.
//
// ---------------------------------------------------------------------------
// The problem this solves
// ---------------------------------------------------------------------------
// Three screens — profile, analytics, dashboard — each computed watch time,
// episode counts and completions from browser storage. That made the same
// account show different totals on two machines, and it meant the server's
// own `profile_stats` (computed from real watch history) had no reader.
//
// The server is now the authority for what was *watched*; the browser stays
// the authority for what the library *contains*, because that is what the
// local list is. Where the server has no answer — signed out, offline, or a
// profile that has watched nothing through this client — the local tally is
// used exactly as before.
//
// ---------------------------------------------------------------------------
// Why it hydrates instead of blocking
// ---------------------------------------------------------------------------
// The screens render synchronously from local data and are patched when the
// server answers. Making three renderers async to wait on a network call would
// trade a correct number for a blank screen, and the difference between the
// two numbers is usually nothing.

const ProfileStats = {
  // Kept per profile: two people sharing a browser must not see each other's
  // totals flash up before the fetch lands.
  _key () {
    return `yume-stats::${Store.activeProfileId()}`
  },

  /** The last server answer, if one was ever received on this device. */
  cached () {
    try {
      const raw = localStorage.getItem(this._key())
      return raw ? JSON.parse(raw) : null
    } catch (e) {
      return null
    }
  },

  _save (row) {
    try { localStorage.setItem(this._key(), JSON.stringify(row)) } catch (e) { /* full or private mode */ }
  },

  /**
   * Ask the server, cache the answer, and hand it back.
   *
   * Never throws and never returns a partial: a failed refresh leaves the
   * previous answer in place, because a stale number beats a blank one.
   */
  async refresh () {
    const row = await window.LibrarySync?.stats?.()
    if (!row) return this.cached()
    const clean = {
      minutes: Number(row.minutes_watched) || 0,
      episodes: Number(row.episodes_watched) || 0,
      completed: Number(row.anime_completed) || 0,
      meanScore: row.mean_score == null ? null : Number(row.mean_score),
      level: Number(row.level) || 1,
      xp: Number(row.xp_total) || 0,
      genres: row.genre_breakdown && typeof row.genre_breakdown === 'object' ? row.genre_breakdown : {},
      at: Date.now()
    }
    // A profile that has watched nothing on the server yet would otherwise
    // overwrite a browser tally with zeroes, which reads as data loss.
    if (!clean.minutes && !clean.episodes && !clean.completed) return this.cached()
    this._save(clean)
    return clean
  },

  /** Minutes as the screens spell them: "3d 4h", "12h 30m", "45m". */
  formatMinutes (minutes) {
    const hours = Math.floor(minutes / 60)
    if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
    if (hours >= 1) return `${hours}h ${minutes % 60}m`
    return `${minutes}m`
  },

  /**
   * Patch any `[data-stat]` element inside `root` with the server's number.
   *
   * Declarative on purpose: the caller marks which card holds which figure and
   * this fills them, so adding a card to a screen needs no change here and
   * mis-numbering a positional list is not a failure mode that exists.
   */
  async hydrate (root) {
    if (!root) return null
    const apply = row => {
      if (!row || !root.isConnected) return
      const set = (name, value) => {
        const node = root.querySelector(`[data-stat="${name}"] b, b[data-stat="${name}"]`)
        if (node) node.textContent = String(value)
      }
      set('watchTime', this.formatMinutes(row.minutes))
      set('episodes', row.episodes.toLocaleString(window.I18n?.locale?.() ?? 'hu-HU'))
      set('completed', row.completed)
      if (row.meanScore != null) set('meanScore', row.meanScore.toFixed(1))
      set('level', row.level)
    }

    apply(this.cached())
    const fresh = await this.refresh()
    apply(fresh)
    return fresh
  }
}

window.ProfileStats = ProfileStats
