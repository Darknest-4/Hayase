/* global document */
// A betöltőképernyő.
//
// Az anime saját logója áll a közepén, feketén-fehéren, és balról jobbra
// végigfut rajta a szín — újra és újra, amíg a kép el nem indul. Ha az adott
// címhez nincs logó, a YUME felirat ugyanezt csinálja.
//
// KÉT DOLOG, AMI NEM MAGÁTÓL ÉRTETŐDŐ:
//
//   * a LEGRÖVIDEBB IDŐ. Egy 200 ezredmásodpercre felvillanó, majd eltűnő
//     logó rosszabb, mint a semmi — villanásnak látszik, nem betöltésnek.
//     Ezért a betöltő legalább egy másodpercig kint marad, akkor is, ha a
//     videó hamarabb kész;
//   * a FÁZIS SZÖVEGE. „Betöltés" alatt a néző nem tudja, tart-e még vagy
//     elakadt. A forrás neve és a fázis megmondja, és a hibakeresést is ez
//     teszi lehetővé egy képernyőképből.

import { LOADING_PHASE } from '../core/player-state.js'

/** Ennyi ideig mindenképp látszik. */
export const MIN_VISIBLE_MS = 1000

const PHASE_TEXT = {
  INITIALIZING: 'Indulás',
  LOADING_SOURCE: 'Forrás betöltése',
  LOADING_METADATA: 'Adatok beolvasása',
  BUFFERING: 'Pufferelés',
  SWITCHING_SOURCE: 'Váltás másik forrásra',
  READY: 'Kész'
}

/**
 * @param {object} player
 * @param {object} options `logoSrc`, `title`, `now`
 * @returns {{node: HTMLElement, destroy: function}}
 */
export function createLoadingOverlay (player, options = {}) {
  const { state, bus } = player
  const now = options.now ?? (() => Date.now())
  const shownAt = now()

  const node = document.createElement('div')
  node.className = 'yp-loader'
  // A felolvasó számára ez egy ÁLLAPOTKÖZLÉS, nem dísz: a `status` szerep
  // magától felolvassa a változást, anélkül, hogy elvenné a fókuszt.
  node.setAttribute('role', 'status')
  node.setAttribute('aria-live', 'polite')

  const art = options.logoSrc
    ? `<img class="yp-loader-art" src="${escapeAttr(options.logoSrc)}" alt="" decoding="async">`
    : `<div class="yp-loader-art yp-loader-wordmark">${escapeText(options.title || 'YUME')}</div>`

  // A logó KÉTSZER van meg: alul a szürke alapréteg, fölötte ugyanaz színesen,
  // egy balról jobbra mozgó maszkkal. A szín így „végigfut" rajta. Egyetlen
  // elemen ez nem megoldható — a szürkeárnyalatos szűrő az egész elemre hat,
  // részlegesen nem.
  node.innerHTML =
    `<div class="yp-loader-brand">
       <div class="yp-loader-base">${art}</div>
       <div class="yp-loader-sweep">${art}</div>
     </div>
     <p class="yp-loader-phase"></p>`

  const phaseNode = node.querySelector('.yp-loader-phase')

  const render = (current) => {
    // A HIBA MINDENT VISZ. Az `EV.ERROR` eseményre is figyelünk, de a
    // forráskimerülés az ÁLLAPOTBA ír hibát esemény nélkül — és akkor a
    // betöltő ott maradt a hibaüzenet fölött, ahol egyik réteg sem olvasható.
    // Az állapot a megbízhatóbb jel: ami látszik, az onnan jön.
    if (current.error) { node.classList.add('yp-hidden'); return }

    const phase = current.ui.loadingPhase
    const done = phase === LOADING_PHASE.READY
    const source = current.source.current?.label ?? current.source.current?.name ?? null

    if (done) {
      // A maradék legrövidebb időt kivárjuk. `player.timer`, nem nyers
      // `setTimeout`: a lejátszó szétbontásakor ez is elszáll, és nem nyúl
      // egy már eldobott elemhez.
      const waited = now() - shownAt
      player.timer(() => node.classList.add('yp-hidden'), Math.max(0, MIN_VISIBLE_MS - waited))
      return
    }

    node.classList.remove('yp-hidden')
    const text = PHASE_TEXT[phase] ?? 'Betöltés'
    phaseNode.textContent = source ? `${text} — ${source}` : text
  }

  render(state.get())
  const stop = state.subscribe(render)
  player.own(stop)

  // A hibánál a betöltő ELTŰNIK. A hibaüzenet a saját rétegében jelenik meg, és
  // két egymásra rajzolt réteg közül egyik sem olvasható.
  player.own(bus.on('player:error', () => node.classList.add('yp-hidden')))

  return { node, destroy: stop }
}

function escapeAttr (value) {
  return String(value).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

const escapeText = escapeAttr
