/* global document */
// A következő rész kártyája.
//
// A stáblista alatt jelenik meg, visszaszámlálóval. Három szabály, és
// mindhárom ugyanarról szól: A NÉZŐ DÖNT.
//
//   * a visszaszámlálás MEGSZAKÍTHATÓ, és a megszakítás végleges erre a
//     részre — nem jön vissza tíz másodperc múlva;
//   * a kártya akkor is megjelenik, ha az automatikus továbblépés ki van
//     kapcsolva: akkor gomb, nem visszaszámláló;
//   * a visszatekerés ELTÜNTETI. Aki visszament a stáblista elé, az nézni
//     akar valamit, nem továbblépni.

/** Ennyivel a vége előtt jelenik meg. */
export const SHOW_BEFORE_END_SEC = 25

/**
 * Meg kell-e jelennie a kártyának.
 *
 * Külön függvény, mert ez az egyetlen döntés — a többi megjelenítés.
 */
export function shouldShow ({ currentTime, duration, hasNext, dismissed }) {
  if (!hasNext || dismissed) return false
  if (!Number.isFinite(duration) || duration <= 0) return false
  // A nagyon rövid részeknél (előzetes, extra) a huszonöt másodperc a videó
  // fele lenne. Ott a kártya végigkísérné az egészet.
  const window = Math.min(SHOW_BEFORE_END_SEC, duration * 0.15)
  return currentTime >= duration - window
}

/**
 * @param {object} player
 * @param {object} options `prefs`, `onNext`, `onDismiss`
 */
export function createNextEpisodeCard (player, options = {}) {
  const { video, state, bus } = player
  const prefs = options.prefs ?? { get: () => undefined }

  const node = document.createElement('div')
  node.className = 'yp-next yp-hidden'
  node.setAttribute('role', 'region')
  node.setAttribute('aria-label', 'Következő rész')

  const title = document.createElement('p')
  title.className = 'yp-next-title'

  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'yp-next-go'
  go.addEventListener('click', () => { stop(); options.onNext?.() })

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'yp-next-cancel'
  cancel.textContent = 'Mégsem'
  cancel.addEventListener('click', () => dismiss())

  const actions = document.createElement('div')
  actions.className = 'yp-next-actions'
  actions.append(go, cancel)
  node.append(title, actions)

  let dismissed = false
  let remaining = null
  let ticking = null
  let visible = false

  const seconds = () => {
    const value = Number(prefs.get('player.ui.nextCountdownSec'))
    return Number.isFinite(value) ? Math.max(0, Math.min(30, value)) : 5
  }

  const label = () => {
    const next = state.get().episode.next
    return next?.title ?? (next?.number ? `${next.number}. rész` : 'Következő rész')
  }

  const paint = () => {
    title.textContent = label()
    go.textContent = remaining === null ? 'Következő rész' : `Következő rész — ${remaining}`
    // A gomb SZÖVEGE hordozza a visszaszámlálót, nem egy külön elem: egy
    // felolvasó így egyetlen, értelmes mondatot mond, nem két félmondatot.
    go.setAttribute('aria-label', remaining === null
      ? `Ugrás erre: ${label()}`
      : `Ugrás erre: ${label()} — ${remaining} másodperc múlva magától`)
    cancel.hidden = remaining === null
  }

  const stop = () => {
    if (ticking) { ticking(); ticking = null }
    remaining = null
  }

  const hide = () => {
    stop()
    if (!visible) return false
    visible = false
    node.classList.add('yp-hidden')
    return false
  }

  const dismiss = () => {
    // VÉGLEGES erre a részre. Egy visszaszámláló, ami a megszakítás után tíz
    // másodperccel újraindul, nem megszakítható — csak halogatható.
    dismissed = true
    hide()
    options.onDismiss?.()
    return true
  }

  const tick = () => {
    if (remaining === null) return
    remaining -= 1
    paint()
    if (remaining <= 0) { stop(); options.onNext?.() }
  }

  const show = () => {
    if (visible) return true
    visible = true
    node.classList.remove('yp-hidden')

    const auto = prefs.get('player.autoplayNext') === true
    const count = seconds()
    // Nulla másodperces visszaszámlálás nem visszaszámlálás: ott azonnal
    // ugrunk, kártya nélkül.
    if (auto && count === 0) { options.onNext?.(); return true }
    remaining = auto ? count : null
    paint()
    if (auto) ticking = player.interval(tick, 1000)
    bus.emit('episode:next-card', { seconds: remaining })
    return true
  }

  const check = () => {
    const wanted = shouldShow({
      currentTime: video.currentTime,
      duration: video.duration,
      hasNext: Boolean(state.get().episode.next),
      dismissed
    })
    if (wanted) show(); else hide()
  }

  player.listen(video, 'timeupdate', check)
  // A VISSZATEKERÉS eltünteti, és a megszakítást is visszavonja: aki
  // visszament a stáblista elé, annak a kártya megint felajánlható.
  player.listen(video, 'seeked', () => {
    if (video.duration && video.currentTime < video.duration - SHOW_BEFORE_END_SEC) dismissed = false
    check()
  })
  // Az új rész új kártya. A `dismissed` nem maradhat igaz a következő részre.
  player.own(bus.on('episode:next', () => { dismissed = false; hide() }))

  return {
    node,
    show,
    hide,
    dismiss,
    shouldShow,
    get visible () { return visible },
    get remaining () { return remaining },
    get dismissed () { return dismissed }
  }
}
