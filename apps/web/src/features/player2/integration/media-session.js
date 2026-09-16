// Media Session — a zárolt képernyő és a fejhallgató gombjai.
//
// Ez az a felület, amitől a telefon zárolt képernyőjén megjelenik az anime
// címe és borítója, és amitől a fejhallgató középső gombja szünetet nyom.
// Kis felület, nagy különbség: e nélkül a lejátszás egy névtelen „hang" a
// rendszer szemében.
//
// MINDEN LÉPÉSE ELHAGYHATÓ. Ahol a böngésző nem ismeri, ott nem történik
// semmi — nincs szükség képességvizsgálatra a hívó oldalán.

/**
 * @param {object} player
 * @param {object} options `title`, `album`, `artwork`, `onNext`, `onPrevious`
 */
export function createMediaSession (player, options = {}) {
  const { video, state } = player
  const session = globalThis.navigator?.mediaSession
  if (!session) return { supported: false, update () {}, destroy () {} }

  const MediaMetadata = globalThis.MediaMetadata

  const update = (info = {}) => {
    if (!MediaMetadata) return
    const episode = info.episode ?? state.get().episode.current?.number
    try {
      session.metadata = new MediaMetadata({
        title: episode ? `${info.title ?? options.title ?? ''} — ${episode}. rész` : (info.title ?? options.title ?? ''),
        artist: info.artist ?? options.artist ?? 'YUME',
        album: info.album ?? options.album ?? '',
        // A BORÍTÓ TÖBB MÉRETBEN. A rendszer a magáét választja ki; egyetlen
        // mérettel a zárolt képernyőn elmosódott képet kapnánk.
        artwork: (info.artwork ?? options.artwork ?? []).map(art => ({
          src: art.src ?? art, sizes: art.sizes ?? '512x512', type: art.type ?? 'image/jpeg'
        }))
      })
    } catch { /* a metaadat nem kritikus */ }
  }

  const handlers = {
    play: () => { void video.play?.() },
    pause: () => video.pause?.(),
    seekbackward: details => { video.currentTime = Math.max(0, video.currentTime - (details?.seekOffset ?? 10)) },
    seekforward: details => { video.currentTime += details?.seekOffset ?? 10 },
    // A `seekto` a zárolt képernyő csúszkája. Enélkül a rendszer csúszkája
    // ott van, de nem csinál semmit — ami rosszabb, mint ha nem lenne.
    seekto: details => { if (details?.seekTime != null) video.currentTime = details.seekTime },
    stop: () => { video.pause?.(); video.currentTime = 0 }
  }
  if (typeof options.onNext === 'function') handlers.nexttrack = options.onNext
  if (typeof options.onPrevious === 'function') handlers.previoustrack = options.onPrevious

  const bound = []
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      session.setActionHandler(action, handler)
      bound.push(action)
    } catch {
      // A böngésző nem ismeri ezt a műveletet. Nem hiba: a többi mehet.
    }
  }

  // A POZÍCIÓ a zárolt képernyő csúszkáját mozgatja. Nem `timeupdate`-re:
  // az másodpercenként négyszer jön, és a rendszer csúszkájának nem kell
  // ilyen sűrűn frissülnie.
  const syncPosition = () => {
    if (typeof session.setPositionState !== 'function') return
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    if (!duration) return
    try {
      session.setPositionState({
        duration,
        playbackRate: video.playbackRate || 1,
        position: Math.min(video.currentTime || 0, duration)
      })
    } catch { /* a pozíció nem kritikus */ }
  }
  player.interval(syncPosition, 2000)
  player.listen(video, 'play', () => { session.playbackState = 'playing'; syncPosition() })
  player.listen(video, 'pause', () => { session.playbackState = 'paused' })
  player.listen(video, 'loadedmetadata', syncPosition)

  player.own(() => {
    for (const action of bound) {
      try { session.setActionHandler(action, null) } catch { /* lebontás */ }
    }
    try { session.metadata = null; session.playbackState = 'none' } catch { /* lebontás */ }
  })

  update()

  return { supported: true, update, actions: bound }
}
