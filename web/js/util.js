/* global window, document */
// Small DOM + formatting helpers shared by every page.

const U = {
  // createElement helper: U.el('div', { class: 'foo', onclick: fn }, [children...])
  el (tag, attrs = {}, children = []) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null) continue
      if (key === 'class') node.className = value
      else if (key === 'text') node.textContent = value
      else if (key === 'html') node.innerHTML = value
      else if (key === 'style') node.style.cssText = value
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value)
      else if (key === 'dataset') Object.assign(node.dataset, value)
      else node.setAttribute(key, value)
    }
    for (const child of [].concat(children)) {
      if (child == null) continue
      node.append(child)
    }
    return node
  },

  svg (paths, size = 16) {
    const wrap = document.createElement('span')
    wrap.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
    return wrap.firstChild
  },

  title (media) {
    return media?.title?.userPreferred ?? media?.title?.english ?? media?.title?.romaji ?? media?.title?.native ?? 'Unknown'
  },

  // strip html from AniList descriptions
  plainDesc (html) {
    const div = document.createElement('div')
    div.innerHTML = (html ?? '').replaceAll('<br>', '\n')
    return div.textContent ?? ''
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

  format (media) {
    return this.formatMap[media?.format] ?? media?.format ?? ''
  },

  seasonYear (media) {
    if (!media?.season || !media?.seasonYear) return media?.startDate?.year ?? ''
    return `${this.seasonMap[media.season]} ${media.seasonYear}`
  },

  episodeCount (media) {
    return media?.episodes ?? (media?.nextAiringEpisode ? `${media.nextAiringEpisode.episode - 1}+` : '?')
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

  relTime (date) {
    const diff = +date - Date.now()
    const abs = Math.abs(diff)
    const units = [[86400000 * 7, 'week'], [86400000, 'day'], [3600000, 'hour'], [60000, 'minute']]
    for (const [ms, name] of units) {
      if (abs >= ms) {
        const val = Math.round(abs / ms)
        return diff > 0 ? `in ${val} ${name}${val > 1 ? 's' : ''}` : `${val} ${name}${val > 1 ? 's' : ''} ago`
      }
    }
    return diff > 0 ? 'soon' : 'just now'
  },

  airDate (str) {
    if (!str) return ''
    const date = new Date(str)
    if (isNaN(+date)) return str
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  },

  debounce (fn, ms = 350) {
    let timer
    return (...args) => {
      clearTimeout(timer)
      timer = setTimeout(() => fn(...args), ms)
    }
  },

  toast (message, type = '') {
    const node = U.el('div', { class: `toast ${type}`, text: message })
    document.getElementById('toasts').append(node)
    setTimeout(() => {
      node.style.opacity = '0'
      node.style.transition = 'opacity .3s'
      setTimeout(() => node.remove(), 350)
    }, 3500)
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

window.U = U
