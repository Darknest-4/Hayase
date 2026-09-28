// The primitives, as functions.
//
// components.css defines what each one looks like; this defines what each one
// is. Both halves matter: a class name alone is a convention, and a convention
// is what produced eleven button classes, thirty-six badge variants and 1718
// hand-built elements against 73 shared calls.
//
// These are deliberately thin. A primitive takes the content and the few
// choices that change its meaning — a variant, a size, a disabled flag — and
// returns an element. It does not fetch, does not know a route and does not
// reach for the catalogue; anything that does belongs in components.js with
// the card and the spotlight, or in the screen itself.
//
// Every control here answers for the five states in the brief. Three of them
// are settled by attributes the browser already understands — `disabled`,
// `aria-selected`, `aria-current` — rather than by a class, so a screen can
// toggle a state without knowing this file's naming. Focus is the global
// :focus-visible ring from tokens.css and is not restated.

import { I18n } from '../i18n/i18n.js'
import { U } from '../lib/dom.js'

/** Join class names, dropping the ones that did not apply. */
const cx = (...parts) => parts.filter(Boolean).join(' ')

export const P = {
  /**
   * Button.
   *
   *   P.button('Save', { variant: 'primary', onclick: save })
   *   P.button('Delete', { variant: 'danger', loading: true })
   *
   * `loading` blanks the label and spins in its place, which is why the label
   * is kept in the DOM rather than replaced: the button must not change width
   * mid-request, or the pointer ends up over whatever moved under it.
   */
  button (label, { variant = 'secondary', size = null, loading = false, disabled = false, type = 'button', ...rest } = {}) {
    return U.el('button', {
      class: cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm'),
      type,
      disabled: disabled || loading,
      ...(loading ? { dataset: { loading: '1' }, 'aria-busy': 'true' } : {}),
      text: typeof label === 'string' ? label : null,
      ...rest
    }, typeof label === 'string' ? [] : label)
  },

  /**
   * IconButton — a control whose whole label is a glyph.
   *
   * `label` is not optional and is not decoration: with no text node, it is
   * the only thing a screen reader has to announce.
   */
  iconButton (icon, label, { size = null, media = false, disabled = false, ...rest } = {}) {
    return U.el('button', {
      class: cx('icon-btn', size && `icon-btn-${size}`, media && 'icon-btn-media'),
      type: 'button',
      'aria-label': label,
      title: label,
      disabled,
      ...rest
    }, [icon])
  },

  /** A generic panel. `.card` is this product's anime cover card; this is the plain surface. */
  surface (children, { size = null, flush = false, interactive = false, ...rest } = {}) {
    return U.el('div', {
      class: cx('surface', size === 'lg' && 'surface-lg', flush && 'surface-flush', interactive && 'surface-interactive'),
      ...rest
    }, children)
  },

  badge (text, { variant = null, href = null, ...rest } = {}) {
    return U.el(href ? 'a' : 'span', {
      class: cx('badge', variant && `badge-${variant}`),
      ...(href ? { href } : {}),
      text,
      ...rest
    })
  },

  avatar (letterOrImg, { size = 'sm', ...rest } = {}) {
    const node = U.el('span', { class: cx('avatar', `avatar-${size}`), ...rest })
    if (typeof letterOrImg === 'string') node.textContent = letterOrImg
    else if (letterOrImg) node.append(letterOrImg)
    return node
  },

  /**
   * A labelled form control.
   *
   * The label, the hint and the error are one call because they are one
   * thing: a field with its error rendered somewhere else is a field whose
   * error can be forgotten. `error` also sets aria-invalid, so the state is
   * announced and not only coloured.
   *
   * A <div> with <label for>, not a wrapping <label>: the control may come
   * with a button of its own (the password field's "show"), and a label may
   * hold only the one control it names.
   */
  field (label, control, { hint = null, error = null } = {}) {
    const input = /^(INPUT|SELECT|TEXTAREA)$/.test(String(control?.tagName ?? ''))
      ? control
      : control?.querySelector?.('input') ?? control?.querySelector?.('select') ?? control?.querySelector?.('textarea') ?? null
    let id = input?.getAttribute?.('id') ?? null
    if (input && !id) {
      id = 'f-' + Math.random().toString(36).slice(2, 9)
      input.setAttribute('id', id)
    }
    const hintId = hint && !error && id ? `${id}-hint` : null
    if (hintId) {
      input.setAttribute('aria-describedby', hintId)
      if (input.dataset) input.dataset.hintId = hintId
    }
    if (error) control.setAttribute('aria-invalid', 'true')
    return U.el('div', { class: 'field' }, [
      label ? U.el('label', { class: 'field-label', ...(id ? { for: id } : {}), text: label }) : null,
      control,
      error ? U.el('span', { class: 'field-error', text: error }) : null,
      hintId ? U.el('span', { class: 'field-hint', id: hintId, text: hint }) : null
    ])
  },

  input ({ type = 'text', ...rest } = {}) {
    return U.el('input', { class: 'input', type, ...rest })
  },

  textarea (rest = {}) {
    return U.el('textarea', { class: 'textarea', ...rest })
  },

  /** options: [[value, label], ...] or [{ value, label }] */
  select (options, { value = null, ...rest } = {}) {
    const node = U.el('select', { class: 'select', ...rest })
    for (const opt of options) {
      const [v, l] = Array.isArray(opt) ? opt : [opt.value, opt.label]
      node.append(U.el('option', { value: v, text: l, selected: String(v) === String(value) }))
    }
    return node
  },

  checkbox (label, { checked = false, disabled = false, ...rest } = {}) {
    return U.el('label', { class: 'checkbox' }, [
      U.el('input', { type: 'checkbox', checked, disabled, ...rest }),
      label ? U.el('span', { text: label }) : null
    ])
  },

  switch_ (label, { checked = false, disabled = false, ...rest } = {}) {
    return U.el('label', { class: 'switch' }, [
      U.el('input', { type: 'checkbox', role: 'switch', checked, disabled, ...rest }),
      label ? U.el('span', { text: label }) : null
    ])
  },

  /**
   * Tabs.
   *
   * items: [{ id, label, icon?, count?, disabled? }]. onSelect receives the id.
   * The selected tab is marked with aria-selected rather than a class, so the
   * control reads correctly to assistive technology and styles itself from
   * the same fact.
   *
   * The keyboard pattern is the one a screen-reader user expects from a
   * tablist: one Tab stop for the whole row (roving tabindex), the arrow keys
   * move between tabs, Home and End jump to the ends. `bar.panel` is the
   * matching tabpanel; the caller puts it where the content goes.
   */
  tabs (items, { selected = null, onSelect = () => {}, label = null, controls = null } = {}) {
    const prefix = 'tabs-' + Math.random().toString(36).slice(2, 9)
    const bar = U.el('div', { class: 'tabs', role: 'tablist', ...(label ? { 'aria-label': label } : {}) })
    const panel = U.el('div', { class: 'tab-panel', role: 'tabpanel', id: `${prefix}-panel`, tabindex: '0' })
    const idOf = id => `${prefix}-${String(id).replace(/[^\w-]/g, '_')}`
    const buttons = items.map(item => U.el('button', {
      class: 'tab',
      type: 'button',
      role: 'tab',
      id: idOf(item.id),
      dataset: { tab: String(item.id) },
      // A panel azonosítója — vagy a hívóé, ha a fülek egy meglévő
      // tartalomrészt váltanak (a belépési űrlap mezőit).
      'aria-controls': controls ?? panel.id,
      'aria-selected': String(item.id === selected),
      tabindex: item.id === selected ? '0' : '-1',
      disabled: item.disabled ?? false,
      onclick: () => choose(item.id)
    }, [
      item.icon ?? null,
      U.el('span', { text: item.label }),
      item.count != null ? U.el('span', { class: 'tab-count', text: String(item.count) }) : null
    ]))
    const choose = (id, { focus = false, silent = false } = {}) => {
      for (const b of buttons) {
        const on = b.dataset.tab === String(id)
        b.setAttribute('aria-selected', String(on))
        b.tabIndex = on ? 0 : -1
        if (on) {
          panel.setAttribute('aria-labelledby', b.id)
          if (focus) b.focus()
        }
      }
      // A fókusz magától görget; a cím szerinti kiválasztásnak segíteni kell.
      if (!focus) U.revealActiveTab(bar)
      if (!silent) onSelect(id)
    }
    bar.addEventListener('keydown', e => {
      const enabled = buttons.filter(b => !b.disabled)
      const at = enabled.indexOf(document.activeElement)
      if (at < 0) return
      const next = {
        ArrowRight: enabled[(at + 1) % enabled.length],
        ArrowLeft: enabled[(at - 1 + enabled.length) % enabled.length],
        Home: enabled[0],
        End: enabled[enabled.length - 1]
      }[e.key]
      if (!next) return
      e.preventDefault()
      choose(next.dataset.tab, { focus: true })
    })
    bar.append(...buttons)
    if (selected != null) choose(selected, { silent: true })
    bar.panel = panel
    // Programmatic selection (a deep link, a restored state) without firing
    // onSelect twice.
    bar.select = (id, options) => choose(id, options)
    return bar
  },

  /** Backdrop + panel. Returns the backdrop; `onClose` fires on backdrop click and Escape. */
  dialog (title, body, { actions = null, onClose = null, width = null } = {}) {
    const panel = U.el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', ...(width ? { style: `width:${width}` } : {}) }, [
      title ? U.el('div', { class: 'dialog-head' }, [U.el('span', { text: title })]) : null,
      U.el('div', { class: 'dialog-body' }, body),
      actions ? U.el('div', { class: 'dialog-foot' }, actions) : null
    ])
    const backdrop = U.el('div', { class: 'modal-backdrop' }, [panel])
    if (onClose) {
      backdrop.addEventListener('click', e => { if (e.target === backdrop) onClose() })
      backdrop.addEventListener('keydown', e => { if (e.key === 'Escape') onClose() })
    }
    return backdrop
  },

  /** items: [{ label, onSelect, disabled }] or the string '-' for a separator. */
  dropdown (trigger, items, { align = 'start' } = {}) {
    const menu = U.el('div', { class: align === 'end' ? 'dropdown-menu dropdown-menu-end' : 'dropdown-menu', hidden: true, role: 'menu' })
    for (const item of items) {
      if (item === '-') { menu.append(U.el('div', { class: 'dropdown-sep' })); continue }
      menu.append(U.el('button', {
        class: 'dropdown-item',
        type: 'button',
        role: 'menuitem',
        disabled: item.disabled ?? false,
        text: item.label,
        onclick: () => { menu.hidden = true; item.onSelect?.() }
      }))
    }
    trigger.addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden })
    // One document listener per dropdown would accumulate; this one is cheap
    // and removes itself with the element because it closes over `menu` only.
    document.addEventListener('click', () => { menu.hidden = true })
    return U.el('div', { class: 'dropdown' }, [trigger, menu])
  },

  /**
   * Skeleton.
   *
   * `shape` picks a silhouette rather than a size, because the point of a
   * skeleton is to be the shape of what is coming. A generic grey box is what
   * this replaces.
   */
  skeleton (shape = 'text', { width = null, height = null } = {}) {
    const style = [width && `width:${width}`, height && `height:${height}`].filter(Boolean).join(';')
    return U.el('div', { class: cx('skeleton', `skel-${shape}`), ...(style ? { style } : {}) })
  },

  /** A row of skeleton lines shaped like a list item: avatar, title, one short line. */
  skeletonRow () {
    return U.el('div', { class: 'skel-row' }, [
      U.el('div', { class: 'skeleton skel-avatar' }),
      U.el('div', { class: 'skel-row-body' }, [
        U.el('div', { class: 'skeleton skel-text skel-line-mid' }),
        U.el('div', { class: 'skeleton skel-text skel-text-sm skel-line-short' })
      ])
    ])
  },

  spinner ({ small = false } = {}) {
    return U.el('div', { class: cx('spinner', small && 'spinner-sm'), role: 'status', 'aria-label': I18n.t('Loading') })
  },

  /**
   * Pagination.
   *
   * `total` is a page count, `current` is 1-based. Long runs collapse to
   * first / neighbours / last with gaps, so the control does not grow with
   * the catalogue.
   */
  pagination (current, total, onGo) {
    if (!(total > 1)) return null
    const wrap = U.el('nav', { class: 'pagination', 'aria-label': 'Pagination' })
    const page = n => U.el('button', {
      class: 'pagination-page',
      type: 'button',
      text: String(n),
      ...(n === current ? { 'aria-current': 'page' } : {}),
      onclick: () => n !== current && onGo(n)
    })
    const gap = () => U.el('span', { class: 'pagination-gap', text: '…' })
    const nums = new Set([1, total, current, current - 1, current + 1])
    const shown = [...nums].filter(n => n >= 1 && n <= total).sort((a, b) => a - b)

    wrap.append(U.el('button', {
      class: 'pagination-page',
      type: 'button',
      text: '‹',
      'aria-label': 'Previous',
      disabled: current <= 1,
      onclick: () => onGo(current - 1)
    }))
    let last = 0
    for (const n of shown) {
      if (n - last > 1) wrap.append(gap())
      wrap.append(page(n))
      last = n
    }
    wrap.append(U.el('button', {
      class: 'pagination-page',
      type: 'button',
      text: '›',
      'aria-label': 'Next',
      disabled: current >= total,
      onclick: () => onGo(current + 1)
    }))
    return wrap
  },

  /**
   * Table.
   *
   * columns: [{ key, label, num?, render? }]. Every cell carries data-label,
   * which is what lets the same markup become a stack of cards below 720px
   * instead of something to be scrolled sideways — see components.css.
   */
  table (columns, rows, { stack = true } = {}) {
    return U.el('table', { class: cx('table', stack && 'table-stack') }, [
      U.el('thead', {}, [U.el('tr', {}, columns.map(c =>
        U.el('th', { class: c.num ? 'table-num' : null, text: c.label })))]),
      U.el('tbody', {}, rows.map(row => U.el('tr', {}, columns.map(c => {
        const value = c.render ? c.render(row) : row[c.key]
        return U.el('td', {
          class: c.num ? 'table-num' : null,
          dataset: { label: c.label },
          ...(typeof value === 'string' || typeof value === 'number' ? { text: String(value) } : {})
        }, typeof value === 'object' && value !== null ? [value] : [])
      }))))
    ])
  },

  /**
   * EmptyState.
   *
   * `message` alone is the old one-line form. With a `title` the message
   * becomes the explanation under it, and `icon` (SVG path data) sits on top:
   * an empty list should say what is missing and what to do about it, not
   * only that it is empty.
   */
  emptyState (message, { title = null, icon = null, action = null } = {}) {
    return U.el('div', { class: 'empty-state' }, [
      icon ? U.el('span', { class: 'empty-state-icon', 'aria-hidden': 'true' }, [U.svg(icon, 24)]) : null,
      title ? U.el('p', { class: 'empty-state-title', text: title }) : null,
      U.el(title ? 'p' : 'span', { class: title ? 'empty-state-text' : null, text: message }),
      action ? U.el('div', { class: 'empty-state-action' }, [action]) : null
    ])
  },

  /**
   * ErrorState.
   *
   * `detail` is for what actually went wrong and is optional, because the
   * screens that had no error path at all — dashboard, profile, analytics,
   * history — need somewhere to put a failure before they need it to be good.
   */
  errorState (message, { detail = null, action = null } = {}) {
    return U.el('div', { class: 'error-state', role: 'alert' }, [
      U.el('span', { class: 'error-state-icon', 'aria-hidden': 'true' }, [
        U.svg('<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>', 22)
      ]),
      U.el('span', { class: 'error-state-msg', text: message }),
      detail ? U.el('div', { class: 'error-state-detail', text: detail }) : null,
      action ? U.el('div', { class: 'error-state-action' }, [action]) : null
    ])
  }
}
