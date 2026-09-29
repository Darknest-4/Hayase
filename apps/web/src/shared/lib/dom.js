/* global document, getComputedStyle, DOMParser */
// Small DOM + formatting helpers shared by every page.

// T() — the single text lookup — is defined in apps/web/js/i18n.js, which loads
// after this file. It kept the copy-catalog behaviour that used to live here
// and added translation on top: a dotted key still resolves through
// web/copy.js, and the English string it produces is then translated.
// Nothing calls T() at load time, only while rendering, so the later
// definition is in place long before the first call.

import { I18n } from '../i18n/i18n.js'
import { inertHTML, trustedHTML } from './trusted.js'

export const U = {
  // createElement helper: U.el('div', { class: 'foo', onclick: fn }, [children...])
  el (tag, attrs = {}, children = []) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null) continue
      if (key === 'class') node.className = value
      else if (key === 'text') node.textContent = value
      // Csak SAJÁT, statikus sablon — lásd trusted.js. Külső adat ide nem jöhet.
      else if (key === 'html') node.innerHTML = trustedHTML(value)
      else if (key === 'style') node.style.cssText = value
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value)
      else if (key === 'dataset') Object.assign(node.dataset, value)
      // A boolean attribute is "on" when it is PRESENT, whatever its value —
      // setAttribute('selected', false) renders selected="false" and the
      // browser reads that as selected. Passing a boolean therefore did the
      // opposite of what it looks like, which is why call sites across the
      // client spell it `...(cond ? { checked: '' } : {})` instead. Handling
      // it here makes the obvious form correct and leaves that spelling
      // working.
      else if (typeof value === 'boolean') { if (value) node.setAttribute(key, '') } else node.setAttribute(key, value)
    }
    for (const child of [].concat(children)) {
      if (child == null) continue
      node.append(child)
    }
    return node
  },

  svg (paths, size = 16) {
    const wrap = document.createElement('span')
    wrap.innerHTML = trustedHTML(`<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`)
    return wrap.firstChild
  },

  /**
   * Any CSS colour → #rrggbb, for an <input type="color">.
   *
   * The picker takes hex and nothing else, while a theme's accent may be an
   * hsl() or a named colour. Rather than parse CSS, this asks the browser: set
   * the value on a detached element and read back what it computed. Returns
   * null when the browser makes nothing of it, and the caller falls back — a
   * picker showing the wrong colour is worse than one showing a default.
   */
  toHex (value) {
    if (!value || typeof value !== 'string') return null
    if (/^#[0-9a-f]{6}$/i.test(value.trim())) return value.trim()
    try {
      const probe = document.createElement('span')
      probe.style.color = value
      document.body.append(probe)
      const rgb = getComputedStyle(probe).color
      probe.remove()
      const parts = rgb.match(/\d+/g)
      if (!parts) return null
      return '#' + parts.slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('')
    } catch (e) {
      return null
    }
  },

  title (media) {
    return media?.title?.userPreferred ?? media?.title?.english ?? media?.title?.romaji ?? media?.title?.native ?? 'Unknown'
  },

  /**
   * A leírás szövege, HTML nélkül.
   *
   * Ez egy `div.innerHTML = leiras` volt, aztán `textContent`. Leváló elem,
   * tehát ártalmatlannak látszott — nem az. Egy leváló elembe illesztett
   * `<img src=x onerror=…>` mindhárom motorban lefut (Chromium, WebKit,
   * Firefox egyaránt: megmértem), mert a kép betöltése nem a dokumentumhoz
   * kötődik, hanem az elem létrejöttéhez.
   *
   * A leírás pedig nem a miénk: az importból jön, és az adminfelületen
   * szerkeszthető. Vagyis egy katalógusmező tartalma minden látogató
   * böngészőjében futott volna — a főoldali kiemelésen, az adatlapon és a
   * gyorsnézeten.
   *
   * A `DOMParser` inert dokumentumot ad: nincs böngészési kontextusa, tehát
   * nem tölt be képet és nem futtat semmit. A `<br>` sortörésre cserélése
   * előbb történik, mert a szövegben az a jelentése.
   */
  plainDesc (html) {
    const source = String(html ?? '').replaceAll('<br>', '\n').replaceAll('<br/>', '\n').replaceAll('<br />', '\n')
    try {
      // Inert elemzés: külső szöveg, de a dokumentuma nem tölt be és nem futtat
      // semmit, és csak a textContent-jét olvassuk (trusted.js, `yume-inert`).
      const doc = new DOMParser().parseFromString(inertHTML(source), 'text/html')
      // A script és a style *tartalma* is szöveg a textContent szemében. Nem
      // veszélyes — a dokumentum inert —, de egy leírásban a forráskódja
      // ugyanúgy nem olvasmány, mint a címkéi.
      for (const node of doc.body.querySelectorAll('script, style, noscript, template')) node.remove()
      return doc.body.textContent ?? ''
    } catch (error) {
      // Nincs DOMParser (teszt-DOM): a nyers szöveg jobb, mint egy kivétel —
      // és mindenképp jobb, mint az innerHTML.
      return source
        .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<[^>]*>/g, '')
    }
  },

  formatMap: {
    TV: 'TV',
    TV_SHORT: 'TV Short',
    MOVIE: 'Movie',
    SPECIAL: 'Special',
    OVA: 'OVA',
    ONA: 'ONA',
    MUSIC: 'Music'
  },

  statusMap: {
    RELEASING: 'Airing',
    FINISHED: 'Finished',
    NOT_YET_RELEASED: 'Not yet aired',
    CANCELLED: 'Cancelled',
    HIATUS: 'Hiatus'
  },

  listStatusMap: {
    CURRENT: 'Watching',
    PLANNING: 'Planning',
    COMPLETED: 'Completed',
    PAUSED: 'Paused',
    DROPPED: 'Dropped',
    REPEATING: 'Rewatching'
  },

  seasonMap: { WINTER: 'Winter', SPRING: 'Spring', SUMMER: 'Summer', FALL: 'Fall' },

  // Ezek a térképek angolul tartják a kanonikus szöveget, a megjelenítés
  // pedig lefordítja. Eddig nem fordították le sehol: a kártyák és a hero
  // „Movie · Fall 2024 · Finished"-et írtak ki magyar felületen is.
  format (media) {
    const label = this.formatMap[media?.format] ?? media?.format ?? ''
    return label ? I18n.t(label) : ''
  },

  status (media) {
    const label = this.statusMap[media?.status] ?? ''
    return label ? I18n.t(label) : ''
  },

  seasonYear (media) {
    if (!media?.season || !media?.seasonYear) return media?.startDate?.year ?? ''
    return `${I18n.t(this.seasonMap[media.season])} ${media.seasonYear}`
  },

  episodeCount (media) {
    return media?.episodes ?? (media?.nextAiringEpisode ? `${media.nextAiringEpisode.episode - 1}+` : '?')
  },

  /**
   * Az átlagpontszám egész százalékban, vagy `null`.
   *
   * A katalógus `numeric` oszlopból adja, tehát szövegként ("51.0"), az AniList
   * számként (51). Kiírva ez „51.0%" és „51%" volt ugyanazon a lapon.
   */
  score (media) {
    const n = Number(media?.averageScore)
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null
  },

  cover (media) {
    return media?.coverImage?.extraLarge ?? media?.coverImage?.large ?? ''
  },

  currentSeason (date = new Date()) {
    const seasons = ['WINTER', 'WINTER', 'SPRING', 'SPRING', 'SPRING', 'SUMMER', 'SUMMER', 'SUMMER', 'FALL', 'FALL', 'FALL', 'WINTER']
    const month = date.getMonth()
    const season = seasons[month]
    // december belongs to next year's winter season
    const year = month === 11 && season === 'WINTER' ? date.getFullYear() + 1 : date.getFullYear()
    return { season, year }
  },

  /**
   * „3 napja", „2 óra múlva" — a néző nyelvén.
   *
   * Kézzel írt angol volt („3 days ago"), és tíz helyen jelent meg: a
   * hozzászólásokon, a fórumon, az értesítéseken, az adásrendi jelvényen és az
   * admin hibalistáin. A magyar nem is ragozható úgy, ahogy ez a függvény
   * csinálta — az Intl viszont tudja, és minden nyelven tudja.
   *
   * Az Intl.RelativeTimeFormat mindenhol elérhető, ahol ez a kliens fut; a
   * védőág egy régi WebView kedvéért van, és az angolra esik vissza, nem egy
   * hibára.
   */
  relTime (date) {
    const diff = +date - Date.now()
    const abs = Math.abs(diff)
    const units = [[86400000 * 7, 'week'], [86400000, 'day'], [3600000, 'hour'], [60000, 'minute']]

    let format
    try {
      format = new Intl.RelativeTimeFormat(I18n.locale(), { numeric: 'auto' })
    } catch (error) {
      format = null
    }

    for (const [ms, name] of units) {
      if (abs >= ms) {
        const val = Math.round(abs / ms)
        if (format) return format.format(diff > 0 ? val : -val, name)
        return diff > 0 ? `in ${val} ${name}${val > 1 ? 's' : ''}` : `${val} ${name}${val > 1 ? 's' : ''} ago`
      }
    }
    // Egy percen belül: az Intl „ebben a percben"-t adna, ami pontos, de nem
    // az, amit az ember mond.
    return I18n.t(diff > 0 ? 'soon' : 'just now')
  },

  airDate (str) {
    if (!str) return ''
    const date = new Date(str)
    if (isNaN(+date)) return str
    return date.toLocaleDateString(I18n.locale(), { year: 'numeric', month: 'short', day: 'numeric' })
  },

  fmtTime (s) {
    if (!isFinite(s)) return '0:00'
    const h = Math.floor(s / 3600); const m = Math.floor(s % 3600 / 60); const sec = Math.floor(s % 60)
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0')
  },

  debounce (fn, ms = 350) {
    let timer
    return (...args) => {
      clearTimeout(timer)
      timer = setTimeout(() => fn(...args), ms)
    }
  },

  /**
   * Egy vízszintesen görgethető fülsor (`.tabs`) aktív fülét a látómezőbe
   * görgeti, amint a sor a lapra került.
   *
   * Telefonon a profil négy füle nem fér ki egy sorba. A `?tab=history` címmel
   * nyitott lapon az aktív fül a jobb szél mögött állt, és semmi nem mutatta,
   * melyik fülön van a néző. Kattintásra és nyílbillentyűre ez magától
   * megtörténik (a fókusz görget); ez a cím szerinti — programozott —
   * kiválasztásra kell.
   *
   * Ugyanitt kapja meg a sor a széljelzést is (`tabsEdges`): a kilógó fül
   * addig félbevágott szövegnek látszott („Kia…"), nem görgethető sornak.
   *
   * @param {HTMLElement} bar
   */
  revealActiveTab (bar, tries = 10) {
    const later = globalThis.requestAnimationFrame ?? (fn => setTimeout(fn, 16))
    const run = () => {
      if (!bar?.isConnected) { if (--tries > 0) later(run); return }
      U.tabsEdges(bar)
      const active = bar.querySelector('.active, [aria-selected="true"], [aria-current="page"]')
      if (!active || !(bar.scrollWidth > bar.clientWidth)) return
      const box = bar.getBoundingClientRect()
      const tab = active.getBoundingClientRect()
      if (tab.left >= box.left && tab.right <= box.right) return
      // Középre, hogy a szomszédai is látsszanak: azokból derül ki, hogy a
      // sor görgethető.
      bar.scrollLeft += (tab.left - box.left) - (box.width - tab.width) / 2
    }
    later(run)
  },

  /**
   * A görgethető fülsor azon széle halványul el, amerre még van fül
   * (`tabs-more-start` / `tabs-more-end`, a components.css-ben). Görgetésre és
   * átméretezésre frissül; ha minden fül kifér, egyik osztály sincs rajta.
   * Soronként egyszer köt be.
   *
   * @param {HTMLElement} bar
   */
  tabsEdges (bar) {
    if (!bar || bar.dataset.edges) return
    bar.dataset.edges = '1'
    const update = () => {
      const max = bar.scrollWidth - bar.clientWidth
      bar.classList.toggle('tabs-more-start', max > 1 && bar.scrollLeft > 1)
      bar.classList.toggle('tabs-more-end', max > 1 && bar.scrollLeft < max - 1)
    }
    bar.addEventListener('scroll', update, { passive: true })
    if (globalThis.ResizeObserver) new globalThis.ResizeObserver(update).observe(bar)
    update()
  },

  /**
   * Egy rövid visszajelzés a képernyő alján.
   *
   * A `#toasts` élő régió (index.html): a képernyőolvasó felolvassa. A hiba
   * `role="alert"`-et kap, hogy ne várjon a sorára. Hosszabb szöveg tovább
   * marad — senki nem olvas el két mondatot három és fél másodperc alatt.
   */
  toast (message, type = '', { action = null } = {}) {
    const host = document.getElementById('toasts')
    if (!host) return
    const node = U.el('div', { class: `toast ${type}`.trim(), ...(type === 'error' ? { role: 'alert' } : {}) }, [
      U.el('span', { class: 'toast-text', text: message })
    ])
    const leave = () => {
      node.classList.add('leaving')
      setTimeout(() => node.remove(), 300)
    }
    // Egy visszavonható művelet (egy törlés) gombja a toasban — tovább marad,
    // hogy legyen idő megnyomni.
    if (action?.label && typeof action.onClick === 'function') {
      node.append(U.el('button', {
        class: 'toast-action',
        type: 'button',
        text: action.label,
        onclick: () => { action.onClick(); leave() }
      }))
    }
    host.append(node)
    // Egyszerre legfeljebb három: a negyedik a legrégebbit viszi.
    while (host.children.length > 3) host.firstElementChild.remove()
    const stay = Math.min(action ? 10000 : 8000, (action ? 6000 : 3000) + String(message ?? '').length * 40)
    setTimeout(leave, stay)
  },

  setBanner (url) {
    const banner = document.getElementById('global-banner')
    if (url) {
      banner.style.backgroundImage = `url("${url}")`
      banner.classList.add('visible')
    } else {
      banner.classList.remove('visible')
    }
  }
}
