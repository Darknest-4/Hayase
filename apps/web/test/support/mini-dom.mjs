// Egy kicsi, de VALÓDI DOM a lejátszó felületének tesztjeihez.
//
// A közös `browser.mjs` csonkja erre nem elég, és szándékosan: az egyetlen
// figyelőt tárol eseménytípusonként, a `classList` metódusai pedig üresek. Egy
// olyan felület, aminek a lényege a „hány figyelő fut le" és a „melyik osztály
// van rajta", azzal a csonkkal nem tesztelhető — minden állítás átmenne.
//
// Amit ez tud, és amiért megéri: több figyelő típusonként, működő `classList`,
// `querySelector` osztályra és elemnévre, és annyi `innerHTML`-elemzés,
// amennyivel a lejátszó moduljai maguk is dolgoznak (ők írják, ők olvassák
// vissza `querySelector`-ral).
//
// Amit NEM tud: elrendezés, öröklődés, CSS. Ezekre nem is állít semmit egyik
// teszt sem.

class MiniNode {
  constructor (tag, ownerDocument) {
    this.tagName = String(tag).toUpperCase()
    this.ownerDocument = ownerDocument
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.listeners = new Map()
    this.dataset = {}
    this.disabled = false
    this.hidden = false
    this.type = ''
    this.title = ''
    this.tabIndex = 0
    this._text = ''
    this._style = new Map()
    this.style = {
      setProperty: (name, value) => this._style.set(name, String(value)),
      removeProperty: (name) => this._style.delete(name),
      getPropertyValue: (name) => this._style.get(name) ?? ''
    }
    // A `style.width = '50%'` írásmód is kell: a modulok ezt használják.
    for (const name of ['width', 'height', 'left', 'top', 'visibility', 'cssText']) {
      Object.defineProperty(this.style, name, {
        get: () => this._style.get(name) ?? '',
        set: (value) => this._style.set(name, String(value)),
        enumerable: true
      })
    }
    this.classList = {
      add: (...names) => this.#classes(set => names.forEach(n => set.add(n))),
      remove: (...names) => this.#classes(set => names.forEach(n => set.delete(n))),
      toggle: (name, force) => this.#classes(set => {
        const on = force === undefined ? !set.has(name) : !!force
        if (on) set.add(name); else set.delete(name)
      }),
      contains: (name) => this.#classSet().has(name)
    }
  }

  #classSet () { return new Set(String(this.className || '').split(/\s+/).filter(Boolean)) }
  #classes (mutate) {
    const set = this.#classSet()
    mutate(set)
    this.className = [...set].join(' ')
  }

  get className () { return this.attributes.get('class') ?? '' }
  set className (value) { this.attributes.set('class', String(value)) }

  get textContent () {
    if (this.children.length) return this.children.map(c => c.textContent ?? '').join('')
    return this._text
  }

  set textContent (value) {
    this.children = []
    this._text = String(value ?? '')
  }

  get innerHTML () { return this._html ?? '' }
  set innerHTML (html) {
    this._html = String(html ?? '')
    this._text = ''
    this.children = parseHtml(String(html ?? ''), this.ownerDocument, this)
  }

  setAttribute (name, value) {
    this.attributes.set(name, String(value))
    if (name === 'class') return
    if (name === 'tabindex') this.tabIndex = Number(value)
  }

  getAttribute (name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  removeAttribute (name) { this.attributes.delete(name) }
  hasAttribute (name) { return this.attributes.has(name) }

  addEventListener (type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }

  removeEventListener (type, fn) {
    const list = this.listeners.get(type)
    if (list) this.listeners.set(type, list.filter(f => f !== fn))
  }

  /** Egy esemény lefuttatása. Nem buborékol: a tesztek célzottan küldenek. */
  fire (type, event = {}) {
    const payload = { type, target: this, preventDefault () {}, stopPropagation () {}, ...event }
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(payload)
    return payload
  }

  /**
   * A NEM-CSOMÓPONT ARGUMENTUM SZÖVEGGÉ VÁLIK — ahogy a böngészőben.
   *
   * A csonk korábban `if (kid == null) continue`-val ELNYELTE a `null`-t. Ez
   * kényelmesnek tűnt, és pontosan az ellenkezője annak, amit a valódi DOM
   * csinál: a `ParentNode.append()` és a `replaceChildren()` minden nem-Node
   * argumentumot sztringgé alakít, tehát a `null`-ból egy „null" feliratú
   * szövegcsomópont lesz.
   *
   * Ettől a csonktól egy egész hibaosztály LÁTHATATLAN volt: az éles
   * belépőlapon hónapokig ott állt egy „null" a jelszómező alatt, a mini-DOM
   * pedig ugyanarra a kódra tiszta lapot mutatott. A csonk hazudott, és a
   * teszt elhitte.
   *
   * Innentől ami a böngészőben kiíródik, az itt is kiíródik.
   */
  _beszur (kid) {
    /*
     * A HATÁR A PRIMITÍVNÉL VAN, nem a „Node-nak látszik"-nál.
     *
     * Első nekifutásra azt néztem, van-e a kapott dolognak `nodeType`-ja vagy
     * `children`-je — és a lejátszó tesztje azonnal elhasalt tőle, mert ott a
     * videóelem egy DUCK-TYPED sima objektum, aminek egyik sincs. A csonkba
     * kerülő hamis elemek pont ilyenek.
     *
     * Objektum tehát mindig csomópont. Ami primitív — `null`, `undefined`,
     * szám, sztring —, abból szövegcsomópont lesz, ahogy a böngészőben.
     */
    if (kid !== null && typeof kid === 'object') return kid
    return { nodeType: 3, textContent: String(kid), parentNode: null, children: [] }
  }

  append (...kids) {
    for (const raw of kids) {
      const kid = this._beszur(raw)
      kid.parentNode = this
      this.children.push(kid)
    }
  }

  prepend (...kids) {
    const real = kids.map(k => this._beszur(k))
    for (const kid of real) kid.parentNode = this
    this.children.unshift(...real)
  }

  /**
   * A valódi DOM-ban a `parentNode` és a `parentElement` külön tulajdonság,
   * és a kód hol egyiket, hol másikat használja. Csak az egyiket megadni
   * olyan csonk, ami CSENDBEN mást csinál, mint a böngésző — a kislejátszó
   * helyőrzője pont ezért nem került be sehova.
   */
  get parentElement () { return this.parentNode ?? null }

  insertBefore (node, reference) {
    if (!node) return node
    node.parentNode = this
    const at = this.children.indexOf(reference)
    if (at === -1) this.children.push(node)
    else this.children.splice(at, 0, node)
    return node
  }

  replaceChildren (...kids) {
    this.children = []
    this._text = ''
    this.append(...kids)
  }

  remove () {
    if (!this.parentNode) return
    this.parentNode.children = this.parentNode.children.filter(c => c !== this)
    this.parentNode = null
  }

  /**
   * Benne van-e ez a csomópont a részfában.
   *
   * A valódi DOM-ban egy elem ÖNMAGÁT is tartalmazza, és ez nem apróság: a
   * lapok ezzel a hívással veszik észre, hogy kikerültek a dokumentumból, és
   * ilyenkor szerelik le magukat (időzítők, idegen iframe-ek). Enélkül a
   * csonk kivételt dobna, és a takarítás tesztje nem is létezhetne.
   */
  contains (node) {
    if (node === this) return true
    for (const kid of this.walk()) if (kid === node) return true
    return false
  }

  /** Minden leszármazott, mélységi sorrendben. */
  * walk () {
    for (const kid of this.children) {
      if (!(kid instanceof MiniNode)) continue
      yield kid
      yield * kid.walk()
    }
  }

  matches (selector) { return matchesSelector(this, selector) }
  querySelector (selector) {
    for (const node of this.walk()) if (matchesSelector(node, selector)) return node
    return null
  }

  querySelectorAll (selector) {
    const found = []
    for (const node of this.walk()) if (matchesSelector(node, selector)) found.push(node)
    return found
  }

  closest (selector) {
    let node = this
    while (node) {
      if (matchesSelector(node, selector)) return node
      node = node.parentNode
    }
    return null
  }

  getBoundingClientRect () { return this.rect ?? { left: 0, top: 0, width: 400, height: 225, right: 400, bottom: 225 } }
  setPointerCapture () {}
  releasePointerCapture () {}
  focus () { this.ownerDocument.activeElement = this }
  blur () {}
  click () { this.fire('click') }
}

