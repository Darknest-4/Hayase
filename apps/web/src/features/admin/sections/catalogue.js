/* global confirm, document, window */
// Admin — Katalógus.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('catalogue')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { AP } from '../../../shared/ui/admin-ui.js'
import { I18n } from '../../../shared/i18n/i18n.js'
import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'
import { AdminModals } from '../modals.js'

export default {
  // ---- Catalogue: anime + episode management, visibility control ----
  VIS_BADGE: { public: ['Nyilvános', 'vis-public'], unlisted: ['Listázatlan', 'vis-unlisted'], hidden: ['Rejtett', 'vis-hidden'] },
  FORMATS: ['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC'],
  STATUSES: ['NOT_YET_RELEASED', 'RELEASING', 'FINISHED', 'CANCELLED', 'HIATUS'],
  SEASONS: ['WINTER', 'SPRING', 'SUMMER', 'FALL'],

  async renderCatalogue (content) {
    const perms = await YumeAPI.myPermissions()
    const can = s => perms.includes(s)
    const state = { q: '', visibility: '', selected: null }

    const layout = U.el('div', { class: 'cat-layout' })
    const listCol = U.el('div', { class: 'cat-list-col' })
    const editCol = U.el('div', { class: 'cat-edit-col' })
    layout.append(listCol, editCol)
    content.replaceChildren(layout)

    // ---- toolbar ----
    const listBox = U.el('div', { class: 'cat-list' })
    const toolbar = U.el('div', { class: 'cat-toolbar' }, [
      U.el('input', { class: 'input', placeholder: 'Keresés a katalógusban…', oninput: U.debounce(e => { state.q = e.target.value.trim(); loadList() }) }),
      U.el('select', { class: 'select', 'aria-label': 'Szűrés láthatóság szerint', onchange: e => { state.visibility = e.target.value; loadList() } },
        [['', 'Bármilyen láthatóság'], ['public', 'Nyilvános'], ['unlisted', 'Listázatlan'], ['hidden', 'Rejtett']].map(([v, l]) =>
          U.el('option', { value: v, text: l }))),
      can('anime.create') ? U.el('button', { class: 'btn btn-primary btn-sm', onclick: () => openEditor(null) }, [document.createTextNode('+ Új anime')]) : null,
      can('anime.merge') ? U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { state.selected = null; this.renderCatDuplicates(editCol, can, () => { loadList(); this.renderCatDuplicates(editCol, can, loadList) }) } }, [document.createTextNode('Duplikátumok')]) : null,
      // Az importált katalógus minden epizódja rejtett — ez az oszlop
      // alapértelmezése, nem döntés. 32 000 címet senki nem publikál kézzel,
      // és addig minden részletoldalon az áll, hogy nincs epizódadat.
      can('episode.edit')
        ? U.el('button', {
          class: 'btn btn-ghost btn-sm',
          title: 'Shifttel megnyomva visszarejti őket',
          onclick: e => publishAll(e.shiftKey ? 'hidden' : 'public')
        }, [document.createTextNode('Epizódok publikálása…')])
        : null
    ])

    // Az eszköztár a két oszlop FÖLÖTT, teljes szélességben. A 22rem-es
    // listaoszlopban a kereső, a szűrő és három gomb három sorba tördelődött,
    // miközben jobbra egy üres, 700 képpont széles doboz állt.
    layout.append(toolbar, listCol, editCol)

    /**
     * Az egész katalógus epizódjainak publikálása.
     *
     * Nem kérdez rá kétszer, de megmondja előre, hány sort érint, és a
     * visszavonás ugyanitt van egy gombnyomásra ('hidden'), mert ez egy
     * kapcsoló, nem egy törlés.
     */
    const publishAll = async (visibility) => {
      const ok = window.confirm(visibility === 'public'
        ? 'Az összes publikus cím epizódja láthatóvá válik a látogatók számára.\n\n' +
          'Ez csak az epizódsorokat érinti (cím, leírás, kép, dátum) — videóforrást ' +
          'nem tesz elérhetővé, azokat külön kapcsoló engedi.\n\n' +
          'Visszavonható: ugyanez a gomb Shifttel megnyomva visszarejti őket.'
        : 'Az összes epizód visszakerül rejtettbe. A részletoldalakon ismét az ' +
          'fog állni, hogy nincs epizódadat.')
      if (!ok) return
      try {
        const res = await YumeAPI.admin.catalogue.episodeVisibilityAll({ visibility })
        const verb = visibility === 'public' ? 'publikálva' : 'elrejtve'
        U.toast(res.changed ? `${res.changed.toLocaleString(I18n.locale())} epizód ${verb}` : 'Nem volt mit változtatni')
      } catch (e) { U.toast(e.message, 'error') }
    }
    listCol.append(listBox)

    const loadList = async () => {
      listBox.replaceChildren(P.spinner())
      try {
        const { data, total } = await YumeAPI.admin.catalogue.list({ q: state.q, visibility: state.visibility, limit: 40 })
        listBox.replaceChildren()
        listBox.append(U.el('div', { class: 'cat-count', text: `${total.toLocaleString(I18n.locale())} cím` }))
        if (!data.length) { listBox.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-4);', text: 'Nincs találat.' })); return }
        for (const a of data) listBox.append(this.catRow(a, state, openEditor))
      } catch (e) {
        listBox.replaceChildren(P.errorState(e.message))
      }
    }

    // ---- editor (null = create) ----
    const openEditor = async (anime) => {
      editCol.replaceChildren(P.spinner())
      let full = anime
      if (anime?.id) { try { full = await YumeAPI.admin.catalogue.get(anime.id) } catch (e) { editCol.replaceChildren(P.errorState(e.message)); return } }
      state.selected = full?.id ?? null
      listBox.querySelectorAll('.cat-row').forEach(r => r.classList.toggle('active', r.dataset.id === state.selected))
      this.renderCatEditor(editCol, full, { can, onSaved: loadList, onDeleted: () => { editCol.replaceChildren(this.catPlaceholder()); loadList() } })
    }

    editCol.append(this.catPlaceholder())
    loadList()
  },

  catPlaceholder () {
    return U.el('div', { class: 'cat-placeholder' }, [
      U.svg('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>', 40),
      U.el('p', { text: 'Válassz egy címet a listából, vagy hozz létre újat.' })
    ])
  },

  catRow (a, state, openEditor) {
    /*
     * A láthatóság címkéje CSAK akkor jelenik meg, ha nem nyilvános.
     *
     * Harmincketten­ezer sorból mind nyilvános: egy zöld „NYILVÁNOS" minden
     * soron nem információ, csak zaj — és pont attól nem tűnik fel az az öt,
     * ami rejtett. A kivétel az, amit látni kell.
     */
    const [label, tone] = this.VIS_TAG[a.visibility] ?? []
    const row = U.el('button', {
      class: 'cat-row' + (a.id === state.selected ? ' active' : ''),
      dataset: { id: a.id },
      onclick: () => openEditor(a)
    }, [
      U.el('div', { class: 'cat-row-main' }, [
        U.el('div', { class: 'cat-row-title', text: a.canonical_title }),
        U.el('div', {
          class: 'cat-row-sub',
          text: `${a.format} · ${a.season_year ?? '—'} · ${a.episode_rows} epizód`
        })
      ]),
      label ? AP.tag(label, tone) : null
    ])
    return row
  },

  /** Csak a nem nyilvános állapotoknak van címkéje — lásd `catRow`. */
  VIS_TAG: {
    unlisted: ['listázatlan', 'warn'],
    hidden: ['rejtett', 'bad']
  },

  renderCatEditor (host, anime, { can, onSaved, onDeleted }) {
    const isNew = !anime?.id
    const editable = isNew ? can('anime.create') : can('anime.edit')
    const draft = {
      canonical_title: anime?.canonical_title ?? '',
      format: anime?.format ?? 'TV',
      status: anime?.status ?? 'FINISHED',
      season: anime?.season ?? '',
      season_year: anime?.season_year ?? '',
      episode_count: anime?.episode_count ?? '',
      episode_duration: anime?.episode_duration ?? '',
      source_material: anime?.source_material ?? '',
      synopsis: anime?.synopsis ?? '',
      is_adult: anime?.is_adult ?? false,
      visibility: anime?.visibility ?? 'public'
    }

    host.replaceChildren()
    const form = U.el('div', { class: 'cat-editor' })
    host.append(form)

    form.append(U.el('div', { class: 'cat-editor-head' }, [
      U.el('h2', { class: 'cat-editor-title', text: isNew ? 'New anime' : draft.canonical_title || 'Untitled' }),
      anime?.id ? U.el('code', { class: 'cat-editor-id', text: anime.id }) : null
    ]))

    const field = (label, el) => U.el('label', { class: 'cat-field' }, [U.el('span', { class: 'cat-field-label', text: label }), el])
    const input = (key, attrs = {}) => U.el('input', { class: 'input', value: draft[key] ?? '', ...(editable ? {} : { disabled: '' }), oninput: e => { draft[key] = e.target.value }, ...attrs })
    const select = (key, opts, withEmpty) => U.el('select', { class: 'select', ...(editable ? {} : { disabled: '' }), onchange: e => { draft[key] = e.target.value } },
      [...(withEmpty ? [U.el('option', { value: '', text: '—', ...(draft[key] ? {} : { selected: '' }) })] : []),
        ...opts.map(o => U.el('option', { value: o, text: o.replace(/_/g, ' '), ...(draft[key] === o ? { selected: '' } : {}) }))])

    // visibility — the headline control
    form.append(U.el('div', { class: 'cat-visibility' }, [
      U.el('div', {}, [
        U.el('div', { class: 'cat-field-label', text: 'Láthatóság' }),
        U.el('p', { class: 'cat-vis-hint', text: 'A rejtett mindenhonnan eltűnik, a részletoldaláról is. A listázatlan csak közvetlen hivatkozással érhető el.' })
      ]),
      select('visibility', ['public', 'unlisted', 'hidden'])
    ]))

    form.append(U.el('div', { class: 'cat-grid' }, [
      field('Cím', input('canonical_title', { placeholder: 'Kanonikus cím' })),
      field('Formátum', select('format', this.FORMATS)),
      field('Állapot', select('status', this.STATUSES)),
      field('Évad', select('season', this.SEASONS, true)),
      field('Évad éve', input('season_year', { type: 'number', min: 1900, max: 2100 })),
      field('Epizódok (tervezett)', input('episode_count', { type: 'number', min: 0 })),
      field('Epizódhossz (perc)', input('episode_duration', { type: 'number', min: 0 })),
      field('Forrásanyag', input('source_material', { placeholder: 'MANGA, LIGHT_NOVEL…' }))
    ]))
    form.append(field('Synopsis', U.el('textarea', { class: 'input', rows: 4, ...(editable ? {} : { disabled: '' }), oninput: e => { draft.synopsis = e.target.value } }, [document.createTextNode(draft.synopsis)])))
    form.append(U.el('label', { class: 'cat-check' }, [
      U.el('input', { type: 'checkbox', ...(draft.is_adult ? { checked: '' } : {}), ...(editable ? {} : { disabled: '' }), onchange: e => { draft.is_adult = e.target.checked } }),
      U.el('span', { text: 'Felnőtt (NSFW) tartalom' })
    ]))

    // ---- actions ----
    if (editable) {
      const num = v => v === '' || v == null ? null : Number(v)
      const payload = () => ({
        canonical_title: draft.canonical_title.trim(),
        format: draft.format,
        status: draft.status,
        season: draft.season || null,
        season_year: num(draft.season_year),
        episode_count: num(draft.episode_count),
        episode_duration: num(draft.episode_duration),
        source_material: draft.source_material.trim() || null,
        synopsis: draft.synopsis.trim() || null,
        is_adult: draft.is_adult,
        visibility: draft.visibility
      })
      const actions = U.el('div', { class: 'cat-actions' })
      actions.append(U.el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!draft.canonical_title.trim()) return U.toast('A cím kötelező', 'error')
          try {
            if (isNew) { const c = await YumeAPI.admin.catalogue.create(payload()); U.toast('Anime létrehozva'); onSaved?.(); anime = c } else { await YumeAPI.admin.catalogue.update(anime.id, payload()); U.toast('Mentve'); onSaved?.() }
          } catch (e) { U.toast(e.message, 'error') }
        }
      }, [document.createTextNode(isNew ? 'Create anime' : 'Save changes')]))
      if (!isNew && can('anime.delete')) {
        actions.append(U.el('button', {
          class: 'btn btn-danger',
          onclick: async () => {
            if (!confirm(`Delete "${anime.canonical_title}" and all its episodes? This cannot be undone.`)) return
            try { await YumeAPI.admin.catalogue.remove(anime.id); U.toast('Törölve'); onDeleted?.() } catch (e) { U.toast(e.message, 'error') }
          }
        }, [document.createTextNode('Törlés')]))
      }
      form.append(actions)
    } else {
      form.append(U.el('div', { class: 'callout', text: 'A katalógushoz csak olvasási jogod van.' }))
    }

    // ---- metadata provenance (existing anime only) ----
    if (!isNew) this.renderCatProvenance(form, anime, { can, onSaved })

    // ---- episodes (existing anime only) ----
    if (!isNew) this.renderCatEpisodes(form, anime, can)
  },

  // Shows where each field's value came from and which fields are locked
  // against the importers. Saving in this editor locks whatever it wrote, so
  // the only action needed here is releasing a field back to automation.
  renderCatProvenance (form, anime, { can, onSaved }) {
    const locked = anime.locked_fields ?? []
    const sources = anime.metadata_sources ?? {}
    const fields = [...new Set([...locked, ...Object.keys(sources)])].sort()
    if (!fields.length) return

    const wrap = U.el('div', { class: 'cat-provenance' })
    wrap.append(U.el('h3', { class: 'detail-section-title', style: 'margin:0 0 var(--space-2);', text: 'Metaadatforrások' }))
    wrap.append(U.el('p', { class: 'cat-vis-hint', text: 'A locked field was set by hand and is never overwritten by the AniList importer. Release it to let automatic updates resume.' }))

    const table = U.el('div', { class: 'prov-table' })
    for (const field of fields) {
      const src = sources[field]
      const isLocked = locked.includes(field)
      table.append(U.el('div', { class: 'prov-row' }, [
        U.el('code', { class: 'prov-field', text: field }),
        U.el('span', { class: 'prov-source', text: src ? [src.provider, src.at ? U.relTime(new Date(src.at)) : null].filter(Boolean).join(' · ') : 'unknown' }),
        isLocked
          ? U.el('span', { class: 'vis-badge vis-hidden', text: 'zárolva' })
          : U.el('span', { class: 'prov-auto', text: 'automatikus' }),
        isLocked && can('anime.edit')
          ? U.el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: async e => {
              e.target.disabled = true
              try { await YumeAPI.admin.catalogue.unlock(anime.id, [field]); U.toast(`"${field}" released to the importer`); onSaved?.() } catch (err) { U.toast(err.message, 'error'); e.target.disabled = false }
            }
          }, [document.createTextNode('Kiadás')])
          : null
      ]))
    }
    wrap.append(table)
    form.append(wrap)
  },

  // Duplicate scan. Read-only by design: it proposes pairs and a human with
  // anime.merge confirms each one, because a merge cannot be undone.
  //
  // Two scans, and which one runs is the operator's choice. Identical titles
  // are the default: five times as many pairs and it returns immediately. The
  // similar-title scan compares every title against every other in its year
  // and format, which is a minute of database time on this catalogue — a
  // reasonable thing to ask for and an unreasonable thing to be given for
  // opening a tab.
  async renderCatDuplicates (host, can, reload, mode = 'exact') {
    host.replaceChildren(P.spinner())
    try {
      const { data } = await YumeAPI.admin.catalogue.duplicates({ mode })
      host.replaceChildren()
      const consequence = 'Merging moves titles, synonyms, genres, tags, external ids and library entries onto the entry you keep, then deletes the other one. This cannot be undone.'
      host.append(U.el('p', {
        class: 'cat-vis-hint',
        text: (mode === 'exact'
          ? 'Entries whose titles are identical, whatever year or format each one claims. '
          : 'Entries with near-identical titles in the same year and format. ') + consequence
      }))
      host.append(U.el('div', { class: 'admin-toolbar' }, [
        U.el('button', {
          class: 'btn btn-sm' + (mode === 'exact' ? ' btn-primary' : ''),
          type: 'button',
          onclick: () => this.renderCatDuplicates(host, can, reload, 'exact')
        }, [document.createTextNode('Azonos címek')]),
        U.el('button', {
          class: 'btn btn-sm' + (mode === 'similar' ? ' btn-primary' : ''),
          type: 'button',
          title: 'Minden címet összevet minden mással az évén és formátumán belül — ez nagyjából egy perc',
          onclick: () => this.renderCatDuplicates(host, can, reload, 'similar')
        }, [document.createTextNode('Hasonló címek (lassú)')])
      ]))
      if (!data.length) { host.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-4);', text: 'Nem találtam valószínű duplikátumot.' })); return }
      for (const d of data) {
        const keep = (winner, loser, title) => can('anime.merge')
          ? U.el('button', {
            class: 'btn btn-sm',
            onclick: async () => {
              if (!confirm(`Keep "${title}" and merge the other entry into it? This cannot be undone.`)) return
              try { await YumeAPI.admin.catalogue.merge(winner, loser); U.toast('Összevonva'); reload() } catch (e) { U.toast(e.message, 'error') }
            }
          }, [document.createTextNode('Ez maradjon')])
          : null
        host.append(U.el('div', { class: 'dup-pair' }, [
          U.el('div', { class: 'dup-side' }, [U.el('div', { class: 'dup-title', text: d.a_title }), keep(d.a_id, d.b_id, d.a_title)]),
          U.el('div', { class: 'dup-meta', text: `${(Number(d.similarity) * 100).toFixed(0)}% · ${d.season_year ?? '—'} · ${d.format ?? '—'}` }),
          U.el('div', { class: 'dup-side' }, [U.el('div', { class: 'dup-title', text: d.b_title }), keep(d.b_id, d.a_id, d.b_title)])
        ]))
      }
    } catch (e) {
      host.replaceChildren(P.errorState(e.message))
    }
  },

  async renderCatEpisodes (form, anime, can) {
    const wrap = U.el('div', { class: 'cat-episodes' })

    // Publishing a season happens in batches — a set of subtitles lands and
    // several episodes go live together. Doing that one row at a time is one
    // chance per episode to miss one, and a half-published season is exactly
    // the state this is meant to prevent.
    const bulk = async (visibility) => {
      const label = visibility === 'public' ? 'Publish' : visibility === 'hidden' ? 'Unpublish' : 'Unlist'
      const range = window.prompt(`${label} which episodes? Blank = all. Examples: "1-6", "3"`, '')
      if (range === null) return
      const body = { visibility }
      const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(range)
      if (range.trim() && !match) return U.toast('Adj meg egy számot vagy tartományt, például 1-6', 'error')
      if (match) {
        body.from = Number(match[1])
        body.to = Number(match[2] ?? match[1])
      }
      try {
        const res = await YumeAPI.admin.catalogue.episodeVisibility(anime.id, body)
        U.toast(res.changed ? `${label}ed ${res.changed} episode(s)` : 'Nothing to change')
        load()
      } catch (e) { U.toast(e.message, 'error') }
    }

    form.append(U.el('div', { class: 'cat-ep-head' }, [
      U.el('h3', { class: 'detail-section-title', style: 'margin:0;', text: 'Epizódok' }),
      can('episode.edit') ? U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => bulk('public') }, [document.createTextNode('Publikálás…')]) : null,
      can('episode.edit') ? U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => bulk('hidden') }, [document.createTextNode('Visszavonás…')]) : null,
      can('episode.create') ? U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.episodeModal(anime, null, () => load()) }, [document.createTextNode('+ Epizód hozzáadása')]) : null
    ]))
    form.append(wrap)

    const load = async () => {
      wrap.replaceChildren(P.spinner())
      try {
        const { data } = await YumeAPI.admin.catalogue.episodes(anime.id)
        wrap.replaceChildren()
        if (!data.length) { wrap.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-3);', text: 'Még nincs epizód.' })); return }

        // How much of the season is actually reachable, stated once rather
        // than left to be counted off the rows.
        const live = data.filter(e => e.visibility === 'public').length
        wrap.append(U.el('div', {
          class: 'cat-ep-summary' + (live === 0 ? ' cat-ep-summary-none' : ''),
          text: live === data.length
            ? `All ${data.length} episodes are published.`
            : `${live} of ${data.length} episodes published — the rest are not reachable by viewers.`
        }))

        for (const ep of data) {
          const flags = [ep.is_filler ? 'filler' : null, ep.is_recap ? 'recap' : null].filter(Boolean).join(' · ')
          const [visLabel, visClass] = this.VIS_BADGE[ep.visibility] ?? this.VIS_BADGE.hidden
          wrap.append(U.el('div', { class: 'cat-ep-row' + (ep.visibility === 'public' ? '' : ' cat-ep-row-unpublished') }, [
            U.el('div', { class: 'cat-ep-num', text: '#' + ep.number }),
            U.el('div', { class: 'cat-ep-main' }, [
              U.el('div', { class: 'cat-ep-title', text: ep.title || `Episode ${ep.number}` }),
              U.el('div', { class: 'cat-ep-sub', text: [ep.duration ? ep.duration + ' min' : null, flags || null].filter(Boolean).join(' · ') || '—' })
            ]),
            U.el('span', { class: 'cat-badge ' + visClass, text: visLabel }),
            can('episode.edit')
              ? U.el('button', {
                class: 'btn btn-ghost btn-sm',
                title: ep.visibility === 'public' ? 'Take this episode down' : 'Make this episode watchable',
                onclick: async () => {
                  const next = ep.visibility === 'public' ? 'hidden' : 'public'
                  try {
                    await YumeAPI.admin.catalogue.updateEpisode(ep.id, { visibility: next })
                    U.toast(next === 'public' ? `Episode ${ep.number} published` : `Episode ${ep.number} taken down`)
                    load()
                  } catch (e) { U.toast(e.message, 'error') }
                }
              }, [document.createTextNode(ep.visibility === 'public' ? 'Unpublish' : 'Publish')])
              : null,
            // Published with nowhere to play from is the state worth shouting
            // about: from a viewer's side it is a broken link, and from here
            // it is invisible unless the row says so.
            ep.visibility === 'public' && !ep.source_count
              ? U.el('span', { class: 'cat-badge cat-badge-warn', title: 'Ez az epizód publikálva van, de nincs hozzá engedélyezett forrás.', text: 'nincs forrás' })
              : null,
            can('episode.edit')
              ? U.el('button', {
                class: 'btn btn-ghost btn-sm',
                title: 'Innen játszik le ez az epizód',
                onclick: () => this.sourcesModal(anime, ep, () => load())
              }, [document.createTextNode(`Sources${ep.source_total ? ` (${ep.source_count}/${ep.source_total})` : ''}`)])
              : null,
            can('episode.edit') ? U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.episodeModal(anime, ep, () => load()) }, [document.createTextNode('Szerkesztés')]) : null,
            can('episode.delete')
              ? U.el('button', {
                class: 'btn btn-ghost btn-sm cat-ep-del',
                onclick: async () => {
                  if (!confirm(`Delete episode ${ep.number}?`)) return
                  try { await YumeAPI.admin.catalogue.removeEpisode(ep.id); U.toast('Epizód törölve'); load() } catch (e) { U.toast(e.message, 'error') }
                }
              }, [document.createTextNode('✕')])
              : null
          ]))
        }
      } catch (e) { wrap.replaceChildren(P.errorState(e.message)) }
    }
    load()
  },

  /**
   * Where one episode plays from.
   *
   * `video_sources` has been in the schema since the beginning and nothing
   * ever wrote to it — it was built for an extension to fill. This is the
   * operator's side of it: any provider, in the order they choose, and a
   * switch that takes a dead link out of playback without losing the record
   * of which episode it belonged to.
   *
   * The platform stores references, never media.
   */
  SOURCE_KINDS: [
    ['http', 'Direct / HLS — an .mp4 or .m3u8 URL'],
    ['embed', 'Embed — a provider\u2019s player page'],
    ['torrent', 'Torrent — magnet link or info hash'],
    ['nzb', 'NZB']
  ],

  sourcesModal (anime, ep, onDone) {
    const list = U.el('div', { class: 'src-list' })
    const draft = { kind: 'http', ref: '', provider: '', resolution: '', variant: '', priority: '' }

    const field = (label, node) => U.el('label', { class: 'cat-field' }, [
      U.el('span', { class: 'cat-field-label', text: label }), node
    ])
    const select = (key, options) => U.el('select', {
      class: 'select',
      onchange: e => { draft[key] = e.target.value }
    }, options.map(([value, text]) => U.el('option', { value, text })))

    const refInput = U.el('input', {
      class: 'input',
      placeholder: 'https://…',
      oninput: e => { draft.ref = e.target.value }
    })

    const load = async () => {
      list.replaceChildren(P.spinner())
      try {
        const { data } = await YumeAPI.admin.catalogue.sources(ep.id)
        list.replaceChildren()
        if (!data.length) {
          list.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-3);', text: 'Még nincs forrás — ez az epizód nem játszható le.' }))
          return
        }
        for (const src of data) {
          list.append(U.el('div', { class: 'src-row' + (src.enabled ? '' : ' src-row-off') }, [
            U.el('div', { class: 'src-main' }, [
              U.el('div', { class: 'src-provider', text: src.provider || src.title || 'Unnamed source' }),
              // The reference itself, truncated by CSS rather than by JS: an
              // operator checking a link needs to see enough of it to
              // recognise it, and how much fits is the column's business.
              U.el('div', { class: 'src-ref', title: src.ref, text: src.ref })
            ]),
            U.el('span', { class: 'src-tag', text: [src.kind, src.resolution ? src.resolution + 'p' : null, src.variant].filter(Boolean).join(' · ') }),
            U.el('button', {
              class: 'btn btn-ghost btn-sm',
              title: src.enabled ? 'Take this source out of playback' : 'Put it back into playback',
              onclick: async () => {
                try {
                  await YumeAPI.admin.catalogue.updateSource(src.id, { enabled: !src.enabled })
                  await load()
                  onDone?.()
                } catch (e) { U.toast(e.message, 'error') }
              }
            }, [document.createTextNode(src.enabled ? 'Disable' : 'Enable')]),
            U.el('button', {
              class: 'btn btn-ghost btn-sm cat-ep-del',
              onclick: async () => {
                if (!confirm('Törlöd ezt a forrást?')) return
                try {
                  await YumeAPI.admin.catalogue.removeSource(src.id)
                  await load()
                  onDone?.()
                } catch (e) { U.toast(e.message, 'error') }
              }
            }, [document.createTextNode('✕')])
          ]))
        }
      } catch (e) {
        list.replaceChildren(P.errorState(e.message))
      }
    }

    // ---- skip intervals & subtitle tracks ----
    //
    // Same modal, because they answer the same question — what does this
    // episode need to play well — and splitting them across three screens
    // would mean three round trips to fix one episode.
    const extras = U.el('div')
    const loadExtras = async () => {
      extras.replaceChildren(P.spinner())
      try {
        const [{ data: skips }, { data: subs }] = await Promise.all([
          YumeAPI.admin.catalogue.skips(ep.id),
          YumeAPI.admin.catalogue.subtitles(ep.id)
        ])
        extras.replaceChildren()

        extras.append(U.el('h4', { class: 'src-add-title', text: 'Átugorható szakaszok' }))
        const skipList = U.el('div', { class: 'src-list' })
        if (!skips.length) {
          skipList.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-2);', text: 'Nincs — a lejátszó az AniSkipre támaszkodik.' }))
        }
        for (const seg of skips) {
          skipList.append(U.el('div', { class: 'src-row' }, [
            U.el('div', { class: 'src-main' }, [
              U.el('div', { class: 'src-provider', text: seg.kind }),
              U.el('div', { class: 'src-ref', text: `${this.clock(seg.start_sec)} → ${this.clock(seg.end_sec)}` })
            ]),
            U.el('span', { class: 'src-tag', text: seg.submitted_by ?? '' }),
            U.el('span', {}),
            U.el('button', {
              class: 'btn btn-ghost btn-sm cat-ep-del',
              onclick: async () => {
                try { await YumeAPI.admin.catalogue.removeSkip(seg.id); await loadExtras() } catch (e) { U.toast(e.message, 'error') }
              }
            }, [document.createTextNode('✕')])
          ]))
        }
        extras.append(skipList)

        const skipDraft = { kind: 'intro', start: '', end: '' }
        extras.append(U.el('div', { class: 'src-add-grid' }, [
          U.el('label', { class: 'cat-field' }, [
            U.el('span', { class: 'cat-field-label', text: 'Típus' }),
            U.el('select', { class: 'select', onchange: e => { skipDraft.kind = e.target.value } },
              ['intro', 'outro', 'recap', 'preview'].map(k => U.el('option', { value: k, text: k })))
          ]),
          U.el('label', { class: 'cat-field' }, [
            U.el('span', { class: 'cat-field-label', text: 'Kezdet (mp)' }),
            U.el('input', { class: 'input', type: 'number', step: '0.1', min: '0', oninput: e => { skipDraft.start = e.target.value } })
          ]),
          U.el('label', { class: 'cat-field' }, [
            U.el('span', { class: 'cat-field-label', text: 'Vége (mp)' }),
            U.el('input', { class: 'input', type: 'number', step: '0.1', min: '0', oninput: e => { skipDraft.end = e.target.value } })
          ]),
          U.el('button', {
            class: 'btn btn-secondary btn-sm',
            style: 'align-self:end;',
            onclick: async () => {
              try {
                await YumeAPI.admin.catalogue.addSkip(ep.id, {
                  kind: skipDraft.kind, start: Number(skipDraft.start), end: Number(skipDraft.end)
                })
                await loadExtras()
              } catch (e) { U.toast(e.message, 'error') }
            }
          }, [document.createTextNode('Szakasz hozzáadása')])
        ]))

        extras.append(U.el('h4', { class: 'src-add-title', text: 'Feliratsávok' }))
        const subList = U.el('div', { class: 'src-list' })
        if (!subs.length) {
          subList.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-2);', text: 'Itt nincs ilyen.' }))
        }
        for (const track of subs) {
          subList.append(U.el('div', { class: 'src-row' }, [
            U.el('div', { class: 'src-main' }, [
              U.el('div', { class: 'src-provider', text: `${String(track.language).toUpperCase()} · ${track.format}` }),
              U.el('div', { class: 'src-ref', title: track.url ?? track.object_key, text: track.url ?? track.object_key })
            ]),
            U.el('span', { class: 'src-tag', text: track.kind }),
            U.el('span', {}),
            U.el('button', {
              class: 'btn btn-ghost btn-sm cat-ep-del',
              onclick: async () => {
                try { await YumeAPI.admin.catalogue.removeSubtitle(track.id); await loadExtras() } catch (e) { U.toast(e.message, 'error') }
              }
            }, [document.createTextNode('✕')])
          ]))
        }
        extras.append(subList)

        const subDraft = { language: '', format: 'vtt', url: '' }
        extras.append(U.el('div', { class: 'src-add-grid' }, [
          U.el('label', { class: 'cat-field' }, [
            U.el('span', { class: 'cat-field-label', text: 'Nyelv' }),
            U.el('input', { class: 'input', placeholder: 'hu', oninput: e => { subDraft.language = e.target.value } })
          ]),
          U.el('label', { class: 'cat-field' }, [
            U.el('span', { class: 'cat-field-label', text: 'Formátum' }),
            U.el('select', { class: 'select', onchange: e => { subDraft.format = e.target.value } },
              ['vtt', 'srt', 'ass'].map(f => U.el('option', { value: f, text: f })))
          ]),
          U.el('label', { class: 'cat-field' }, [
            U.el('span', { class: 'cat-field-label', text: 'Cím (URL)' }),
            U.el('input', { class: 'input', placeholder: 'https://…', oninput: e => { subDraft.url = e.target.value } })
          ]),
          U.el('button', {
            class: 'btn btn-secondary btn-sm',
            style: 'align-self:end;',
            onclick: async () => {
              try {
                await YumeAPI.admin.catalogue.addSubtitle(ep.id, subDraft)
                await loadExtras()
              } catch (e) { U.toast(e.message, 'error') }
            }
          }, [document.createTextNode('Sáv hozzáadása')])
        ]))
      } catch (e) {
        extras.replaceChildren(P.errorState(e.message))
      }
    }

    const backdrop = AdminModals.modalShell(`Playback — ${anime.canonical_title}, episode ${Number(ep.number)}`, [
      list,
      U.el('h4', { class: 'src-add-title', text: 'Forrás hozzáadása' }),
      field('Típus', select('kind', this.SOURCE_KINDS)),
      field('Hivatkozás', refInput),
      U.el('div', { class: 'src-add-grid' }, [
        field('Szolgáltató', U.el('input', { class: 'input', placeholder: 'A látogatóknak látszik', oninput: e => { draft.provider = e.target.value } })),
        field('Felbontás', select('resolution', [['', '—'], ['2160', '2160p'], ['1080', '1080p'], ['720', '720p'], ['540', '540p'], ['480', '480p']])),
        field('Hang', select('variant', [['', '—'], ['sub', 'Feliratos'], ['dub', 'Szinkronos'], ['raw', 'Nyers']])),
        field('Prioritás', U.el('input', { class: 'input', type: 'number', placeholder: '0', oninput: e => { draft.priority = e.target.value } }))
      ]),
      U.el('p', { class: 'src-note', text: 'Az alacsonyabb prioritás kerül előbb sorra. A rendszer csak a hivatkozást tárolja — a videót soha.' }),
      extras
    ], async () => {
      if (!draft.ref.trim()) { U.toast('A hivatkozás kötelező', 'error'); return }
      try {
        await YumeAPI.admin.catalogue.addSource(ep.id, {
          kind: draft.kind,
          ref: draft.ref.trim(),
          ...(draft.provider.trim() ? { provider: draft.provider.trim() } : {}),
          ...(draft.resolution ? { resolution: draft.resolution } : {}),
          ...(draft.variant ? { variant: draft.variant } : {}),
          ...(draft.priority !== '' ? { priority: Number(draft.priority) } : {})
        })
        U.toast('Forrás hozzáadva')
        draft.ref = ''
        refInput.value = ''
        await load()
        onDone?.()
      } catch (e) { U.toast(e.message, 'error') }
    })
    load()
    loadExtras()
    return backdrop
  },

  /** Seconds → m:ss, for an interval an operator reads off a player. */
  clock (seconds) {
    const total = Math.round(Number(seconds) || 0)
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  },

  episodeModal (anime, ep, onDone) {
    const isNew = !ep
    const d = {
      number: ep?.number ?? '',
      title: ep?.title ?? '',
      synopsis: ep?.synopsis ?? '',
      duration: ep?.duration ?? '',
      is_filler: ep?.is_filler ?? false,
      is_recap: ep?.is_recap ?? false,
      air_date: ep?.air_date ? String(ep.air_date).slice(0, 10) : ''
    }
    const inp = (key, attrs = {}) => U.el('input', { class: 'input', value: d[key], oninput: e => { d[key] = e.target.value }, ...attrs })
    const check = (key, label) => U.el('label', { class: 'cat-check' }, [
      U.el('input', { type: 'checkbox', ...(d[key] ? { checked: '' } : {}), onchange: e => { d[key] = e.target.checked } }), U.el('span', { text: label })
    ])
    const labelled = (t, el) => U.el('label', { class: 'cat-field' }, [U.el('span', { class: 'cat-field-label', text: t }), el])

    const backdrop = AdminModals.modalShell(isNew ? `Add episode — ${anime.canonical_title}` : `Edit episode ${ep.number}`, [
      labelled('Episode number', inp('number', { type: 'number', step: '0.5', min: 0, placeholder: 'e.g. 1 or 6.5' })),
      labelled('Title', inp('title', { placeholder: 'Epizódcím (nem kötelező)' })),
      labelled('Air date', inp('air_date', { type: 'date' })),
      labelled('Duration (min)', inp('duration', { type: 'number', min: 0 })),
      labelled('Synopsis', U.el('textarea', { class: 'input', rows: 3, oninput: e => { d.synopsis = e.target.value } }, [document.createTextNode(d.synopsis)])),
      U.el('div', { style: 'display:flex;gap:var(--space-4);' }, [check('is_filler', 'Filler'), check('is_recap', 'Recap')])
    ], async () => {
      if (d.number === '' || isNaN(Number(d.number))) return U.toast('Érvényes epizódszám kell', 'error')
      const num = v => v === '' || v == null ? null : Number(v)
      const body = {
        number: Number(d.number),
        title: d.title.trim() || null,
        synopsis: d.synopsis.trim() || null,
        duration: num(d.duration),
        is_filler: d.is_filler,
        is_recap: d.is_recap,
        air_date: d.air_date ? new Date(d.air_date).toISOString() : null
      }
      try {
        if (isNew) await YumeAPI.admin.catalogue.addEpisode(anime.id, body)
        else await YumeAPI.admin.catalogue.updateEpisode(ep.id, body)
        U.toast(isNew ? 'Episode added' : 'Episode updated'); backdrop.close(); onDone?.()
      } catch (e) { U.toast(e.message, 'error') }
    })
  }
}
