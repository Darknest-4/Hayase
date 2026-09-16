// Folytatás: hol tartott a néző.
//
// Külön a haladásmérőtől, mert más a kérdés. A haladás azt méri, MENNYIT
// nézett; ez azt jegyzi meg, HOL hagyta abba. A kettő eltérhet: aki
// visszatekert és újranézett egy jelenetet, többet nézett, mint ahol áll.

/** Ennyi másodperc alatt nincs mit folytatni — a legelejét nem kínáljuk fel. */
export const MIN_RESUME_SEC = 10
/** A végén sincs: aki a legvégén hagyta abba, annak az epizód kész. */
export const END_MARGIN_SEC = 20

export function createResume (player, options = {}) {
  const { video } = player
  const store = options.store ?? null
  const key = options.key ?? null

  /** Felkínálható-e egyáltalán folytatás ebből a pozícióból. */
  const isResumable = (seconds, duration) => {
    const position = Number(seconds) || 0
    if (position < MIN_RESUME_SEC) return false
    if (duration && position > duration - END_MARGIN_SEC) return false
    return true
  }

  return {
    isResumable,

    /** A tárolt pozíció, vagy 0. Sosem dob: a tároló hibája nem kiesés. */
    saved () {
      if (!store || !key) return 0
      try { return Number(store.get(key)?.seconds) || 0 } catch { return 0 }
    },

    /**
     * Visszaállás a tárolt pozícióra, ha érdemes.
     *
     * A hosszra csak akkor tudunk szorítani, ha már ismerjük — ezért a hívó a
     * metaadat után hívja. Igazzal tér vissza, ha tényleg ugrott.
     */
    apply () {
      const seconds = this.saved()
      const duration = Number.isFinite(video.duration) ? video.duration : 0
      if (!isResumable(seconds, duration)) return false
      video.currentTime = seconds
      return true
    },

    remember (seconds, meta = {}) {
      if (!store || !key) return
      try { store.set(key, { seconds: Number(seconds) || 0, ...meta }) } catch { /* a tárolás legjobb szándék szerint */ }
    }
  }
}
