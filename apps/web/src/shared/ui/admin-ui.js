// Az adminfelület primitívjei.
//
// A panel tizenkilenc képernyője tizenkilenc saját komponenscsaládot hozott
// magával — `dash-`, `mon-`, `cat-`, `aud-`, `sec-`, `perm-`, `user-`, `tr-`,
// `comp-`, `src-`, `flag-`, `report-` —, ötszáz CSS-szabállyal, mindegyik a
// maga belső margójával és betűméretével. Ez a „zsúfolt" érzés forrása: nem a
// sok adat, hanem hogy minden képernyőn újra kell tanulni, mi a cím, mi a
// mérőszám és mi a kísérőszöveg.
//
// Itt tizenkét építőelem van. Minden képernyő ezekből épül. Ha egy
// képernyőnek új elem kell, az azt jelenti, hogy vagy ez a készlet hiányos,
// vagy a képernyő akar valamit, amit nem kellene.
//
// A stílusuk a css/admin.css-ben él, `ap-` előtaggal.

import { U } from '../lib/dom.js'

/** Csak a nem üres gyerekeket engedi tovább — a `null` kimarad. */
const kids = list => [].concat(list ?? []).filter(Boolean)

export const AP = {
  /**
   * Függőleges ritmus.
   *
   * Minden szakasz gyereke ezt kapja, és akkor nem kell minden komponensnek
   * saját alsó margót hordania — ez volt az, amitől a szakaszközök
   * képernyőnként mások lettek.
   */
  stack (children, { tight = false } = {}) {
    return U.el('div', { class: 'ap-stack' + (tight ? ' ap-stack-tight' : '') }, kids(children))
  },

  /** Szakaszcím a törzsön belül, opcionális magyarázattal és gombokkal. */
  section (title, { note = null, actions = null } = {}) {
    return U.el('div', { class: 'ap-section' }, [
      U.el('h2', { class: 'ap-section-title', text: title }),
      note ? U.el('span', { class: 'ap-section-note', text: note }) : null,
      actions ? U.el('div', { class: 'ap-section-actions' }, kids(actions)) : null
    ])
  },

  /**
   * Kártyarács. `col` a legkisebb oszlopszélesség.
   *
   * A `stats: true` mérőszámrácsot jelent: telefonon kettesével áll, nem
   * egyesével. Egy rövid szám és egy címke bőven elfér 170 képpontban, és
   * tizenegy mérőszám egymás alatt, egyenként teljes szélességben, olyan
   * hosszú lapot ad, aminek a végére senki nem görget el.
   */
  grid (children, { col = null, stats = false } = {}) {
    return U.el('div', {
      class: 'ap-grid' + (stats ? ' ap-grid-stats' : ''),
      ...(col ? { style: `--col:${col};` } : {})
    }, kids(children))
  },

  /** A kártya. Egy sarok, egy keret, egy belső margó. */
  card ({ title = null, sub = null, actions = null, body = null, cls = '' } = {}) {
    const head = title || actions
      ? U.el('div', { class: 'ap-card-head' }, [
        title
          ? U.el('div', { class: 'ap-card-title' }, [
            document.createTextNode(title),
            sub ? U.el('div', { class: 'ap-card-sub', text: sub }) : null
          ])
          : null,
        actions ? U.el('div', { class: 'ap-card-actions' }, kids(actions)) : null
      ])
      : null
    return U.el('div', { class: 'ap-card' + (cls ? ' ' + cls : '') }, [head, ...kids(body)])
  },

  /**
   * Mérőszám.
   *
   * Ez váltja a `dash-kpi`-t és a `mon-card`-ot: eddig két komponens
   * csinálta ugyanazt, két mérettel — és emiatt ugyanaz a szám máshogy
   * nézett ki az Áttekintésen és az Infrastruktúrán.
   *
   * @param {object} o
   * @param {string} o.label   mit mér
   * @param {string} o.value   a szám, készre formázva
   * @param {string} [o.meta]  egy sor magyarázat alá
   * @param {'ok'|'warn'|'bad'} [o.tone] állapotpötty a címke mellé
   * @param {{now:number, before:number}} [o.compare] az előző időszak
   */
  stat ({ label, value, meta = null, tone = null, compare = null }) {
    return U.el('div', { class: 'ap-card' }, [
      U.el('div', { class: 'ap-stat' }, [
        U.el('div', { class: 'ap-stat-label' }, [
          tone ? U.el('span', { class: 'ap-stat-dot ' + tone }) : null,
          document.createTextNode(label)
        ]),
        U.el('div', { class: 'ap-stat-value', text: value }),
        compare ? AP.delta(compare.now, compare.before) : null,
        meta ? U.el('div', { class: 'ap-stat-meta', text: meta }) : null
      ])
    ])
  },

  /**
   * Változás az előző, azonos hosszú időszakhoz.
   *
   * „Nincs mihez mérni" nem nulla: egy friss telepítésen az előző időszak nem
   * lapos, hanem nem létezik, és a 0% azt hazudja, hogy nem történt semmi.
   */
  delta (now, before) {
    const known = Number.isFinite(before) && before > 0
    const pct = known ? Math.round(((Number(now) - before) / before) * 100) : null
    const dir = pct === null ? 'flat' : pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'
    return U.el('div', { class: 'ap-stat-delta ' + dir }, [
      U.el('span', { text: pct === null ? '—' : (pct > 0 ? '+' : '') + pct + '%' }),
      U.el('span', { class: 'ap-stat-delta-note', text: pct === null ? 'nincs mihez mérni' : 'az előző időszakhoz' })
    ])
  },

  /** Lista. */
  list (rows) {
    return U.el('div', { class: 'ap-list' }, kids(rows))
  },

  /**
   * Egy sor: bevezető, törzs, lezárás.
   *
   * Ha van `onclick`, a sor egésze kattintható és gombként viselkedik —
   * billentyűzettel is elérhető, nem csak egérrel.
   */
  row ({ lead = null, title, tags = null, meta = null, trail = null, value = null, onclick = null }) {
    const body = U.el('div', { class: 'ap-row-body' }, [
      U.el('div', { class: 'ap-row-title' }, [
        document.createTextNode(title),
        ...kids(tags)
      ]),
      meta ? U.el('div', { class: 'ap-row-meta', text: meta }) : null
    ])
    const trailing = trail || value
      ? U.el('div', { class: 'ap-row-trail' }, [
        value ? U.el('span', { class: 'ap-row-value', text: value }) : null,
        ...kids(trail)
      ])
      : null
    const children = [
      lead ? U.el('div', { class: 'ap-row-lead' }, kids(lead)) : null,
      body,
      trailing
    ]
    return onclick
      ? U.el('button', { class: 'ap-row ap-row-link', type: 'button', onclick }, children)
      : U.el('div', { class: 'ap-row' }, children)
  },

  /** Szűrősor egy lista fölött. */
  toolbar (children) {
    return U.el('div', { class: 'ap-toolbar' }, kids(children))
  },

  /**
   * Fülek.
   *
   * @param {Array<[string, string, number?]>} items  [érték, felirat, szám?]
   */
  tabs (items, active, onpick) {
    return U.el('div', { class: 'ap-tabs' }, items.map(([value, label, count]) =>
      U.el('button', {
        class: 'ap-tab' + (value === active ? ' on' : ''),
        type: 'button',
        onclick: () => onpick(value)
      }, [
        document.createTextNode(label),
        count === undefined || count === null ? null : U.el('span', { class: 'ap-tab-count', text: String(count) })
      ])))
  },

  /** Állapotcímke. */
  tag (text, tone = '') {
    return U.el('span', { class: 'ap-tag' + (tone ? ' ' + tone : ''), text })
  },

  /** Kulcs–érték sorok: egy dolog tényei. */
  kv (pairs) {
    return U.el('div', { class: 'ap-kv' }, pairs.filter(Boolean).flatMap(([key, value]) => [
      U.el('div', { class: 'ap-kv-key', text: key }),
      typeof value === 'string' || typeof value === 'number'
        ? U.el('div', { class: 'ap-kv-val', text: String(value) })
        : U.el('div', { class: 'ap-kv-val' }, [value])
    ]))
  },

  /**
   * Üres állapot.
   *
   * Mindig megmondja a következő lépést, nem csak az ürességet: egy „nincs
   * adat" felirat azt is jelentheti, hogy elromlott valami.
   */
  empty (title, note = null, action = null) {
    return U.el('div', { class: 'ap-empty' }, [
      U.el('div', { class: 'ap-empty-title', text: title }),
      note ? U.el('p', { class: 'ap-empty-note', text: note }) : null,
      action
    ])
  },

  /** Egy mondat, ami a fenti szám értelmezését adja meg. */
  note (text) {
    return U.el('p', { class: 'ap-note', text })
  }
}
