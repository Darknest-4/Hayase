/* global document */
// Egy anime előzetese, modálban — a YouTube adatvédelmi (nocookie) címéről,
// csak kattintásra. A főoldal kiemelése és az adatlap nyitja; 2026-09-ig a
// közös komponensek része volt, tehát minden oldal letöltötte.

import { T } from '../../shared/i18n/i18n.js'
import { U } from '../../shared/lib/dom.js'
import { loadStylesheet } from '../../shared/lib/stylesheet.js'

export async function openTrailer (trailer) {
  if (!trailer?.id || trailer.site !== 'youtube') {
    U.toast(T('No trailer available'), 'error')
    return
  }
  // Az ablak stíluslapja csak akkor jön le, amikor valaki tényleg megnyitja.
  await loadStylesheet('features/trailer.css')
  const backdrop = U.el('div', {
    class: 'modal-backdrop',
    onclick: e => { if (e.target === backdrop) close() }
  }, [
    U.el('div', { class: 'trailer-modal' }, [
      U.el('iframe', {
        src: `https://www.youtube-nocookie.com/embed/${trailer.id}?autoplay=1`,
        title: T('Trailer'),
        allow: 'autoplay; fullscreen',
        allowfullscreen: ''
      })
    ])
  ])
  const close = () => {
    backdrop.remove()
    document.removeEventListener('keydown', esc)
  }
  const esc = e => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', esc)
  document.body.append(backdrop)
}
