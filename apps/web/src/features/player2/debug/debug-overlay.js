/* global document, performance */
// Fejlesztői réteg.
//
// KAPCSOLÓ MÖGÖTT, és éles nézőnek nem jelenik meg. Nem azért, mert titok,
// hanem mert egy videó fölé írt húsz sornyi szám nem tájékoztatás, hanem
// zavarás.
//
// Amit mutat, azt a HIBAKERESÉS VALÓDI KÉRDÉSEIBŐL válogattuk össze: melyik
// forrásból megy, mennyi van pufferelve, hány képkocka esett ki, mennyi volt
// az indulás. Ezekre eddig csak egy képernyőkép és egy találgatás volt a
// válasz.

import { formatTime } from '../ui/format.js'

/** Ilyen sűrűn frissül. Fél másodperc: olvasható, és nem terhel. */
export const REFRESH_MS = 500

const NETWORK_STATE = ['üres', 'tétlen', 'tölt', 'nincs forrás']
const READY_STATE = ['nincs adat', 'metaadat', 'aktuális', 'jövőbeli', 'elég']

export function createDebugOverlay (player, options = {}) {
  const { video, state, bus } = player
  const clock = options.now ?? (() => performance.now())

  const node = document.createElement('div')
  node.className = 'yp-debug yp-hidden'
  // A fejlesztői réteg NEM tartozik a felolvasóra: számok, amiket
  // másodpercenként kétszer átírunk, és egy felolvasó ettől
  // használhatatlanná válna.
  node.setAttribute('aria-hidden', 'true')

  let visible = false
  let startedAt = null
  let firstFrameMs = null
  let bufferCount = 0
  let fallbackCount = 0
  const recent = []

  // Az indulás pillanata az ELSŐ forrásválasztás, nem a modul létrejötte: a
  // kettő közé beleeshet egy hálózati kérés, és az nem a lejátszó ideje.
  player.own(bus.on('source:selected', () => { startedAt ??= clock() }))
  player.own(bus.on('source:failed', () => { fallbackCount++ }))
  player.own(bus.on('buffer:start', () => { bufferCount++ }))
  player.listen(video, 'loadeddata', () => {
    firstFrameMs ??= startedAt === null ? null : Math.round(clock() - startedAt)
  })

  // AZ ESEMÉNYNAPLÓ az utolsó nyolc esemény. Több nem fér ki, és nem is kell:
  // ami régebbi, az már nem erről a hibáról szól.
  for (const event of ['source:selected', 'source:failed', 'source:switched', 'quality:changed',
    'subtitle:changed', 'buffer:start', 'buffer:end', 'player:error']) {
    player.own(bus.on(event, () => {
      recent.unshift(`${new Date().toISOString().slice(11, 19)} ${event}`)
      if (recent.length > 8) recent.length = 8
    }))
  }

  const buffered = () => {
    const ranges = video.buffered
    if (!ranges?.length) return '0'
    const at = video.currentTime
    for (let i = 0; i < ranges.length; i++) {
      if (at >= ranges.start(i) && at <= ranges.end(i)) return `${(ranges.end(i) - at).toFixed(1)} mp`
    }
    return 'nincs itt'
  }

  const quality = () => {
    // A `getVideoPlaybackQuality` az EGYETLEN forrása a kiesett képkockáknak.
    // Enélkül az „akadozik" panaszra csak találgatás van.
    const stats = video.getVideoPlaybackQuality?.()
    if (!stats) return '—'
    return `${stats.droppedVideoFrames} / ${stats.totalVideoFrames}`
  }

  const rows = () => {
    const current = state.get()
    return [
      ['állapot', current.status],
      ['fázis', current.ui.loadingPhase],
      ['forrás', current.source.current?.label ?? current.source.current?.id ?? '—'],
      ['forrástípus', current.source.type ?? '—'],
      ['minőség', current.quality.auto ? `auto (${current.quality.current})` : current.quality.current],
      ['méret', `${video.videoWidth || 0}×${video.videoHeight || 0}`],
      ['idő', `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`],
      ['puffer előre', buffered()],
      ['hálózat', NETWORK_STATE[video.networkState] ?? video.networkState],
      ['készültség', READY_STATE[video.readyState] ?? video.readyState],
      ['kiesett képkocka', quality()],
      ['sebesség', `${video.playbackRate}×`],
      ['indulás → első kép', firstFrameMs === null ? '—' : `${firstFrameMs} ms`],
      ['pufferelés', String(bufferCount)],
      ['forrásváltás', String(fallbackCount)],
      ['hiba', current.error?.code ?? current.error?.message ?? '—']
    ]
  }

  const render = () => {
    if (!visible) return
    node.innerHTML =
      '<table class="yp-debug-table">' +
      rows().map(([key, value]) => `<tr><th>${escape(key)}</th><td>${escape(String(value))}</td></tr>`).join('') +
      '</table>' +
      `<pre class="yp-debug-log">${escape(recent.join('\n'))}</pre>`
  }

  player.interval(render, REFRESH_MS)

  return {
    node,
    rows,
    show () { visible = true; node.classList.remove('yp-hidden'); render(); return true },
    hide () { visible = false; node.classList.add('yp-hidden'); return false },
    toggle () { return visible ? this.hide() : this.show() },
    get visible () { return visible },
    /** A mért indulási idő — a telemetria is ezt küldi. */
    get metrics () { return { firstFrameMs, bufferCount, fallbackCount } }
  }
}

function escape (value) {
  return String(value ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}
