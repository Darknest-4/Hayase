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
   */
  field (label, control, { hint = null, error = null } = {}) {
    if (error) control.setAttribute('aria-invalid', 'true')
    return U.el('label', { class: 'field' }, [
      label ? U.el('span', { class: 'field-label', text: label }) : null,
      control,
      error ? U.el('span', { class: 'field-error', text: error }) : null,
      !error && hint ? U.el('span', { class: 'field-hint', text: hint }) : null
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
   * items: [{ id, label, icon? }]. onSelect receives the id. The selected tab
   * is marked with aria-selected rather than a class, so the control reads
   * correctly to assistive technology and styles itself from the same fact.
   */
  tabs (items, { selected = null, onSelect = () => {} } = {}) {
    const bar = U.el('div', { class: 'tabs', role: 'tablist' })
    const buttons = items.map(item => {
      const btn = U.el('button', {
        class: 'tab',
        type: 'button',
        role: 'tab',
        'aria-selected': String(item.id === selected),
        disabled: item.disabled ?? false,
        onclick: () => {
          for (const b of buttons) b.setAttribute('aria-selected', String(b === btn))
          onSelect(item.id)
        }
      }, [item.icon ?? null, U.el('span', { text: item.label })])
      return btn
    })
    bar.append(...buttons)
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
    return U.el('div', { class: cx('spinner', small && 'spinner-sm'), role: 'status', 'aria-label': 'Loading' })
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

  emptyState (message, { action = null } = {}) {
    return U.el('div', { class: 'empty-state' }, [
      U.el('span', { text: message }),
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
      U.el('span', { text: message }),
      detail ? U.el('div', { class: 'error-state-detail', text: detail }) : null,
      action ? U.el('div', { class: 'error-state-action' }, [action]) : null
    ])
  }
}
