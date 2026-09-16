/* global document */
// Lebegő kislejátszó.
//
// Nem a böngésző kép a képben módja — az a rendszeré, és nem tudunk bele
// rajzolni. Ez a MI ablakunk: a lapon marad, a mi vezérlőinkkel, és a néző
// közben görgethet, kereshet, olvashatja a hozzászólásokat.
//
// HÚZÁS, ÁTMÉRETEZÉS, BEZÁRÁS, VISSZAÁLLÍTÁS. A nehéz része egyik sem a
// mozgatás, hanem az, hogy az ablak NE TUDJON ELVESZNI: egy képernyőn kívülre
// húzott kislejátszót nem lehet visszahozni, és a néző csak annyit lát, hogy
// szól valami, amit nem talál.

/** Ennyi képpontnyi rész mindig a képernyőn belül marad. */
export const KEEP_VISIBLE_PX = 80
export const MIN_WIDTH = 220
export const MAX_WIDTH = 640

/**
 * Egy pozíció a képernyőn belülre szorítva.
 *
 * Külön függvény, mert ez a modul egyetlen szabálya, amit érdemes
 * megmérni — a többi DOM-mozgatás.
 */
export function clampPosition ({ left, top, width, height }, viewport) {
  const maxLeft = viewport.width - KEEP_VISIBLE_PX
  const maxTop = viewport.height - KEEP_VISIBLE_PX
  return {
    left: Math.max(KEEP_VISIBLE_PX - width, Math.min(maxLeft, left)),
    top: Math.max(0, Math.min(maxTop, top))
  }
}

/** Egy szélesség a megengedett tartományba szorítva, a képernyőt is figyelembe véve. */
export function clampWidth (width, viewportWidth) {
  const ceiling = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, viewportWidth - 2 * KEEP_VISIBLE_PX))
  return Math.max(MIN_WIDTH, Math.min(ceiling, Math.round(width)))
}

/**
 * @param {object} player
 * @param {HTMLElement} shell a lejátszó héja
 * @param {object} options `prefs`, `onClose`, `viewport`
 */
export function createMiniPlayer (player, shell, options = {}) {
  const { state } = player
  const prefs = options.prefs ?? { get: () => undefined, set: () => {} }
  const viewport = options.viewport ?? (() => ({
    width: globalThis.innerWidth ?? 1280,
    height: globalThis.innerHeight ?? 720
  }))

  let active = false
  let placeholder = null
  let origin = null

  const bar = document.createElement('div')
  bar.className = 'yp-mini-bar'
  bar.innerHTML = '<span class="yp-mini-grip" aria-hidden="true"></span>'

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'yp-mini-close'
  close.setAttribute('aria-label', 'Kislejátszó bezárása')
  close.textContent = '×'
  close.addEventListener('click', () => { exit(); options.onClose?.() })
  bar.append(close)

  const grip = document.createElement('div')
  grip.className = 'yp-mini-resize'
  grip.setAttribute('aria-hidden', 'true')

  const place = (left, top, width) => {
    const box = shell.getBoundingClientRect()
    const clamped = clampPosition({ left, top, width, height: box.height }, viewport())
    shell.style.left = `${clamped.left}px`
    shell.style.top = `${clamped.top}px`
    if (width) shell.style.width = `${width}px`
    return clamped
  }

  /** Húzás — a fejlécnél fogva. */
  let drag = null
  player.listen(bar, 'pointerdown', (event) => {
    if (event.target === close) return
    const box = shell.getBoundingClientRect()
    drag = { dx: event.clientX - box.left, dy: event.clientY - box.top }
    bar.setPointerCapture?.(event.pointerId)
  })
  const scope = shell.ownerDocument ?? globalThis.document
  player.listen(scope, 'pointermove', (event) => {
    if (!drag || !active) return
    place(event.clientX - drag.dx, event.clientY - drag.dy, shell.getBoundingClientRect().width)
  })
  player.listen(scope, 'pointerup', () => {
    if (!drag) return
    drag = null
    remember()
  })

  /** Átméretezés — a bal alsó sarokból, mert az ablak jobbra-lent ül. */
  let resize = null
  player.listen(grip, 'pointerdown', (event) => {
    const box = shell.getBoundingClientRect()
    resize = { startX: event.clientX, width: box.width, right: box.right }
    grip.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  })
  player.listen(scope, 'pointermove', (event) => {
    if (!resize || !active) return
    const width = clampWidth(resize.width + (resize.startX - event.clientX), viewport().width)
    shell.style.width = `${width}px`
    // A jobb széle marad a helyén: így az ablak nem „mászik el" méretezés
    // közben, ami a legbosszantóbb apró hiba az ilyen felületeken.
    shell.style.left = `${resize.right - width}px`
  })
  player.listen(scope, 'pointerup', () => {
    if (!resize) return
    resize = null
    remember()
  })

  // Az ABLAK ÁTMÉRETEZÉSE visszahúzhatja a képernyőre. Enélkül egy nagyobb
  // ablakból kicsibe váltva a kislejátszó kívül rekedne.
  //
  // Az ablakot a DOKUMENTUMTÓL kérjük, nem a `globalThis`-től: a lejátszó
  // magja böngésző nélkül is fut (a tesztek így futtatják), és ott a
  // `globalThis`-nek nincs `addEventListener`-e. A `?.` nem elég — a hiányzó
  // metódus nem `undefined` tulajdonság, hanem hiányzó függvény.
  const win = shell.ownerDocument?.defaultView ?? (typeof globalThis.addEventListener === 'function' ? globalThis : null)
  if (win) {
    player.listen(win, 'resize', () => {
      if (!active) return
      const box = shell.getBoundingClientRect()
      place(box.left, box.top, clampWidth(box.width, viewport().width))
    })
  }

  const remember = () => {
    const box = shell.getBoundingClientRect()
    prefs.set?.('player.ui.miniPlayer', true)
    origin && (origin.mini = { left: box.left, top: box.top, width: box.width })
  }

  function enter () {
    if (active) return false
    const box = shell.getBoundingClientRect()
    // HELYŐRZŐ a régi helyén: enélkül a lap tartalma felugrik, amikor a
    // lejátszó kikerül a folyamból, és a néző elveszíti, hol tartott.
    placeholder = document.createElement('div')
    placeholder.className = 'yp-mini-placeholder'
    placeholder.style.height = `${box.height}px`
    shell.parentElement?.insertBefore(placeholder, shell)
    origin = { parent: shell.parentElement, width: shell.style.width, left: shell.style.left, top: shell.style.top }

    shell.classList.add('yp-mini')
    shell.prepend(bar)
    shell.append(grip)
    active = true
    state.patch({ ui: { miniPlayer: true } })

    const view = viewport()
    const width = clampWidth(360, view.width)
    place(view.width - width - 24, view.height - (width * 9 / 16) - 24, width)
    return true
  }

  function exit () {
    if (!active) return false
    shell.classList.remove('yp-mini')
    bar.remove()
    grip.remove()
    shell.style.width = origin?.width ?? ''
    shell.style.left = origin?.left ?? ''
    shell.style.top = origin?.top ?? ''
    placeholder?.remove()
    placeholder = null
    active = false
    state.patch({ ui: { miniPlayer: false } })
    return true
  }

  player.own(() => { if (active) exit() })

  return {
    enter,
    exit,
    toggle () { return active ? exit() : enter() },
    get active () { return active }
  }
}