/**
 * A szelektorok, amiket a lejátszó használ: `.osztály`, `elem`, `[attr]`,
 * vesszős lista, és a szóközzel elválasztott leszármazott (`.a span`).
 */
function matchesSelector (node, selector) {
  return String(selector).split(',').map(s => s.trim()).filter(Boolean).some(alternative => {
    // Jobbról balra: az utolsó rész magára a csomópontra illik, a többi
    // valamelyik felmenőjére — ez a böngésző saját sorrendje is.
    const parts = alternative.split(/\s+/).filter(Boolean).reverse()
    if (!matchesSimple(node, parts[0])) return false
    let ancestor = node.parentNode
    for (const part of parts.slice(1)) {
      while (ancestor && !matchesSimple(ancestor, part)) ancestor = ancestor.parentNode
      if (!ancestor) return false
      ancestor = ancestor.parentNode
    }
    return true
  })
}

function matchesSimple (node, part) {
  if (!node || !part) return false
  if (part.startsWith('.')) return node.classList.contains(part.slice(1))
  if (part.startsWith('[')) return node.hasAttribute(part.slice(1, -1))
  return node.tagName === part.toUpperCase()
}

/**
 * Elég HTML-elemzés a lejátszó saját sablonjaihoz.
 *
 * Nyitó- és zárócímkék, attribútumok, szöveg. Nincs benne hibajavítás és
 * nincsenek önmagukat záró kivételek a `<path>`-on és társain kívül — a
 * lejátszó egyetlen sablonja sem kér többet.
 */
