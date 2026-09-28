// A profil „Statisztika" és „Előzmények" füle.
//
// Mindkettő a helyi adatokból rajzol (könyvtár, ezen az eszközön vezetett
// előzmények), tehát a DOM-csonkban végigfuttatható. Amit őriz — mind mérve,
// a 2026-09-es QA-képernyőképeken:
//
//   1. A MAGYAR FELÜLETEN MAGYAR FELIRAT. A statisztika kártyái („WATCH
//      TIME", „DAYS ACTIVE"), a szakaszcímek és az állapotoszlopok („Watc",
//      „Plan") angolul, négy betűre vágva álltak.
//   2. AZ OSZLOPNAK VAN MAGASSÁGA. A régi `Charts.bars` minden oszlopot a
//      saját feliratával írt felül — oszlop soha nem látszott, csak lebegő
//      számok. Az új oszlop HTML, a magassága a legnagyobb értékhez mért
//      százalék.
//   3. AZ ELŐZMÉNYEK KIMONDJÁK, HOGY HELYIEK. A böngésző vezeti őket, nem a
//      kiszolgáló; egy másik gépen nézett rész itt nem jelenik meg.

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { createDocument, withDocument } from './support/mini-dom.mjs'
import { install } from './support/browser.mjs'

let PageAnalytics, PageHistory, Store, I18n
let restore

const DAY = 86400000

/** Egy könyvtári cím, annyi mezővel, amennyiből a fülek rajzolnak. */
const media = (id, extra = {}) => ({
  id,
  title: { romaji: `Cím ${id}`, english: `Title ${id}` },
  coverImage: { large: `https://img.test/${id}.jpg` },
  format: 'TV',
  episodes: 12,
  genres: ['Action', 'Drama'],
  studios: { nodes: [{ name: 'Stúdió ' + (id % 2 ? 'A' : 'B') }] },
  ...extra
})

/** Minden szövegcsomópont tartalma, sorrendben. */
function texts (node, out = []) {
  if (node.nodeType === 3) { out.push(node.textContent); return out }
  if (node.children?.length) for (const kid of node.children) texts(kid, out)
  else if (node.textContent) out.push(node.textContent)
  return out
}

before(async () => {
  install()
  ;({ I18n } = await import('../src/shared/i18n/i18n.js'))
  await import('../src/shared/i18n/hu.js')
  I18n.setLanguage('hu')
  ;({ Store } = await import('../src/shared/state/store.js'))
  ;({ PageAnalytics } = await import('../src/pages/analytics.js'))
  ;({ PageHistory } = await import('../src/pages/history.js'))
})

beforeEach(() => {
  restore?.()
  const doc = createDocument()
  // A kördiagram SVG-t rajzol; a csonknak elég, ha a névtér nélküli elemet adja.
  doc.createElementNS = (_ns, tag) => doc.createElement(tag)
  restore = withDocument(doc)
  globalThis.localStorage.clear()
})

after(() => restore?.())

/** Két cím a könyvtárban, és három megnézett rész: kettő ma, egy tegnap. */
function seed () {
  Store.saveEntry(media(1), { status: 'COMPLETED', progress: 12, score: 8 })
  Store.saveEntry(media(2), { status: 'CURRENT', progress: 3, score: 6 })
  // Délhez kötve, nem a futás pillanatához: éjfél után egy perccel a „most
  // mínusz egy perc" már tegnap volna, és a teszt a naptárat mérné.
  const noon = new Date()
  noon.setHours(12, 0, 0, 0)
  const at = noon.getTime()
  Store._write(Store._profileKey('history'), [
    { id: 2, episode: 3, at, media: Store._snapshot(media(2)) },
    { id: 1, episode: 12, at: at - 60_000, media: Store._snapshot(media(1)) },
    { id: 2, episode: 2, at: at - DAY, media: Store._snapshot(media(2)) }
  ])
}

