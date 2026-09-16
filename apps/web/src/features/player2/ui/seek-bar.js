/* global document */
// A tekerősáv.
//
// Saját modul, mert ez a lejátszó legbonyolultabb egyetlen eleme, és a
// bonyolultsága nem a kirajzolásban van, hanem abban, hogy MI TÖRTÉNIK FOGÁS
// KÖZBEN:
//
//   * a `timeupdate` fogás közben is jön, és ha az rajzolja a fejet, az ujj
//     alól ugrál el a sáv. Fogás alatt a beérkező idő NEM rajzol;
//   * az ujj kimehet a sávról — az eseményt az ABLAKRA kell kötni, nem az
//     elemre, különben a fogás félúton „elengedődik";
//   * a tényleges tekerés az ELENGEDÉSKOR történik, nem közben. Húzás közben
//     tucatnyi `currentTime` írás tucatnyi hálózati kérést jelent.
//
// Billentyűzetről is használható: a `role="slider"` és a nyilak nélkül a sáv
// egérrel kötelező, és ez a hozzáférhetőség első számú bukása a lejátszókban.

import { bufferedRanges, formatTime, ratioFromPointer, spokenTime } from './format.js'

export function createSeekBar (player, options = {}) {
  const { video, state } = player
  const onScrubChange = options.onScrubbing ?? (() => {})

  const node = document.createElement('div')
  node.className = 'yp-seek'
  node.setAttribute('role', 'slider')
  node.setAttribute('tabindex', '0')
  node.setAttribute('aria-label', 'Videó pozíciója')
  node.setAttribute('aria-valuemin', '0')
  node.innerHTML =
    `<div class="yp-seek-rail">
       <div class="yp-seek-buffer"></div>
       <div class="yp-seek-played"></div>
       <div class="yp-seek-head"></div>
     </div>
     <div class="yp-seek-tip" hidden></div>`

  const buffer = node.querySelector('.yp-seek-buffer')
  const played = node.querySelector('.yp-seek-played')
  const head = node.querySelector('.yp-seek-head')
  const tip = node.querySelector('.yp-seek-tip')

  let scrubbing = false
  let scrubRatio = 0

  const duration = () => {
    const value = state.get().playback.duration
    return Number.isFinite(value) && value > 0 ? value : 0
  }

  const paint = (ratio) => {
    const percent = `${Math.max(0, Math.min(1, ratio)) * 100}%`
    played.style.width = percent
    head.style.left = percent
  }

  const paintBuffer = () => {
    const total = duration()
    const ranges = bufferedRanges(video.buffered, total)
    // A KÖZÉPSŐ szakasz, amiben éppen vagyunk — nem az összes. Több tekerés
    // után a videó eleje is be van töltve, és azt egy sávként kirajzolni
    // azt mondaná, hogy minden készen áll.
    const at = total ? video.currentTime / total : 0
    const here = ranges.find(range => at >= range.start && at <= range.end) ?? ranges[0]
    buffer.style.width = here ? `${(here.end - here.start) * 100}%` : '0%'
    buffer.style.left = here ? `${here.start * 100}%` : '0%'
  }

  const render = (current) => {
    const total = duration()
    node.setAttribute('aria-valuemax', String(Math.floor(total)))
    // FOGÁS KÖZBEN NEM RAJZOLUNK a beérkező időből: az ujj alól ugrana el.
    if (!scrubbing) {
      paint(total ? current.playback.currentTime / total : 0)
      node.setAttribute('aria-valuenow', String(Math.floor(current.playback.currentTime)))
      node.setAttribute('aria-valuetext', spokenTime(current.playback.currentTime))
    }
    paintBuffer()
  }

  const ratioAt = (clientX) => ratioFromPointer(clientX, node.getBoundingClientRect())

  const showTip = (ratio) => {
    const total = duration()
    if (!total) return
    tip.hidden = false
    tip.textContent = formatTime(ratio * total)
    tip.style.left = `${ratio * 100}%`
  }

  const endScrub = (clientX) => {
    if (!scrubbing) return
    scrubbing = false
    tip.hidden = true
    onScrubChange(false)
    const total = duration()
    if (total) {
      const ratio = clientX === undefined ? scrubRatio : ratioAt(clientX)
      // AZ ELENGEDÉSKOR tekerünk, egyszer. Húzás közben minden mozdulat egy
      // bájttartomány-kérés lenne, és egy másodperc húzás megkérné a fél
      // fájlt.
      video.currentTime = ratio * total
    }
  }

  player.listen(node, 'pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return
    scrubbing = true
    onScrubChange(true)
    scrubRatio = ratioAt(event.clientX)
    paint(scrubRatio)
    showTip(scrubRatio)
    node.setPointerCapture?.(event.pointerId)
  })

  // AZ ABLAKRA kötve, nem az elemre: az ujj vagy az egér kimehet a sávról, és
  // ott is a fogás folytatódik. Elemre kötve a fogás a sáv szélén megszakadt.
  const scope = node.ownerDocument ?? globalThis.document
  player.listen(scope, 'pointermove', (event) => {
    if (!scrubbing) return
    scrubRatio = ratioAt(event.clientX)
    paint(scrubRatio)
    showTip(scrubRatio)
  })
  player.listen(scope, 'pointerup', (event) => endScrub(event.clientX))
  // Az elvesztett fogás (ablakváltás, rendszerpanel) nem hagyhatja a sávot
  // örökre „fogott" állapotban — akkor a kijelző soha nem frissülne újra.
  player.listen(scope, 'pointercancel', () => { scrubbing = false; tip.hidden = true; onScrubChange(false) })

  // Egérrel a sáv fölött: előnézeti idő fogás nélkül is.
  player.listen(node, 'pointerover', () => { if (!scrubbing) tip.hidden = duration() === 0 })
  player.listen(node, 'pointerout', () => { if (!scrubbing) tip.hidden = true })
  player.listen(node, 'pointermove', (event) => { if (!scrubbing && duration()) showTip(ratioAt(event.clientX)) })

  player.listen(node, 'keydown', (event) => {
    const total = duration()
    if (!total) return
    const step = event.shiftKey ? 30 : 5
    const jump = {
      ArrowLeft: -step, ArrowRight: step,
      Home: -Infinity, End: Infinity,
      PageDown: -60, PageUp: 60
    }[event.key]
    if (jump === undefined) return
    event.preventDefault()
    video.currentTime = Math.max(0, Math.min(total, video.currentTime + jump))
  })

  render(state.get())
  player.own(state.subscribe(render))

  return {
    node,
    get scrubbing () { return scrubbing },
    /** A fejezethatárok kirajzolása — intró, outró, fejezetek. */
    setMarkers (markers = []) {
      const total = duration()
      node.querySelectorAll('.yp-seek-marker').forEach(old => old.remove())
      if (!total) return
      for (const marker of markers) {
        if (!Number.isFinite(marker.start) || marker.start <= 0 || marker.start >= total) continue
        const dot = document.createElement('span')
        dot.className = `yp-seek-marker yp-seek-marker-${marker.kind ?? 'chapter'}`
        dot.style.left = `${(marker.start / total) * 100}%`
        dot.title = marker.label ?? ''
        node.querySelector('.yp-seek-rail').append(dot)
      }
    }
  }
}
