// Statisztika — a profil „Statisztika" füle (#/profile?tab=analytics).
//
// Minden szám a helyi könyvtárból (Store.list) és az ezen az eszközön vezetett
// előzményekből (Store.history) számolódik; a fejléc számait a kiszolgáló
// összesítése (ProfileStats.hydrate) felülírja, amint megjön.
//
// 2026-09, újratervezve:
//
//   * Az oszlop- és sávdiagramok HTML-ből épülnek, nem SVG-ből. A régi
//     `Charts.bars` / `Charts.ranked` a viewBox-szal együtt a feliratot is
//     nagyította-kicsinyítette: asztalon 20, telefonon 7 képpontos számok. A
//     `bars` ráadásul minden oszlopot a saját feliratával írt felül
//     (`children[children.length - 1] = lbl`), így oszlop soha nem látszott,
//     csak lebegő számok — mérve, a QA-képernyőképeken.
//   * Minden felirat fordítva (a kártyák, a szakaszcímek és az állapotoszlopok
//     eddig angolul, négy betűre vágva álltak a magyar felületen).
//   * A könyvtár állapotonkénti megoszlása innen kikerült: ugyanaz a sáv az
//     Áttekintés fülön áll, a szűrt könyvtárra mutató linkekkel.
//   * A különálló `render()` törölve: a `#/analytics` cím a profil fülére
//     irányít (router `REDIRECTS`), a függvényt semmi nem hívta.

import { Charts } from '../shared/ui/charts.js'
import { I18n, T } from '../shared/i18n/i18n.js'
import { ProfileStats } from '../features/watch-history/profile-stats.js'
import { Store } from '../shared/state/store.js'
import { P } from '../shared/ui/primitives.js'
import { U } from '../shared/lib/dom.js'
import { WatchTime } from '../features/watch-history/watch-time.js'

const CHART_ICON = '<path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="7"/><rect x="12" y="7" width="3" height="11"/><rect x="17" y="4" width="3" height="14"/>'

