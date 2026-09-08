// Just enough browser for a client module to be imported by node --test.
//
// The client used to be classic scripts, so every test built a `vm` context,
// ran the file source inside it and picked the global back out. That worked
// only because the files were not modules; now that they are, a test imports
// them like anything else — and the stubs have to be on `globalThis` before
// the import, because a module can touch `localStorage` or `matchMedia` while
// it is still evaluating.
//
// One shared stub rather than thirteen copies. The old approach forced each
// test to reproduce whatever DOM the file under test happened to reach for,
// and they had quietly drifted: three of them stubbed `matchMedia`, the rest
// did not, and which ones needed it was decided by import order.
//
// `install()` is idempotent and returns the pieces a test may want to inspect
// or replace — the storage map especially, since several suites are about what
// is persisted.

/** A DOM node that answers anything asked of it and records what it was given. */
export function element (tag = 'div') {
  const attrs = new Map()
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    hidden: false,
    style: { cssText: '', setProperty () {}, removeProperty () {} },
    dataset: {},
    listeners: {},
    children: [],
    classList: { add () {}, remove () {}, toggle () {}, contains: () => false },
    setAttribute (k, v) { attrs.set(k, String(v)) },
    getAttribute (k) { return attrs.has(k) ? attrs.get(k) : null },
    removeAttribute (k) { attrs.delete(k) },
    hasAttribute (k) { return attrs.has(k) },
    addEventListener (type, fn) { this.listeners[type] = fn },
    removeEventListener () {},
    append (...kids) { this.children.push(...kids) },
    prepend (...kids) { this.children.unshift(...kids) },
    replaceChildren (...kids) { this.children = kids },
    remove () {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    focus () {},
    blur () {},
    click () {},
    scrollTo () {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 })
  }
  return node
}

/** An in-memory Storage, with the map exposed so a test can read what landed. */
export function storage () {
  const map = new Map()
  return {
    map,
    getItem: key => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem: (key, value) => { map.set(String(key), String(value)) },
    removeItem: key => { map.delete(String(key)) },
    clear: () => map.clear(),
    key: i => [...map.keys()][i] ?? null,
    get length () { return map.size }
  }
}

/**
 * Put a browser on globalThis. Call before importing anything from js/.
 *
 * `overrides` replaces or adds any global — a test that cares about fetch or
 * about `location` passes its own and leaves the rest alone.
 */
export function install (overrides = {}) {
  const local = storage()
  const session = storage()

  const doc = {
    createElement: tag => element(tag),
    createTextNode: text => ({ textContent: String(text) }),
    createDocumentFragment: () => element('fragment'),
    getElementById: () => element(),
    querySelector: () => element(),
    querySelectorAll: () => [],
    addEventListener () {},
    removeEventListener () {},
    documentElement: element('html'),
    body: element('body'),
    head: element('head'),
    activeElement: null,
    hidden: false,
    title: ''
  }

  const base = {
    document: doc,
    localStorage: local,
    sessionStorage: session,
    matchMedia: () => ({ matches: false, addEventListener () {}, removeEventListener () {} }),
    requestAnimationFrame: fn => { fn(0); return 0 },
    cancelAnimationFrame () {},
    fetch: async () => ({ ok: false, status: 503, headers: { get: () => null }, json: async () => ({}), text: async () => '' }),
    location: { href: 'http://localhost/', origin: 'http://localhost', pathname: '/', search: '', hash: '', replace () {}, assign () {} },
    history: { replaceState () {}, pushState () {}, back () {} },
    navigator: { language: 'en', languages: ['en'], onLine: true, clipboard: { writeText: async () => {} } },
    WebSocket: class { constructor () { this.readyState = 0 } close () {} send () {} addEventListener () {} },
    MutationObserver: class { observe () {} disconnect () {} },
    IntersectionObserver: class { observe () {} disconnect () {} unobserve () {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    HTMLElement: class {},
    alert () {},
    confirm: () => true,
    scrollTo () {},
    innerWidth: 1280,
    innerHeight: 800,
    // `window` is globalThis here, and globalThis has no event target of its
    // own — App.init() and several modules register listeners on it.
    addEventListener () {},
    removeEventListener () {},
    dispatchEvent: () => true,
    ...overrides
  }

  for (const [key, value] of Object.entries(base)) {
    // navigator and a few others are getter-only on globalThis in Node, so a
    // plain assignment throws rather than shadowing them.
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  // The client reads both `window.x` and bare `x`; making them the same object
  // means a stub only has to be installed once.
  Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true, writable: true })

  return { document: doc, localStorage: local, sessionStorage: session, window: globalThis }
}
