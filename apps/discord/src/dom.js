/* Apró DOM-segédek. Ugyanaz a szerződés, mint a főoldalon: egy `el()`, ami
   attribútumot és gyereket is kap, és soha nem ad vissza `innerHTML`-t
   felhasználói adatból. */

export function el (tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [kulcs, ertek] of Object.entries(attrs)) {
    if (ertek === null || ertek === undefined || ertek === false) continue
    if (kulcs === 'text') { node.textContent = String(ertek); continue }
    if (kulcs === 'class') { node.className = ertek; continue }
    if (kulcs.startsWith('on') && typeof ertek === 'function') {
      node.addEventListener(kulcs.slice(2), ertek)
      continue
    }
    if (ertek === true) { node.setAttribute(kulcs, ''); continue }
    node.setAttribute(kulcs, String(ertek))
  }
  for (const gyerek of [].concat(children)) {
    if (gyerek === null || gyerek === undefined || gyerek === false) continue
    node.append(typeof gyerek === 'string' ? document.createTextNode(gyerek) : gyerek)
  }
  return node
}

export function svg (path, size = 18) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  node.setAttribute('viewBox', '0 0 24 24')
  node.setAttribute('width', String(size))
  node.setAttribute('height', String(size))
  node.setAttribute('fill', 'none')
  node.setAttribute('stroke', 'currentColor')
  node.setAttribute('stroke-width', '2')
  node.setAttribute('stroke-linecap', 'round')
  node.setAttribute('stroke-linejoin', 'round')
  node.innerHTML = path
  return node
}

export function toast (message, tone = '') {
  const doboz = document.getElementById('toasts')
  if (!doboz) return
  const node = el('div', { class: `toast ${tone}`, text: message })
  doboz.append(node)
  setTimeout(() => node.remove(), 5000)
}

/** Egy szám emberi alakban. A `—` nem nulla: azt jelenti, nincs adat. */
export function szam (value) {
  if (value === null || value === undefined) return '—'
  return Number(value).toLocaleString('hu-HU')
}

export function ido (value) {
  if (!value) return '—'
  return new Date(value).toLocaleString('hu-HU')
}

/** Egy KPI-kártya. Ugyanaz az alak, mint az adminfelületen. */
export function kpi (label, value, { tone = 'blue', icon = '<circle cx="12" cy="12" r="10"/>', display = null, meta = null } = {}) {
  return el('div', { class: 'dash-kpi' }, [
    el('span', { class: 'dash-kpi-icon tone-' + tone }, [svg(icon, 17)]),
    el('div', { class: 'dash-kpi-body' }, [
      el('div', { class: 'dash-kpi-value', text: display ?? szam(value) }),
      el('div', { class: 'dash-kpi-label', text: label }),
      meta ? el('div', { class: 'dash-kpi-delta dash-kpi-flat' }, [el('span', { class: 'dash-kpi-compare', text: meta })]) : null
    ])
  ])
}

export function panel (title, sub, body) {
  return el('div', { class: 'dash-panel dash-panel-wide' }, [
    el('div', { class: 'dash-panel-head' }, [
      el('div', {}, [
        el('h3', { class: 'dash-panel-title', text: title }),
        sub ? el('p', { class: 'dash-panel-sub', text: sub }) : null
      ])
    ]),
    el('div', { class: 'dash-panel-body' }, [body])
  ])
}

export function sorok (items, empty = 'Nincs adat.') {
  if (!items.length) return el('p', { class: 'list-row-sub', text: empty })
  return el('div', { class: 'meta-rows' }, items.map(item =>
    el('div', { class: 'meta-row backup-row', style: 'align-items:flex-start;' }, [
      el('div', { class: 'meta-row-main', style: 'min-width:0;' }, [
        el('div', {}, [
          el('span', { class: 'badge' + (item.tone ? ' badge-' + item.tone : ''), text: item.label }),
          item.extra ? el('span', { class: 'badge', style: 'margin-left:6px;', text: item.extra }) : null
        ]),
        item.detail
          ? el('div', {
            class: 'meta-row-sub',
            style: 'margin-top:4px;white-space:normal;overflow-wrap:anywhere;',
            text: item.detail
          })
          : null
      ]),
      item.action ?? null
    ])))
}

/**
 * A „NINCS ADATFORRÁS" DOBOZ.
 *
 * Ez nem üres állapot és nem hiba: azt mondja meg, hogy egy nézetnek
 * SZERKEZETILEG nincs miből dolgoznia. A különbség nem szőrszálhasogatás —
 * egy üres lista azt állítaná, hogy nulla, egy hibaüzenet azt, hogy elromlott
 * valami. Egyik sem igaz.
 */
export function hianyzoForras (cim, miert, mihezKell = []) {
  return el('div', { class: 'dc-gap' }, [
    el('h3', { text: cim }),
    el('p', { text: miert }),
    mihezKell.length
      ? el('ul', {}, mihezKell.map(x => el('li', { text: x })))
      : null
  ])
}