export const PageAnalytics = {
  // A kategóriás színskála a tokens.css-ből. SVG-kitöltésként és
  // style.background-ként is feloldódik, így a diagram követi a témát.
  PALETTE: Array.from({ length: 12 }, (_, i) => `var(--chart-${i + 1})`),

  /** A profil fülének tartalma. */
  body (pad) {
    const entries = Object.values(Store.list())
    const history = Store.history()

    if (!entries.length && !history.length) {
      pad.append(P.emptyState(T('No data yet on this profile. Add anime to your library and watch a few episodes — your analytics build up here automatically.'), {
        icon: CHART_ICON,
        action: U.el('a', { class: 'btn btn-primary', href: '#/search', text: T('Browse the catalogue') })
      }))
      return
    }

    // ---- a számok ----
    // Ugyanaz a `.stat` komponens és ugyanazok a `data-stat` horgok, mint az
    // Áttekintés fülön: a kiszolgáló számai mindkettőt ugyanúgy frissítik.
    const episodesWatched = entries.reduce((sum, e) => sum + (e.progress ?? 0), 0)
    // Mért idő, nem becslés (WatchTime: valódi lejátszott másodpercek, a mérő
    // előtti részekre a régi becsléssel).
    const watch = WatchTime.minutesFor(entries)
    const completed = entries.filter(e => e.status === 'COMPLETED').length
    const scored = entries.filter(e => e.score > 0)
    const mean = scored.length ? (scored.reduce((sum, e) => sum + e.score, 0) / scored.length).toFixed(1) : '—'

    const stats = U.el('div', { class: 'stats analytics-stats' }, [
      [ProfileStats.formatMinutes(watch.totalMinutes), T('Watch time'), 'watchTime'],
      [I18n.number(episodesWatched), T('Episodes watched'), 'episodes'],
      [I18n.number(entries.length), T('In library'), null],
      [I18n.number(completed), T('Completed'), 'completed'],
      [mean, T('Mean score'), 'meanScore'],
      [I18n.number(this._activeDays(history)), T('Days active'), null, T('on this device')]
    ].map(([value, label, stat, sub]) => U.el('div', { class: 'stat', ...(stat ? { 'data-stat': stat } : {}) }, [
      U.el('span', { class: 'stat-label', text: label }),
      U.el('b', { class: 'stat-value', text: value }),
      sub ? U.el('span', { class: 'stat-sub', text: sub }) : null
    ])))
    pad.append(stats)
    ProfileStats?.hydrate(stats)

    // ---- aktivitás: az elmúlt két hét, naponta ----
    const weekly = this._weekly(history)
    pad.append(this._section(
      T('Activity'),
      T('Episodes watched per day on this device, over the last two weeks.'),
      weekly.some(day => day.value > 0)
        ? this._columns(weekly, {
          label: T('Episodes watched per day'),
          describe: day => I18n.f(T('{date}: {n} episodes'), { date: day.long, n: I18n.number(day.value) })
        })
        : this._noData(T('Nothing watched on this device in the last two weeks.'))
    ))

    // ---- műfajok és formátumok, egymás mellett ----
    const genres = this._genreBreakdown(entries).slice(0, 8)
    const formats = this._countBy(entries, e => U.format(e.media) || T('Unknown'))
    pad.append(U.el('div', { class: 'analytics-grid' }, [
      this._card(T('Top genres'), genres.length
        ? Charts.donut(genres.map((g, i) => ({ label: T(g.label), value: g.value, color: this.PALETTE[i % this.PALETTE.length] })), { label: T('Genre distribution') })
        : this._noData()),
      this._card(T('Formats'), formats.length
        ? Charts.donut(formats.map((f, i) => ({ label: f.label, value: f.value, color: this.PALETTE[i % this.PALETTE.length] })), { label: T('Format distribution') })
        : this._noData())
    ]))

    // ---- pontszámok ----
    if (scored.length) {
      const buckets = Array.from({ length: 10 }, (_, i) => ({ label: String(i + 1), value: 0 }))
      for (const e of scored) buckets[Math.min(9, Math.max(0, Math.round(e.score) - 1))].value++
      pad.append(this._section(
        T('Score distribution'),
        I18n.f(T('Across {n} rated titles.'), { n: I18n.number(scored.length) }),
        this._columns(buckets, {
          label: T('Score histogram'),
          describe: bucket => I18n.f(T('Score {score}: {n} titles'), { score: bucket.label, n: I18n.number(bucket.value) })
        })
      ))
    }

    // ---- stúdiók ----
    const studios = this._studioBreakdown(entries).slice(0, 8)
    if (studios.length) {
      pad.append(this._section(
        T('Top studios'),
        T('Studios you watch the most, by number of titles in your library.'),
        this._rows(studios, { label: T('Top studios') })
      ))
    }
  },

  // ---- építőelemek ----

  _section (title, sub, body) {
    return U.el('section', { class: 'section analytics-section' }, [
      U.el('div', { class: 'section-head' }, [
        U.el('div', {}, [
          U.el('h2', { class: 'section-title', text: title }),
          sub ? U.el('p', { class: 'section-sub', text: sub }) : null
        ])
      ]),
      body
    ])
  },

  _card (title, child) {
    // h2, nem h3: a kártyák közvetlenül a lap szakaszai, fölöttük nincs h2.
    return U.el('section', { class: 'chart-card' }, [
      U.el('h2', { class: 'chart-card-title', text: title }),
      child
    ])
  },

  _noData (text = T('Not enough data yet.')) {
    return U.el('p', { class: 'chart-empty', text })
  },

  /**
   * Oszlopdiagram HTML-ből: az oszlop magassága százalék, a szöveg valódi
   * CSS-méretű, bármilyen szélességen. A képernyőolvasó oszloponként egy
   * mondatot kap (`describe`), a látható szám és felirat el van rejtve előle.
   *
   * @param {Array<{label: string, value: number, current?: boolean}>} data
   */
  _columns (data, { label, describe }) {
    const max = Math.max(1, ...data.map(d => d.value))
    return U.el('ol', { class: 'viz-columns', 'aria-label': label }, data.map(d =>
      U.el('li', { class: 'viz-column' + (d.current ? ' is-current' : '') }, [
        U.el('span', { class: 'sr-only', text: describe(d) }),
        U.el('span', { class: 'viz-column-value', 'aria-hidden': 'true', text: d.value ? I18n.number(d.value) : '' }),
        U.el('span', { class: 'viz-column-track', 'aria-hidden': 'true' }, [
          U.el('span', { class: 'viz-column-fill', style: `height:${(d.value / max * 100).toFixed(1)}%` })
        ]),
        U.el('span', { class: 'viz-column-label', 'aria-hidden': 'true', text: d.label })
      ])))
  },

  /**
   * Vízszintes rangsor: név, sáv, szám. A név hosszú lehet (stúdiónevek),
   * ezért kipontozódik — a teljes név a `title`-ben és a felolvasásban marad.
   *
   * @param {Array<{label: string, value: number}>} data
   */
  _rows (data, { label }) {
    const max = Math.max(1, ...data.map(d => d.value))
    return U.el('ol', { class: 'viz-rows', 'aria-label': label }, data.map(d =>
      U.el('li', { class: 'viz-row' }, [
        U.el('span', { class: 'viz-row-name', title: d.label, text: d.label }),
        U.el('span', { class: 'viz-row-track', 'aria-hidden': 'true' }, [
          U.el('span', { class: 'viz-row-fill', style: `width:${(d.value / max * 100).toFixed(1)}%` })
        ]),
        U.el('span', { class: 'viz-row-value', text: I18n.number(d.value) })
      ])))
  },

  // ---- számítások ----

  _activeDays (history) {
    return new Set(history.map(h => new Date(h.at).toDateString())).size
  },

  /**
   * Az elmúlt tizennégy nap, a helyi naptár szerint. Naptári lépéssel, nem
   * `Date.now() - i * 86400000`-rel: az óraátállítás napján az utóbbi egy
   * napot kihagy vagy kétszer számol.
   */
  _weekly (history) {
    const now = new Date()
    const days = []
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
      days.push({
        key: d.toDateString(),
        label: String(d.getDate()),
        long: d.toLocaleDateString(I18n.locale(), { month: 'short', day: 'numeric' }),
        current: i === 0,
        value: 0
      })
    }
    const index = new Map(days.map(d => [d.key, d]))
    for (const h of history) {
      const bucket = index.get(new Date(h.at).toDateString())
      if (bucket) bucket.value++
    }
    return days
  },

  _genreBreakdown (entries) {
    return this._countBy(entries.flatMap(e => e.media?.genres ?? []), g => g)
  },

  _studioBreakdown (entries) {
    return this._countBy(entries.map(e => e.media?.studios?.nodes?.[0]?.name).filter(Boolean), s => s)
  },

  /** Előfordulások száma, csökkenő sorrendben: [{label, value}]. */
  _countBy (items, keyFn) {
    const map = new Map()
    for (const item of items) {
      const key = keyFn(item)
      if (!key) continue
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return [...map.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
  }
}