function parseHtml (html, ownerDocument, parent) {
  const VOID = new Set(['PATH', 'CIRCLE', 'RECT', 'IMG', 'BR', 'INPUT', 'HR'])
  const roots = []
  const stack = []
  const token = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*?)?)\/?>|([^<]+)/g

  const push = (node) => {
    const top = stack[stack.length - 1]
    if (top) { node.parentNode = top; top.children.push(node) } else { node.parentNode = parent; roots.push(node) }
  }

  let match
  while ((match = token.exec(html)) !== null) {
    const [raw, tag, attrs, text] = match
    if (text !== undefined) {
      const trimmed = text.trim()
      if (!trimmed) continue
      const top = stack[stack.length - 1]
      if (top) top._text += trimmed
      continue
    }
    if (raw.startsWith('</')) { stack.pop(); continue }

    const node = ownerDocument.createElement(tag)
    for (const attr of (attrs ?? '').matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)) {
      node.setAttribute(attr[1], attr[2])
      if (attr[1] === 'class') node.className = attr[2]
    }
    if ((attrs ?? '').includes('hidden')) node.hidden = true
    push(node)
    if (!raw.endsWith('/>') && !VOID.has(node.tagName)) stack.push(node)
  }
  return roots
}

/** Egy friss dokumentum. Minden teszt kapjon sajátot. */
export function createDocument () {
  const doc = {
    activeElement: null,
    fullscreenElement: null,
    pictureInPictureElement: null,
    listeners: new Map(),
    createElement (tag) { return new MiniNode(tag, doc) },
    /*
     * KERESÉS A DOKUMENTUMBAN.
     *
     * Az ELEMEKNEK volt `querySelector`-uk, a `document`-nek nem — az pedig
     * egy külön objektum, nem `MiniNode`. Minden kód, ami
     * `document.querySelectorAll(...)`-t hív (a router több helyen), ettől
     * „is not a function"-nel hasalt el a csonkban, és a hiba nem is abban a
     * modulban volt, amit épp teszteltünk.
     *
     * A `body`-ra delegálunk: a dokumentumban keresni annyi, mint a törzsben.
     */
    querySelector (selector) { return doc.body.querySelector(selector) },
    querySelectorAll (selector) { return doc.body.querySelectorAll(selector) },
    /*
     * Szövegcsomópont.
     *
     * A felület sok helyen `document.createTextNode(...)`-dal tesz szöveget
     * egy gombba vagy egy hivatkozásba — a `P.button` és minden `<a>` így
     * készül. Enélkül a csonk azoknál a moduloknál dobott kivételt, amiknek a
     * felirata így kerül a helyére, és a hiba nem is a modulban volt.
     *
     * Csak annyit tud, amennyi a fából kiolvasható szöveghez kell: nincs
     * gyereke, és a `textContent`-je önmaga.
     */
    createTextNode (value) {
      return { nodeType: 3, textContent: String(value ?? ''), parentNode: null, children: [] }
    },
    addEventListener (type, fn) {
      if (!doc.listeners.has(type)) doc.listeners.set(type, [])
      doc.listeners.get(type).push(fn)
    },
    removeEventListener (type, fn) {
      const list = doc.listeners.get(type)
      if (list) doc.listeners.set(type, list.filter(f => f !== fn))
    },
    fire (type, event = {}) {
      for (const fn of [...(doc.listeners.get(type) ?? [])]) fn({ type, preventDefault () {}, ...event })
    },
    exitFullscreen () { doc.fullscreenElement = null; return Promise.resolve() },
    exitPictureInPicture () { doc.pictureInPictureElement = null; return Promise.resolve() }
  }
  doc.body = doc.createElement('body')
  return doc
}

/** A dokumentum globálissá tétele a modulok idejére; a visszaadott függvény visszaállít. */
export function withDocument (doc) {
  const previous = globalThis.document
  globalThis.document = doc
  return () => { globalThis.document = previous }
}

export { MiniNode }