describe('a statisztika fül', () => {
  it('a számok magyar felirattal állnak', () => {
    seed()
    const pad = document.createElement('div')
    PageAnalytics.body(pad)
    const labels = pad.querySelectorAll('.stat-label').map(n => n.textContent)
    assert.deepEqual(labels, ['Nézési idő', 'Megnézett részek', 'A könyvtárban', 'Befejezett', 'Átlagos értékelés', 'Aktív napok'])
    const all = texts(pad).join(' | ')
    for (const english of ['Watch time', 'Days active', 'Activity', 'Top genres', 'Formats', 'Score distribution', 'Top studios']) {
      assert.ok(!all.includes(english), `angol felirat maradt a magyar felületen: „${english}"`)
    }
  })

  it('az aktivitás tizennégy napot mutat, a mai nap a végén', () => {
    seed()
    const pad = document.createElement('div')
    PageAnalytics.body(pad)
    const activity = pad.querySelector('.viz-columns')
    assert.ok(activity, 'nincs aktivitási oszlopsor')
    const columns = activity.querySelectorAll('.viz-column')
    assert.equal(columns.length, 14)
    assert.ok(columns[13].className.includes('is-current'), 'az utolsó oszlop nem a mai nap')
    // Ma kettő, tegnap egy: a mai oszlop a legmagasabb, a tegnapi fele akkora.
    const height = column => column.querySelector('.viz-column-fill').style.cssText
    assert.equal(height(columns[13]), 'height:100.0%')
    assert.equal(height(columns[12]), 'height:50.0%')
    assert.equal(height(columns[0]), 'height:0.0%')
  })

  it('az oszlopot a felolvasó is megkapja, egy mondatban', () => {
    seed()
    const pad = document.createElement('div')
    PageAnalytics.body(pad)
    const today = pad.querySelector('.viz-columns').querySelectorAll('.viz-column')[13]
    const sentence = today.querySelector('.sr-only').textContent
    assert.match(sentence, /: 2 rész$/)
    for (const hidden of ['.viz-column-value', '.viz-column-track', '.viz-column-label']) {
      assert.equal(today.querySelector(hidden).getAttribute('aria-hidden'), 'true', `${hidden} kétszer hangzana el`)
    }
  })

  it('üres két hét helyett kimondja, hogy nincs mit mutatni', () => {
    Store.saveEntry(media(1), { status: 'PLANNING' })
    const pad = document.createElement('div')
    PageAnalytics.body(pad)
    assert.equal(pad.querySelector('.viz-columns'), null, 'csupa nulla oszlop egy üres doboz')
    assert.ok(texts(pad).some(t => t.includes('egy részt sem')), 'nincs magyarázat az üres aktivitásra')
  })

  it('a könyvtár állapotait nem ismétli (az az Áttekintés fülön áll)', () => {
    seed()
    const pad = document.createElement('div')
    PageAnalytics.body(pad)
    assert.ok(!texts(pad).some(t => /^(Watc|Plan|Comp|Paus|Drop)$/.test(t)), 'visszajöttek a levágott állapotfeliratok')
  })

  it('a műfajok fordítva kerülnek a jelmagyarázatba', () => {
    seed()
    const pad = document.createElement('div')
    PageAnalytics.body(pad)
    const legend = texts(pad.querySelector('.donut-legend'))
    assert.ok(legend.includes('Akció'), legend.join(', '))
    assert.ok(!legend.includes('Action'), legend.join(', '))
  })
})

describe('az előzmények fül', () => {
  it('kimondja, hogy az előzmények ezen az eszközön vannak', () => {
    seed()
    const pad = document.createElement('div')
    PageHistory.body(pad)
    assert.equal(pad.querySelector('.history-note').textContent, 'Az előzményeket csak ez az eszköz tárolja.')
  })

  it('napokra bont, „Ma" és „Tegnap" felirattal', () => {
    seed()
    const pad = document.createElement('div')
    PageHistory.body(pad)
    const days = pad.querySelectorAll('.history-day')
    assert.equal(days.length, 2)
    assert.deepEqual(days.map(d => d.querySelector('time').textContent), ['Ma', 'Tegnap'])
    assert.match(days[0].querySelector('time').getAttribute('datetime'), /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(days[0].querySelectorAll('.history-row').length, 2)
  })

  it('a borító nem mondja fel még egyszer a címet', () => {
    seed()
    const pad = document.createElement('div')
    PageHistory.body(pad)
    const row = pad.querySelector('.history-row')
    assert.equal(row.querySelector('img').getAttribute('alt'), '')
    assert.equal(row.querySelector('.lib-cover').getAttribute('tabindex'), '-1')
    assert.equal(row.querySelector('.lib-title').getAttribute('href'), '#/anime/2')
    assert.equal(row.querySelector('.btn').getAttribute('href'), '#/watch/2:3')
  })

  it('üresen nem kínál törlést, csak a katalógust', () => {
    const pad = document.createElement('div')
    PageHistory.body(pad)
    assert.equal(pad.querySelector('.history-head .btn'), null)
    assert.ok(texts(pad).some(t => t.startsWith('Ezen az eszközön még nem néztél semmit')))
  })
})
