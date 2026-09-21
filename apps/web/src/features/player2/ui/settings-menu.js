/* global document */
// A beállítások menü.
//
// PANELEKBŐL áll, nem egy hosszú listából: minőség, felirat, hang, sebesség.
// Egyszerre egy látszik, és a fejlécében vissza lehet lépni.
//
// A MENÜ NEM TÁROL ÁLLAPOTOT. Amit mutat, azt az állapotfából olvassa, amit
// választanak, azt a `actions`-nek adja tovább. Ez azért fontos, mert a
// minőség menü közben is változhat — egy forrásváltás átírja a listát —, és
// egy saját másolatot vezető menü ilyenkor nem létező felbontásokat kínálna.

import { formatRate } from './format.js'
import { icon } from './icons.js'
import { RATES } from '../playback/playback-controller.js'

function row (label, value, onClick, selected = false) {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = 'yp-menu-row'
  node.setAttribute('role', 'menuitemradio')
  node.setAttribute('aria-checked', String(selected))
  node.innerHTML =
    `<span class="yp-menu-label">${escape(label)}</span>` +
    (value ? `<span class="yp-menu-value">${escape(value)}</span>` : '') +
    `<span class="yp-menu-tick">${selected ? icon('check', 16) : ''}</span>`
  node.addEventListener('click', onClick)
  return node
}

export function createSettingsMenu (player, actions = {}) {
  const { state } = player

  const node = document.createElement('div')
  node.className = 'yp-menu yp-hidden'
  node.setAttribute('role', 'menu')
  node.setAttribute('aria-label', 'Lejátszó beállításai')

  let panel = 'root'
  let open = false

  const header = document.createElement('div')
  header.className = 'yp-menu-header'
  const backButton = document.createElement('button')
  backButton.type = 'button'
  backButton.className = 'yp-menu-back'
  backButton.innerHTML = `${icon('back', 16)}<span></span>`
  backButton.addEventListener('click', () => show('root'))
  header.append(backButton)

  const body = document.createElement('div')
  body.className = 'yp-menu-body'
  node.append(header, body)

  const PANELS = {
    root: (current) => {
      const items = []
      items.push(row('Minőség', qualityLabel(current), () => show('quality')))
      items.push(row('Felirat', subtitleLabel(current), () => show('subtitles')))
      if (current.audio.tracks.length > 1) {
        items.push(row('Hangsáv', current.audio.current?.label ?? 'Alapértelmezett', () => show('audio')))
      }
      items.push(row('Sebesség', formatRate(current.playback.rate), () => show('rate')))
      return { title: 'Beállítások', items }
    },

    quality: (current) => {
      const items = [row('Automatikus', autoLabel(current), () => choose('quality', 'auto'), current.quality.auto)]
      for (const value of current.quality.available) {
        items.push(row(`${value}p`, '', () => choose('quality', value), !current.quality.auto && current.quality.current === value))
      }
      // ÜRES LISTA SEM MARAD ÜRES. Egy néma, üres panel hibának látszik; egy
      // mondat megmondja, hogy nincs miből választani.
      if (!current.quality.available.length) items.push(note('Ehhez a forráshoz egy minőség tartozik.'))
      return { title: 'Minőség', items }
    },

    subtitles: (current) => {
      const items = [row('Kikapcsolva', '', () => choose('subtitle', null), !current.subtitles.enabled)]
      for (const track of current.subtitles.tracks) {
        const label = track.label ?? track.language ?? 'Ismeretlen'
        items.push(row(label, track.forced ? 'kényszerített' : '', () => choose('subtitle', track),
          current.subtitles.enabled && current.subtitles.current?.id === track.id))
      }
      if (!current.subtitles.tracks.length) items.push(note('Ehhez a részhez nincs feltöltött felirat.'))
      else items.push(row('Felirat megjelenése…', '', () => actions.openSubtitleStyle?.()))
      return { title: 'Felirat', items }
    },

    audio: (current) => ({
      title: 'Hangsáv',
      items: current.audio.tracks.map(track =>
        row(track.label ?? track.language ?? 'Ismeretlen', '', () => choose('audio', track),
          current.audio.current?.id === track.id))
    }),

    rate: (current) => ({
      title: 'Sebesség',
      items: RATES.map(value =>
        row(value === 1 ? 'Normál' : formatRate(value), '', () => choose('rate', value), current.playback.rate === value))
    })
  }

  function note (text) {
    const element = document.createElement('p')
    element.className = 'yp-menu-note'
    element.textContent = text
    return element
  }

  function qualityLabel (current) {
    if (current.quality.auto) return autoLabel(current)
    return current.quality.current ? `${current.quality.current}p` : 'Automatikus'
  }

  function autoLabel (current) {
    // Az „Automatikus" önmagában nem mond semmit. Ami érdekli a nézőt, az az,
    // hogy MOST MI MEGY — és ha ez nem látszik, a következő kérdés az, hogy
    // „miért ilyen homályos".
    const active = current.quality.current
    return active && active !== 'auto' ? `Automatikus (${active}p)` : 'Automatikus'
  }

  function subtitleLabel (current) {
    if (!current.subtitles.enabled) return 'Kikapcsolva'
    return current.subtitles.current?.label ?? current.subtitles.current?.language ?? 'Bekapcsolva'
  }

  function choose (what, value) {
    actions[`select${what[0].toUpperCase()}${what.slice(1)}`]?.(value)
    show('root')
  }

  function show (which) {
    panel = which
    render(state.get())
    // A fókusz a PANEL ELSŐ ELEMÉRE. Enélkül a billentyűzettel navigáló néző
    // fókusza a menü mögött marad, és a nyilak a lapot görgetik.
    body.querySelector('button')?.focus()
  }

  function render (current) {
    if (!open) return
    const build = PANELS[panel] ?? PANELS.root
    const { title, items } = build(current)
    backButton.querySelector('span').textContent = title
    backButton.style.visibility = panel === 'root' ? 'hidden' : ''
    backButton.setAttribute('aria-label', panel === 'root' ? title : `Vissza — ${title}`)
    body.replaceChildren(...items)
  }

  player.own(state.subscribe(render))

  return {
    node,
    get open () { return open },
    toggle (which = 'root') { return open ? this.close() : this.show(which) },
    show (which = 'root') {
      open = true
      panel = which
      node.classList.remove('yp-hidden')
      render(state.get())
      body.querySelector('button')?.focus()
      return true
    },
    close () {
      if (!open) return false
      open = false
      node.classList.add('yp-hidden')
      panel = 'root'
      return false
    }
  }
}

function escape (value) {
  return String(value ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}
