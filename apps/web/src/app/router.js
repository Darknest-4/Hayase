/* global document, requestAnimationFrame, window */
// App bootstrap: hash router (same #/route scheme as the original SvelteKit
// build), sidebar active state and the quick-search modal (Ctrl+K / S).

import { Copy } from '../shared/i18n/copy.js'
import { C } from '../shared/ui/components.js'
import { GATE_EXEMPT, pageAvailable, configure as configureFeatures, featureOn, permissionsHeld } from '../shared/lib/site-config.js'
import { I18n, T } from '../shared/i18n/i18n.js'
import { Prefs } from '../shared/state/preferences.js'
import { Store, observeStore } from '../shared/state/store.js'
import { P } from '../shared/ui/primitives.js'
import { U } from '../shared/lib/dom.js'
import { YumeAPI } from '../shared/api/yume.js'
import { pageView, pendingView } from '../shared/lib/analytics.js'
import { loadStylesheet } from '../shared/lib/stylesheet.js'
import { createMaintenanceService } from '../features/maintenance/core/maintenance-service.js'
import { ADMIN_PERMISSIONS } from '../shared/lib/admin-access.js'
import { onboardingDue } from '../features/onboarding/meta.js'

// A katalógus-azonosító alakja: ilyet fogad el a látogatottság `entityId`-ként.
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/*
 * MIT TÖLT BE EGY ÚTVONAL — és csak azt.
 *
 * Minden képernyő a saját moduljával és a saját stíluslapjaival jön. A keret
 * (router, közös komponensek, `tokens` / `components` / `style.css`) az
 * egyetlen, ami minden oldalon ott van; a főoldal modulja nem töltődik le a
 * belépőlapon, az adminé nem a főoldalon, a lejátszóé nem a keresőben.
 *
 * A modul és a stíluslap egyszerre indul, és a képernyő csak akkor rajzolódik,
 * amikor mindkettő megjött — egy stílus nélkül felvillanó oldal rosszabb, mint
 * egy tizedmásodperc várakozás (a 200 ms fölötti várakozásra a router forgót
 * mutat). A kezdő útvonalé már az induláskor elindul (`init`), párhuzamosan a
 * konfigurációval, így az első festés nem vár egy második körre.
 *
 * A stíluslapok listáját a `test/route-styles.test.mjs` veti össze azzal, amit
 * a képernyők ténylegesen használnak.
 */
export const ROUTE_MODULES = {
  landing: () => import('../features/landing/landing.js'),
  home: () => import('../pages/home.js'),
  search: () => import('../pages/search.js'),
  schedule: () => import('../pages/schedule.js'),
  list: () => import('../pages/list.js'),
  login: () => import('../pages/login.js'),
  reset: () => import('../pages/reset.js'),
  profile: () => import('../pages/profile.js'),
  notifications: () => import('../pages/notifications.js'),
  dashboard: () => import('../pages/dashboard.js'),
  community: () => import('../pages/community.js'),
  changelog: () => import('../pages/changelog.js'),
  w2g: () => import('../features/watch-together/watch-together.js'),
  watch: () => import('../pages/watch.js'),
  admin: () => import('../pages/admin.js'),
  settings: () => import('../pages/settings.js'),
  anime: () => import('../pages/anime.js')
}

/**
 * Útvonal → a stíluslapjai a `css/` alatt, a keret hármán (tokens, components,
 * style) felül. A `css/pages/` a képernyő saját lapja, a `css/features/` a több
 * képernyőn használt modulok lapjai (hozzászólások, belépőűrlap, diagramok…).
 *
 * Nem kézzel kitalált lista: a `test/route-styles.test.mjs` minden útvonalra
 * kiszámolja, mely osztályokat használják a moduljai, és elbukik, ha egy
 * szükséges lap hiányzik innen, vagy egy felsorolt lapból semmi nem kell.
 */
export const ROUTE_STYLES = {
  landing: ['pages/landing.css'],
  home: ['pages/home.css'],
  search: ['pages/search.css'],
  schedule: ['pages/schedule.css'],
  anime: ['pages/anime.css'],
  watch: ['pages/watch.css'],
  w2g: ['features/watch-together.css'],
  list: ['features/lib-rows.css', 'pages/list.css'],
  profile: ['pages/profile.css'],
  notifications: ['pages/notifications.css'],
  dashboard: ['features/profile-bars.css', 'pages/dashboard.css'],
  community: ['features/comments.css', 'pages/community.css'],
  changelog: ['pages/changelog.css'],
  login: ['features/auth-form.css', 'pages/auth.css', 'pages/login.css'],
  reset: ['features/auth-form.css', 'pages/auth.css', 'pages/reset.css'],
  settings: ['features/auth-form.css', 'pages/settings.css'],
  admin: ['features/charts.css', 'admin.css']
}

export const App = {
  routes: {
    // Saját útvonal, nem csak a kapu. Belépve is elérhető: aki már fiókkal
    // jön, annak is joga van megnézni, mit ígér az oldal.
    landing: async (root, params) => (await App.routeModule('landing')).Landing.render(root, App.config?.site, () => { App.afterAuth() }),
    home: async (root, params) => (await App.routeModule('home')).PageHome.render(root, params),
    search: async (root, params) => (await App.routeModule('search')).PageSearch.render(root, params),
    schedule: async (root, params) => (await App.routeModule('schedule')).PageSchedule.render(root, params),
    list: async (root, params) => (await App.routeModule('list')).PageList.render(root, params),
    // Saját címe van, mert hivatkozni kell rá: a hozzáférési kapuból, egy
    // levélből, egy hibaüzenetből. A felugró ablak megmarad a
    // kezdőképernyőn — a kettő UGYANAZT az űrlapot használja.
    login: async (root, params, arg) => (await App.routeModule('login')).PageLogin.render(root, params, arg),
    // The address a password reset mail links to: #/reset?token=…
    reset: async (root, params) => (await App.routeModule('reset')).PageReset.render(root, params),
    profile: async (root, params) => (await App.routeModule('profile')).PageProfile.render(root, params),
    notifications: async (root, params) => (await App.routeModule('notifications')).PageNotifications.render(root, params),
    dashboard: async (root, params) => (await App.routeModule('dashboard')).PageDashboard.render(root, params),
    community: async (root, params) => (await App.routeModule('community')).PageCommunity.render(root, params),
    changelog: async (root, params) => (await App.routeModule('changelog')).PageChangelog.render(root, params),
    w2g: async (root, params, arg) => (await App.routeModule('w2g')).PageW2G.render(root, params, arg),
    watch: async (root, params, arg) => (await App.routeModule('watch')).PageWatch.render(root, params, arg),
    // The section can arrive either way: `#/admin/audit` names it in the path,
    // which is the address form the panel's own sections are documented at,
    // and `?s=` is what the rail writes as you click through. The page takes
    // the path form first and falls back to the query.
    // Az admin a saját stíluslapjával jön: a többi látogató soha nem tölti le.
    admin: async (root, params, arg) => (await App.routeModule('admin')).PageAdmin.render(root, params, arg),
    settings: async (root, params) => (await App.routeModule('settings')).PageSettings.render(root, params),
    anime: async (root, params, arg) => (await App.routeModule('anime')).PageAnime.render(root, params, arg)
  },

  /**
   * Egy útvonal modulja, a stíluslapjaival együtt betöltve.
   *
   * A modul-import eredményét a böngésző gyorsítótárazza, a stíluslapét a
   * `loadStylesheet` — egy második hívás tehát nem tölt újra semmit, csak
   * megvárja, ami már úton van. Egy hiányzó stíluslap nem akasztja meg a
   * képernyőt (a `loadStylesheet` sosem dob); egy hiányzó modul igen, és azt a
   * `navigate` hibaállapotként rajzolja ki.
   */
  routeModule (route) {
    const load = ROUTE_MODULES[route]
    if (!load) return Promise.reject(new Error(`no module for route ${route}`))
    const styles = (ROUTE_STYLES[route] ?? []).map(name => loadStylesheet(name))
    return Promise.all([load(), ...styles]).then(([module]) => module)
  },

  /** A kezdő útvonal előkészítése, a konfigurációval párhuzamosan. Nem dob. */
  prefetchRoute (route) {
    if (!ROUTE_MODULES[route]) return
    this.routeModule(route).catch(() => {})
  },

  parseHash () {
    // "#/anime/123?x=y" -> { route: 'anime', arg: '123', params }
    const hash = window.location.hash.replace(/^#\/?/, '')
    if (hash) {
      const [path, query] = hash.split('?')
      const [route, arg] = path.split('/')
      return { route: route || 'home', arg, params: new URLSearchParams(query ?? '') }
    }
    // No fragment: read the path instead.
    //
    // A fragment never reaches the server, so for as long as "#/anime/123" was
    // the only spelling, no crawler, link preview or share sheet could ever be
    // told which anime a URL was about — every one of them saw index.html's
    // generic <head>. The server now also answers "/anime/123" with the app
    // and a <head> about that anime (apps/api/src/modules/seo/routes.ts), and the
    // sitemap points at that form, so the router has to understand it too.
    //
    // Only a name that is actually a route counts. Anything else — a typo, a
    // path from an older deployment — is home, which is what the SPA fallback
    // already implied by serving this page for it.
    const [route, arg] = String(window.location.pathname || '/').replace(/^\/+/, '').split('/')
    const params = new URLSearchParams(window.location.search ?? '')
    if (route && this.routes[route]) return { route, arg, params }

    /*
     * A CSUPASZ GYÖKÉR A KEZDŐKÉPERNYŐ.
     *
     * Aki a domaint írja be, az nem a könyvtárát jött megnézni — ő még nem
     * tudja, mi ez. A `#/home` a visszatérő látogató címe, és az is marad:
     * ide csak az esik, ahol se útvonalnév, se fragmentum nincs.
     *
     * Belépve is a kezdőképernyő jön, és ez szándékos: a lap nekik is szól, és
     * egy automatikus átirányítás elvenné tőlük a lehetőséget, hogy
     * megnézzék. Az onnan induló gomb viszont tudja, hogy be vannak lépve, és
     * a főoldalra visz.
     *
     * Ismeretlen ÚTVONALNÉV továbbra is a `home`: azt a `navigate()` a
     * „nincs ilyen oldal" kapuval kezeli, és egy elgépelt cím ne a
     * marketinglapra essen.
     */
    if (!route) return { route: 'landing', arg: undefined, params }
    return { route: 'home', arg: undefined, params }
  },

  /** The site's own name, once the configuration has arrived. */
  siteName () {
    return this.config?.site?.name ?? 'Yume'
  },

  /**
   * Set the browser tab's title.
   *
   * `null` restores the site's own. The server puts the anime's name in the
   * served <title> for a crawler (apps/api/src/modules/seo/routes.ts); this is the same
   * courtesy for the person with fifteen tabs open, who otherwise sees the
   * same word on all of them.
   */
  /** Egy útvonal neve a fülhöz; a főoldalé maga a márka. */
  routeTitle (route) {
    if (!route || route === 'home' || route === 'landing') return null
    const own = {
      login: T('Sign in'),
      reset: T('Új jelszó'),
      changelog: T('Development log'),
      admin: T('Admin'),
      anime: null,
      watch: null
    }
    if (route in own) return own[route]
    return Copy?.nav?.[route] ? T('nav.' + route) : null
  },

  setTitle (text) {
    document.title = text ? `${text} — ${this.siteName()}` : this.siteName()
  },

  /**
   * Rewrite a path URL into the app's own hash form, once, on arrival.
   *
   * Without this the address bar keeps saying /anime/123 while the viewer
   * clicks through to something else, and every later link is resolved against
   * that path. replaceState fires neither hashchange nor popstate, so this
   * runs before the first navigate() and leaves nothing behind.
   */
  normalisePath () {
    if (window.location.hash) return
    const { route, arg, params } = this.parseHash()
    /*
     * A tiszta gyökeret békén hagyjuk. A `/` a kezdőképernyő címe, és nem
     * nyer semmit azzal, ha `/#/landing`-re írjuk át — csak csúnyább lesz egy
     * megosztott linkben.
     */
    if ((route === 'home' || route === 'landing') && !arg) return
    const query = params.toString()
    const target = `/#/${route}${arg ? '/' + arg : ''}${query ? '?' + query : ''}`
    window.history?.replaceState?.(null, '', target)
  },

  // pages folded into a hub keep working as deep links via a redirect
  REDIRECTS: {
    analytics: '#/profile?tab=analytics',
    achievements: '#/profile?tab=achievements',
    history: '#/profile?tab=history',
    themes: '#/settings?tab=appearance'
  },

  _navGen: 0,

  /**
   * A karbantartási oldal, ha most azt kell mutatni — különben `null`.
   *
   * A TELJES OLDAL csak a mindent lezáró módokban jár. A részleges és a
   * csak-olvasható üzem mellett az oldal MEGY, és ott szalag a helyes válasz:
   * az elmondja, mi nem működik, és nem áll az útba.
   */
  /**
   * A karbantartási kapu. Aszinkron, mert a karbantartási lap (és a
   * háttérvideó lejátszója) a saját moduljában él, és csak akkor töltődik le,
   * amikor tényleg ki kell rajzolni — a látogatók túlnyomó többsége soha nem
   * látja.
   */
  async _maintenanceGate (route) {
    const service = this._maintenance
    if (!service) return null
    const status = service.status
    const blocking = status.mode === 'ACTIVE' || status.mode === 'EMERGENCY'
    if (!blocking) {
      this._renderMaintenanceBanner(status)
      return null
    }

    // Az üzemeltető átmegy a szerveren, tehát a lapja is működjön. Az
    // adminfelület ráadásul az EGYETLEN hely, ahonnan ki lehet kapcsolni.
    if (permissionsHeld().length > 0 || route === 'admin') {
      this._renderMaintenanceBanner(status)
      return null
    }

    const { createMaintenancePage } = await import('../features/maintenance/ui/maintenance-page.js')
    this._maintenancePage?.destroy()
    this._maintenancePage = createMaintenancePage(status, {
      service,
      onRetry: () => { window.location.reload() }
    })
    return this._maintenancePage.node
  },

  /** A szalag a működő oldal tetején — részleges vagy ütemezett üzemnél. */
  _renderMaintenanceBanner (status) {
    document.getElementById('mnt-banner')?.remove()
    const interesting = ['SCHEDULED', 'DEGRADED', 'READ_ONLY', 'ACTIVE', 'EMERGENCY']
    if (!interesting.includes(status.mode)) return

    const text = {
      SCHEDULED: 'Tervezett karbantartás következik.',
      DEGRADED: 'Néhány funkció átmenetileg nem érhető el.',
      READ_ONLY: 'Most csak olvasni lehet — a módosításokat nem fogadjuk.',
      ACTIVE: 'Karbantartás folyik. Neked a jogosultságod miatt működik az oldal.',
      EMERGENCY: 'Rendkívüli karbantartás folyik.'
    }[status.mode]

    const banner = U.el('div', { class: 'mnt-banner', id: 'mnt-banner', role: 'status' }, [
      U.el('span', { class: 'mnt-banner-text', text: status.title ? `${status.title} — ${text}` : text }),
      U.el('button', {
        class: 'mnt-banner-close',
        type: 'button',
        'aria-label': 'Értesítés bezárása',
        text: '×',
        onclick: e => e.currentTarget.parentElement.remove()
      })
    ])
    loadStylesheet('maintenance.css')
    document.getElementById('page')?.prepend(banner)
  },

  /**
   * A KRITIKUS BOOTSTRAP ÁLLAPOTA.
   *
   *   'pending'  a konfiguráció még úton van — útvonalat feloldani MÉG NEM
   *              szabad, mert a kapu nem tud dönteni;
   *   'ready'    megjött;
   *   'failed'   nem jött meg, és nem is fog — a lap ettől még működjön.
   *
   * MIÉRT KELL. A `_gateCheck` eddig egyetlen `if (!cfg)` ággal kezelte a
   * „nincs még meg" és a „nem érhető el" esetet, és mindkettőre átengedett.
   * A második szándék volt (egy elérhetetlen háttértől ne álljon meg az
   * egész oldal), az elsőt viszont MINDEN indulás eltalálja — és az
   * eredménye mérhető volt:
   *
   *   kijelentkezve a `#/home`-ra érkezve a kezdőlap lefutott, elindított
   *   TIZENEGY `/v1/anime/` lekérdezést, mind a tizenegy 401-gyel jött
   *   vissza, aztán a konfiguráció megérkezett, a kapu döntött, és a
   *   kezdőképernyő kicserélte az egészet
   *
   * Vagyis: dupla renderelés, tizenegy fölösleges és jogosulatlan kérés, és
   * a végén a cím `#/home` maradt, miközben a látogató a kezdőképernyőt
   * nézte — egy frissítés, egy könyvjelző vagy egy megosztott link mind
   * rossz helyre mutatott.
   */
  _boot: 'pending',

  /**
   * EGYSZERRE EGY NAVIGÁCIÓ FUT — ÉS EZ EGY MÉRT HIBA JAVÍTÁSA.
   *
   * A `navigate()` kiüríti a `#page`-et, aztán MEGVÁRJA az oldal kezelőjét;
   * a kezelő a végén beteszi, amit rajzolt. Két egyidejű navigáció ezért
   * egymásba tud csúszni:
   *
   *   A: kiürít → várakozik a jogosultságokra…
   *   B: kiürít (nincs mit) → rajzol → BETESZI a saját felületét
   *   A: felébred → BETESZI a magáét is
   *
   * Az eredmény KÉT adminfelület egyetlen lapon: két navigációs sáv, két
   * időzítő, minden kérés duplán, és a gombok kétszer szerepelnek. A meglévő
   * generációs őr ezt nem fogta meg, mert csak a kezelő UTÁN néz — a beszúrás
   * addigra megtörtént.
   *
   * MÉRVE: a második megnyitáskor két `.admin-content` volt a lapon. A két
   * navigáció a bootstrap záró hívása és a nyelvi preferencia változására
   * induló újrarajzolás volt; a `_boot` őr csak addig véd, amíg a bootstrap
   * tart, és a második betöltéskor (gyorsítótárazott beállításokkal) a
   * preferencia már utána érkezett.
   *
   * A MEGOLDÁS A SORBA ÁLLÍTÁS: az újabb navigáció megvárja a korábbit,
   * aztán tiszta lappal rajzol. Így mindig a LEGUTOLSÓ nyer, és soha nem
   * marad benn két oldal. A várakozás felső korlátos: egy beragadt kezelő
   * nem fagyaszthatja be örökre a navigációt.
   */
  _navChain: null,
  NAV_WAIT_MS: 3000,

  navigate () {
    const elozo = this._navChain
    this._navChain = (async () => {
      if (elozo) {
        await Promise.race([
          elozo.catch(() => {}),
          new Promise(resolve => setTimeout(resolve, this.NAV_WAIT_MS))
        ])
      }
      return await this._navigateOnce()
    })()
    return this._navChain
  },

  async _navigateOnce () {
    /*
     * ELŐBB A KRITIKUS BOOTSTRAP, UTÁNA AZ ELSŐ ÚTVONAL.
     *
     * Az `init()` több olyat is elindít, ami navigálni akar, mielőtt a
     * konfiguráció megjönne — a karbantartás-figyelő első válasza, egy
     * nyelvváltás, egy `hashchange`. Amíg a bootstrap tart, ezek nem
     * rajzolnak: a `booting` váz marad a képen, és az `init()` végén egyetlen
     * navigáció rajzol egyszer, a helyes kerettel.
     *
     * Ez nem késleltetés: ugyanaz a `loadConfig()` fut, ugyanannyi ideig. A
     * különbség az, hogy nem rajzolunk ki egy oldalt, amit utána eldobunk.
     */
    if (this._boot === 'pending') return

    const gen = ++this._navGen
    const { route, arg, params } = this.parseHash()
    if (this.REDIRECTS[route]) { window.location.replace(this.REDIRECTS[route]); return }
    const page = document.getElementById('page')
    document.getElementById('w2g-modal')?.remove() // close the W2G popup on nav
    page.replaceChildren()
    /*
     * A GÖRGETÉS HELYE A TÖRTÉNETBEN ÉL.
     *
     * Az oldal most a dokumentumot görgeti (lásd style.css, „shell"), és a
     * görgetés helyét a `scroll` figyelő a history-bejegyzésbe írja. Egy új
     * navigációnak nincs ilyen bejegyzése — az a lap tetején kezd; a vissza
     * gomb viszont oda tér vissza, ahol a néző a listát elhagyta, nem a
     * harmincadik találat helyett az elsőre.
     */
    const savedScroll = Number(window.history.state?.yumeScroll) || 0
    window.scrollTo(0, 0)

    // banner only persists on home; pages set their own
    if (route !== 'home') U.setBanner(null)

    // The tab title goes back to the route's own name on every navigation. A
    // page with something better to say — the anime detail page — sets it
    // after its data arrives, and this is what un-sets it on the way out;
    // otherwise the tab keeps naming a show the viewer left three pages ago.
    // A böngészőfül és a képernyőolvasó is az oldal nevét mondja („Keresés —
    // Yume"), nem mindenhol ugyanazt a márkanevet.
    this.setTitle(this.routeTitle(route))

    /*
     * The administration panel gets the window to itself.
     *
     * It was rendering inside the ordinary site chrome — the icon rail on the
     * left, the mobile tab bar at the bottom, the marketing footer under a
     * table of user accounts — with its own section rail beside it. Two navs
     * competing for the same edge, and on a phone a bottom bar covering the
     * panel's own controls. An operator screen and a viewer screen are not the
     * same product and should not wear the same frame.
     *
     * The class is what the stylesheet keys off; the page module builds the
     * panel's own rail.
     */
    document.body.classList.toggle('admin-route', route === 'admin')
    // A kezdőképernyőnek saját fejléce van, és telefonon nem kér alsó sávot:
    // aki még nem lépett be, annak a lebegő pill öt olyan helyre mutat, ahová
    // úgysem juthat el.
    // A jelölést a `_renderGate` és a `landing` útvonal is átírhatja: a kapu a
    // kezdőképernyőt rajzolja olyan útvonalon, amit még máshogy hívnak.
    // Tipp a címből: a keret osztálya már most a helyére kerül, de a krómot
    // még nem mutatjuk meg — a kapu felülbírálhatja. Lásd `applyLayout`.
    this.applyLayout(route)

    /*
     * Jelezzük, hogy megnyílt egy oldal.
     *
     * Itt, és nem a lapmodulokban: egy útvonal sok modulon keresztül érhető
     * el, és ha mindegyik maga jelentené, akkor pont az maradna ki, amit
     * legutóbb írtunk. Ez az egy hely tudja, hogy navigáció történt.
     *
     * Az azonosító külön megy, nem az útvonalba ágyazva: `/anime/:id` egy
     * OLDAL, `/anime/<uuid>` harmincezer, egyenként egy látogatóval.
     */
    const ENTITY_ROUTES = ['anime', 'watch']
    const entity = String(arg ?? '').split(':')[0]
    if (ENTITY_ROUTES.includes(route) && !UUID_ID.test(entity)) pendingView('/' + route)
    else pageView('/' + route, ENTITY_ROUTES.includes(route) ? entity : undefined)

    document.querySelectorAll('.sidebar-btn').forEach(btn => {
      const here = btn.dataset.route === route
      btn.classList.toggle('active', here || ((route === 'anime' || route === 'watch') && btn.dataset.route === 'home'))
      // A képernyőolvasó a jelenlegi oldalt nevén nevezi, nem egy színből.
      if (here) btn.setAttribute('aria-current', 'page')
      else btn.removeAttribute('aria-current')
    })
    // mobile bottom bar: the "More" tab lights up for any route that isn't a
    // primary tab (or its home-mapped detail/watch pages)
    const primary = ['home', 'search', 'list', 'notifications', 'anime', 'watch']
    document.getElementById('nav-more')?.classList.toggle('active', !primary.includes(route))
    this.refreshNotifBadge()

    /*
     * ---- KARBANTARTÁSI KAPU ----
     *
     * EZ NEM BIZTONSÁGI HATÁR, és fontos tudni, hogy miért nem: a szerver
     * minden kérést maga bírál el (`modules/maintenance/middleware.ts`), és
     * ami oda nem jut be, azt ez a kapu sem engedi ki. Amit itt csinálunk, az
     * a MEGJELENÍTÉS — hogy a néző ne egy sor elhasalt kérésből következtesse
     * ki, mi történik.
     *
     * Aki a szerver szerint bemehet (üzemeltető, jeggyel rendelkező), annak a
     * kérései sikeresek — ezért a teljes oldalt csak akkor mutatjuk, ha a
     * nézőnek nincs üzemeltetői jogosultsága. Egy adminnak, aki épp a
     * karbantartást kapcsolja ki, a legrosszabb dolog egy karbantartási oldal.
     */
    const maintenancePage = await this._maintenanceGate(route)
    if (gen !== this._navGen) return
    if (maintenancePage) {
      this.applyLayout(route, { reveal: true })
      page.replaceChildren(maintenancePage)
      return
    }

    /*
     * A NEM LÉTEZŐ CÍM ELŐBB VAN, MINT A KAPU.
     *
     * A router lentebb ki is mondja, miért: egy holt hivatkozásnak meg kell
     * mondania, hogy holt — különben minden elírás, minden átnevezett
     * útvonal, minden elavult könyvjelző úgy fest, mintha működött volna.
     *
     * A sorrend viszont visszahozta ugyanezt a hibát: zárt példányon a kapu
     * ELŐBB döntött, és a `#/nincs-ilyen-oldal` a KEZDŐKÉPERNYŐT kapta, nem
     * egy hibát. Élesben lemérve.
     *
     * Ez nem szivárogtat: az útvonalak listája a kliens kódjában amúgy is
     * ott van, tehát attól, hogy egy nem létező címre „nincs ilyen"-t
     * mondunk, senki nem tud meg semmit, amit ne tudhatna.
     */
    if (!this.routes[route]) {
      this.applyLayout(route, { reveal: true })
      this._renderGate(page, { kind: 'not-found' }, route, arg)
      if (!this.CHROMELESS.includes(route)) page.append(C.footer())
      return
    }

    // feature-flag / access gate (DB-driven site config)
    const gate = this._gateCheck(route)
    if (!gate.ok) {
      /*
       * A KAPU DÖNTÖTT, tehát most már tudjuk, milyen keret jár. A
       * `site-login` ág a kezdőképernyőt rajzolja — a keret is az övé, bármi
       * is volt a címben.
       */
      this.applyLayout(gate.kind === 'site-login' ? 'landing' : route, { reveal: true })
      this._renderGate(page, gate, route, arg)
      if (!this.CHROMELESS.includes(route)) page.append(C.footer())
      return
    }

    /*
     * An address with no page behind it says so.
     *
     * This used to fall back to the home page, which made every dead deep
     * link — a renamed route, a typo, a stale bookmark, a link from somewhere
     * else — look like it had worked. The viewer got the landing page and no
     * reason to think they had not arrived where they meant to.
     */
    this.applyLayout(route, { reveal: true })

    // A nem létező címet fent már elkaptuk, a kapu ELŐTT — ez itt csak az
    // öv a nadrágtartó mellé.
    const handler = this.routes[route]
    if (!handler) {
      this._renderGate(page, { kind: 'not-found' }, route, arg)
      if (!this.CHROMELESS.includes(route)) page.append(C.footer())
      return
    }
    /*
     * EGY LUSTÁN BETÖLTÖTT OLDAL NEM HAGY ÜRES KÉPERNYŐT. A képernyők saját
     * moduljai az első megnyitáskor töltődnek le; ha ez (vagy az oldal első
     * adata) 200 ms-nál tovább tart, egy töltésjelző áll a helyén, amíg az
     * oldal bármit ki nem rajzol.
     */
    const waiting = setTimeout(() => {
      if (gen !== this._navGen || page.childElementCount) return
      const spinner = P.spinner()
      spinner.classList.add('route-spinner')
      page.append(spinner)
      const watch = new window.MutationObserver(() => {
        if ([...page.children].some(child => child !== spinner)) { spinner.remove(); watch.disconnect() }
      })
      watch.observe(page, { childList: true })
    }, 200)
    try {
      await handler(page, params, arg) // async pages (e.g. admin) finish before the footer lands
    } catch (e) {
      // Every page that throws lands here, so this one call is what puts the
      // code and the request id in front of a viewer on any route.
      page.replaceChildren(C.errorState(e, () => this.navigate()))
    }

    clearTimeout(waiting)
    page.querySelector(':scope > .route-spinner')?.remove()

    // a newer navigation superseded us while an async handler was in flight
    if (gen !== this._navGen) return

    // site footer on standard content pages (not on immersive / picker
    // screens, and not under the admin panel — see CHROMELESS)
    if (!this.CHROMELESS.includes(route)) page.append(C.footer())

    // Vissza-navigációnál a mentett helyre, ha a tartalom már elég hosszú.
    if (savedScroll > 0) window.requestAnimationFrame(() => window.scrollTo(0, savedScroll))

    /*
     * A FÓKUSZ AZ ÚJ TARTALOMRA KERÜL.
     *
     * Egy hivatkozásra kattintás után a fókusz eddig a (most már eltűnt)
     * hivatkozáson ragadt, vagy a lap elejére esett vissza: egy billentyűzettel
     * vagy képernyőolvasóval navigáló néző a menü elejéről kezdte újra. A
     * `<main>` fókuszálható (`tabindex="-1"`), és a cím már az új oldalé. Az
     * első betöltésnél nem: ott a böngésző dolga, hová esik a fókusz.
     */
    // Csak VALÓDI címváltáskor: ugyanannak a lapnak az újrarajzolása (a fiók
    // könyvtára megérkezett, nyelvváltás) nem ránthatja el a fókuszt onnan,
    // ahol a néző épp van — például az ugrólinkről.
    const address = window.location.pathname + window.location.hash
    if (this._lastAddress !== undefined && this._lastAddress !== address && !page.contains(document.activeElement)) {
      page.focus({ preventScroll: true })
    }
    this._lastAddress = address

    // News last, and deliberately not awaited. A message about the site is
    // never more urgent than the site, and a modal that beats the first paint
    // makes the app look like it is asking permission to start. It answers at
    // most once per page load and never twice for the same message.
    // A modul is csak belépve jön le: kijelentkezve nincs mit megkérdezni.
    if (YumeAPI.user()) {
      import('../features/announcements/announcements.js')
        .then(({ Announcements }) => Announcements.check())
        .catch(() => {})
    }
  },

  /**
   * Paint the site's default theme for a viewer who has never chosen one.
   *
   * Only for them. An operator changing the default must not repaint the app
   * of somebody who picked their own — that is their choice, and silently
   * overwriting it is the behaviour nobody can explain afterwards.
   *
   * Best-effort and off the critical path: if the theme list cannot be
   * reached the page renders in the stylesheet's own colours, which is what it
   * did before any of this existed.
   */
  async applyDefaultTheme () {
    if (Store?.hasChosenTheme?.()) return
    try {
      const themes = await YumeAPI.themes()
      const fallback = (themes ?? []).find(t => t.is_default)
      if (!fallback) return
      Store.setTheme({
        base: fallback.base,
        accent: fallback.accent ?? '',
        tint: Boolean(fallback.tint),
        tokens: fallback.tokens ?? {},
        slug: fallback.slug
      })
    } catch (e) { /* the stylesheet's own colours are a fine answer */ }
  },

  // ---- feature-flag / access gate ----

  config: null, // effective site config from /v1/config
  perms: [], // the signed-in user's permission slugs
  viewer: null, // the account's own profile row: display name and artwork

  /**
   * Routes that carry no site footer.
   *
   * The immersive screens (the player, watch-together, the profile picker)
   * plus the admin panel, which brings its own frame entirely.
   */
  CHROMELESS: ['watch', 'w2g', 'admin', 'landing', 'login', 'reset'],

  // routes always reachable so users can configure the server / sign in
  /*
   * A kapu alól mentes útvonalak — a `site-config.js`-ből, nem külön
   * másolatban. A `login` KÜLÖN FONTOS: ha a kapu elzárná, egy privát
   * példányon a belépőlap maga is kapu mögé kerülne, és nem lenne mód
   * bejutni. Ugyanebből a listából dolgozik a menük láthatósága is.
   */
  _gateExempt: GATE_EXEMPT,

  /**
   * Routes that must never be reachable by accident.
   *
   * Everything else fails *open* on purpose: an unreachable backend should
   * leave the catalogue browsable rather than blank the site. That default is
   * wrong for the admin panel, where "we could not check" must mean "no".
   */
  PRIVILEGED: ['admin'],

  /**
   * Does this account hold any permission the admin panel actually uses?
   *
   * Read from `PageAdmin.SECTIONS` rather than from a feature flag, because
   * that list is what the panel itself gates on — and the two disagreeing is
   * the bug this replaces. `page.admin` required `analytics.view`, while every
   * section requires something else, so:
   *
   *   analyst    held `analytics.view`  → saw the link, then a wall
   *   moderator  held `community.moderate`, a real section → saw no link at all
   *
   * One rule, asked in one place, and both directions stop being wrong.
   */
  _adminSectionPermissions () {
    /*
     * A LISTA A SZAKASZOKÉ, DE A ROUTER CSAK A NEVEKET KAPJA.
     *
     * Eddig `PageAdmin.SECTIONS`-ből olvastunk (a 279 kB-os panel minden
     * oldalbetöltéssel megérkezett), aztán a `shared/lib/admin-sections.js`
     * teljes szakaszlistájából (címkék, csoportok, ikonok — 10 KB minden
     * látogatónak). A döntéshez csak a jogosultságnevek kellenek: azok az
     * `admin-access.js`-ben állnak, és a `test/admin-access.test.mjs` őrzi,
     * hogy pontosan a szakaszok jogosultságai legyenek.
     */
    return [...ADMIN_PERMISSIONS]
  },

  _gateCheck (route) {
    const cfg = this.config
    const signedIn = !!YumeAPI.user()
    const privileged = this.PRIVILEGED.includes(route)

    /*
     * A privileged route is authorised by the permissions we hold, and only
     * by those. The feature flag stays a kill switch — an administrator can
     * turn the panel off — but it is not the authorisation, which is what it
     * had accidentally become.
     *
     * That separation matters in both directions. A missing flag row must not
     * lock out someone who legitimately holds the permission, and it must not
     * let in someone who does not.
     */
    if (privileged) {
      // Not signed in reads the same as not permitted, on purpose. A sign-in
      // card here would confirm to anyone who typed the address that the panel
      // exists — the thing the refusal below is written to avoid — and the
      // kind it used to return had no `flag` on it, so the renderer threw and
      // painted a blank page instead of anything at all.
      if (!signedIn) return { ok: false, kind: 'permission' }
      if (route === 'admin') {
        const needed = this._adminSectionPermissions()
        if (!needed) return { ok: false, kind: 'permission' }
        if (!needed.some(perm => this.perms.includes(perm))) return { ok: false, kind: 'permission' }
      }
    }

    /*
     * A HÁTTÉR NEM ÉRHETŐ EL: a lap többi része maradjon használható — a
     * jogosultsághoz kötött útvonalakat fent már visszautasítottuk.
     *
     * Ez az ág MOSTANTÓL CSAK EZT JELENTI. Korábban a „még nem töltődött be"
     * állapot is ide esett, és ugyanezt a választ kapta; azt most a
     * `navigate()` bootstrap-őre fogja meg, tehát ide már nem juthat el.
     */
    if (!cfg) return privileged ? { ok: false, kind: 'permission' } : { ok: true }

    if (cfg.site.requireLogin && !signedIn && !this._gateExempt.includes(route)) {
      return { ok: false, kind: 'site-login' }
    }

    const flag = cfg.flags['page.' + route]
    // A missing flag row means "nobody configured this page", which for an
    // ordinary page is the right reason to allow it. A privileged route has
    // already been authorised above, so a missing row cannot let anybody in
    // who was not already permitted — and must not lock out anybody who was.
    if (!flag) return { ok: true }
    /*
     * The kill switch applies to everything — except to the people who can
     * undo it.
     *
     * `page.admin` off used to be a door that locks from the inside. The panel
     * is the only place the flag can be turned back on, so switching it off
     * ended every administrator's access permanently and left a database
     * console as the only way back in. Turning off a page should not be able
     * to be the last thing an operator ever does here.
     *
     * So whoever holds the permission that edits the flags keeps the door:
     * for everybody else — moderators, analysts, editors — the switch still
     * does exactly what it says.
     */
    if (!flag.enabled) {
      const canUndo = route === 'admin' && this.perms.includes('settings.system')
      if (!canUndo) return { ok: false, kind: 'disabled', flag }
    }
    if (privileged) return { ok: true }
    if (flag.access === 'auth' && !signedIn) return { ok: false, kind: 'auth', flag }
    if (flag.access === 'permission') {
      if (!signedIn) return { ok: false, kind: 'auth', flag }
      if (!this.perms.includes(flag.permission)) return { ok: false, kind: 'permission', flag }
    }
    return { ok: true }
  },

  // is a cross-cutting feature available? (used by pages, e.g. reviews/comments)
  /**
   * Is this feature available to the person looking?
   *
   * Kept as a method because most of the client asks through App, but the
   * answer lives in shared/lib/features.js — the shared UI components ask the
   * same question, and a component that imported the router to find out made
   * the foundation depend on the application standing on it.
   */
  featureOn (name) {
    return featureOn(name)
  },

  /** Hand the flag reader what it needs. Called after config and permissions load. */
  _publishFeatureState () {
    configureFeatures({
      config: this.config,
      permissions: this.perms ?? [],
      viewer: this.viewer ?? null,
      signedIn: () => !!YumeAPI.user()
    })
  },

  _renderGate (page, gate, route, arg) {
    const wrap = U.el('div', { class: 'gate' })

    if (gate.kind === 'site-login') {
      // A kapu ugyanazt a kezdőképernyőt rajzolja, amit a #/landing útvonal:
      // egy landing van, nem kettő. `require_login` továbbra is eldönti, mi
      // érhető el — ez csak annyi, hogy a lakat helyett van mit nézni.
      // A kapun át is a kezdőképernyő jön, tehát az alkalmazás krómja itt is
      // lekerül — különben a lebegő pill öt olyan helyre mutatna, ahová egy
      // kijelentkezett látogató nem juthat el.
      document.body.classList.add('landing-route')
      this.routeModule('landing')
        .then(({ Landing }) => { if (page.isConnected) Landing.render(page, this.config?.site, () => { this.afterAuth() }) })
        .catch(() => page.replaceChildren(P.errorState(T('Something went wrong'))))
      return
    } else if (gate.kind === 'auth') {
      /*
       * A KAPU ELKÜLD, NEM BEÁGYAZ.
       *
       * Eddig egy kis beágyazott űrlapot rajzolt ide. Két baja volt: ez a
       * harmadik másolat volt ugyanabból a logikából (és amikor az emberpróba
       * bekerült, ebbe nem került bele, tehát a regisztráció innen 403-mal
       * hasalt volna el), és nem is volt hová visszatérni belőle — belépés
       * után a látogató ott maradt, ahol volt, ahelyett hogy megérkezett
       * volna oda, ahová indult.
       *
       * A `next` viszi tovább a szándékot: a belépőlap ide hozza vissza.
       */
      const back = `${route}${arg ? '/' + arg : ''}`
      wrap.append(
        U.el('div', { class: 'gate-icon', text: '🔑' }),
        // `gate.flag?.label` rather than `gate.flag.label`: a kind that
        // arrives without a flag must degrade to a plainer sentence, not throw
        // inside the renderer and leave the viewer a blank page.
        /*
         * EZ A SOR SOSEM MENT ÁT A FORDÍTÓN.
         *
         * Sablonszöveg volt — `` `Sign in for ${...}` `` —, tehát a `T()` meg
         * sem látta, és egy magyar nyelvű példányon angolul jelent meg:
         * „Sign in for Beállítások". A másik ág ugyanebben a sorban rendesen
         * fordítva volt, tehát a hiba pont ott ült, ahol a kettő találkozik.
         *
         * Összefűzés, nem behelyettesítés: a `T()` nem tud helyőrzőt, és egy
         * kétszavas előtag nem indokol új fordítómotort.
         */
        U.el('h1', {
          class: 'gate-title',
          text: gate.flag ? `${T('Sign in for')} ${gate.flag.label}` : T('Sign in to continue')
        }),
        U.el('p', { class: 'gate-sub', text: T('This section needs a signed-in account.') }),
        U.el('div', { class: 'gate-actions' }, [
          U.el('a', { class: 'btn btn-primary', href: `#/login?next=${encodeURIComponent(back)}` },
            [document.createTextNode(T('Sign in'))]),
          U.el('a', { class: 'btn btn-secondary', href: `#/login/register?next=${encodeURIComponent(back)}` },
            [document.createTextNode(T('Create account'))])
        ])
      )
    } else if (gate.kind === 'not-found' || (gate.kind === 'permission' && this.PRIVILEGED.includes(route))) {
      // One branch for two cases on purpose. A privileged route the viewer may
      // not open has to be indistinguishable from a route that does not exist —
      // naming the missing permission would confirm the panel is there and say
      // exactly which grant to go after, a 403 wearing a friendlier face — and
      // the way to keep the two identical is to render them from one place.
      wrap.append(
        U.el('div', { class: 'gate-icon', text: '🔍' }),
        U.el('h1', { class: 'gate-title', text: T('Page not found') }),
        U.el('p', { class: 'gate-sub', text: T('There is nothing at this address.') }),
        U.el('a', { class: 'btn btn-secondary', href: '#/home' }, [document.createTextNode(T('Back home'))])
      )
    } else if (gate.kind === 'permission') {
      // An ordinary gated page says what it needs: a viewer who cannot open
      // Watch Together should be able to ask for the grant by name.
      wrap.append(
        U.el('div', { class: 'gate-icon', text: '⛔' }),
        U.el('h1', { class: 'gate-title', text: T('No access') }),
        U.el('p', {
          class: 'gate-sub',
          text: gate.flag
            ? `${gate.flag.label} requires the “${gate.flag.permission}” permission.`
            : T('You do not have access to this section.')
        }),
        U.el('a', { class: 'btn btn-secondary', href: '#/home' }, [document.createTextNode(T('Back home'))])
      )
    } else { // disabled
      wrap.append(
        U.el('div', { class: 'gate-icon', text: '🚧' }),
        U.el('h1', { class: 'gate-title', text: `${gate.flag?.label ?? 'This section'} is turned off` }),
        U.el('p', { class: 'gate-sub', text: T('An administrator has disabled this part of the site.') }),
        U.el('a', { class: 'btn btn-secondary', href: '#/home' }, [document.createTextNode(T('Back home'))])
      )
    }
    page.append(wrap)
  },

  /**
   * A varázsló, de nem a kezdőképernyő fölött.
   *
   * Az első látogató eddig nem a landingot látta, hanem egy beállítás-ablakot
   * a tetején — ami ráadásul lefedte a jobb felső profilikont, vagyis az
   * egyetlen utat a belépéshez. A kérdései (címek nyelve, felnőtt tartalom)
   * egy profil beállításai; a marketingoldalon még nincs profil, amire
   * vonatkoznának.
   *
   * Nem elveszik, csak eltolódik: belépés után az afterAuth() újra megpróbálja,
   * és akkor már az alkalmazáson belül vagyunk.
   */
  maybeOnboard () {
    if (document.body.classList.contains('landing-route')) return
    // Kikapcsolt varázslóért nem töltünk le semmit (lásd features/onboarding/meta.js).
    if (!onboardingDue()) return
    // A varázsló a saját modulja, és csak akkor töltődik, amikor a lap már
    // kirajzolódott — az első betöltés útjából kimarad.
    const run = () => import('../features/onboarding/onboarding.js')
      .then(({ Onboarding }) => Onboarding?.maybeOpen())
      .catch(() => {})
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 3000 })
    else setTimeout(run, 1500)
  },

  /**
   * A könyvtár-szinkron — csak ha van fiók, amivel szinkronizálni lehet.
   *
   * Eddig a `main.js` statikusan importálta, tehát a kijelentkezett látogató is
   * letöltötte (15 KB), pedig nála minden hívása azonnal visszatért. Most az
   * első belépett indulás vagy belépés tölti be, és akkor is jelentkezik be a
   * tárnál megfigyelőként: onnantól tükrözi a változásokat a fiókba.
   */
  _librarySync () {
    this._syncModule ??= import('../features/library-sync/library-sync.js').then(({ LibrarySync }) => {
      observeStore({ sync: LibrarySync })
      return LibrarySync
    })
    return this._syncModule
  },

  // re-load config + permissions after a login/logout, then re-render
  async afterAuth () {
    await this.loadConfig()
    this._perms = null
    this.perms = YumeAPI.user() ? await YumeAPI.myPermissions() : []
    this._publishFeatureState()
    this.refreshAdminNav()
    this.applyNavVisibility()
    this.refreshProfileAvatar()
    this.navigate()

    if (YumeAPI.user()) this._librarySync().then(sync => sync.init()) // pull the account library + start mirroring
    else this._syncModule?.then(sync => sync.reset()) // signed out → stop mirroring

    // Belépés után már nem a kezdőképernyőn vagyunk: ha a varázsló eddig
    // kimaradt, most jön el az ideje.
    if (YumeAPI.user()) Prefs?.pull().then(() => this.maybeOnboard())
  },

  /**
   * A példány nyelvi házirendjének érvényesítése.
   *
   * A config aszinkron érkezik, az I18n.init pedig az első festés előtt fut —
   * különben angol villanna fel és javítaná magát. Így a házirend itt kerül
   * rá, amint megjött, és csak akkor rajzol újra, ha tényleg változott valami.
   */
  applyLanguagePolicy () {
    const site = this.config?.site
    if (!site) return
    const before = I18n.language()
    if (site.languageSwitching === false) I18n.setLanguage(site.defaultLanguage ?? 'hu')
    else if (!Prefs?.hasLanguage?.()) I18n.setLanguage(site.defaultLanguage ?? I18n.language())
    if (I18n.language() !== before) {
      this.applyNavLabels()
      this.navigate()
    }
  },

  async loadConfig () {
    /*
     * A HIBA ITT ÁLL MEG, nem az `init()`-ben.
     *
     * Eddig egy elhasalt kérés kidobta az `init()` egészét, tehát a
     * `navigate()` a végén SOSEM futott le — a lapot csak az menthette meg,
     * hogy egy korábbi, kapu nélküli navigáció már rajzolt valamit. Ez a
     * fordítottja annak, amit akartunk: a védelem múlott a véletlenen.
     */
    try {
      this.config = await YumeAPI.config()
      this._boot = 'ready'
    } catch (error) {
      this._boot = 'failed'
      console.error('a példány beállítása nem tölthető be; a lap korlátozottan működik', error)
    }
    this.applyLanguagePolicy()
    // The account's own profile row, which is where the picture lives. Best
    // effort: a viewer who is signed out, or an instance that cannot answer,
    // gets the initial-letter avatar rather than an error.
    this.viewer = YumeAPI.user() ? await YumeAPI.profile.get().catch(() => null) : null
    this._publishFeatureState()
  },

  // hide nav entries that are disabled or permission-gated-and-unavailable
  /**
   * A navigációs elemek elrejtése.
   *
   * A DÖNTÉS NEM ITT VAN, hanem a `pageAvailable`-ben — ugyanott, ahonnan a
   * lábléc is kérdezi. Korábban ez a függvény maga olvasta a kapcsolótáblát,
   * a lábléc pedig egy bedrótozott linklistát épített: egy adminban
   * kikapcsolt oldal eltűnt innen, és ott maradt lent. Itt már csak az van,
   * ami DOM-munka.
   */
  /**
   * A LAYOUT KIVÁLASZTÁSA — tisztán a címből, hálózat nélkül.
   *
   * Ez a metódus azért van külön, mert KÉT helyről kell: a `navigate()`-ből
   * minden útvonalváltáskor, és az `init()`-ből MÉG A KONFIGURÁCIÓ BETÖLTÉSE
   * ELŐTT.
   *
   * A második a lényeg. Az `init()` megvárja a `loadConfig()` hálózati körét,
   * és korábban csak utána futott az első `navigate()` — addig viszont az
   * `index.html` statikus váza, az ikonsávval együtt, teljes egészében
   * látszott. Lassú kapcsolaton ez több száz ezredmásodpercnyi ROSSZ keret a
   * kezdőképernyő vagy a belépőlap előtt, amit aztán egy csapásra lecserél a
   * helyes.
   *
   * Márpedig az, hogy egy útvonal az alkalmazás krómját kéri-e, tisztán a
   * címből eldől — nem kell hozzá se konfiguráció, se munkamenet. Tehát nem is
   * várunk rá.
   */
  applyLayout (route, { reveal = false } = {}) {
    /*
     * A `booting` CSAK AKKOR KERÜL LE, AMIKOR A KERET VÉGLEGES.
     *
     * A cím alapján meg lehet tippelni a keretet, de a KAPU felülbírálhatja:
     * egy privát példányon a `#/home` is a kezdőképernyőt rajzolja. Ha a
     * krómot már a tipp alapján megmutatnánk, a sorrend ez lenne:
     *
     *     ikonsáv megjelenik → a kapu dönt → ikonsáv eltűnik
     *
     * — vagyis pont az a villanás, ami ellen ez az egész van. Éles oldalon
     * mérve is látszott: `#/home`-on négy egymást követő mintavétel fogta
     * meg. A `reveal` ezért a `navigate()` kezében van, a kapu UTÁN.
     */
    if (reveal) document.body.classList.remove('booting')
    // A kezdőképernyőnek saját fejléce van, és telefonon nem kér alsó sávot:
    // aki még nem lépett be, annak a lebegő pill öt olyan helyre mutat, ahová
    // úgysem juthat el. A `_renderGate` is átírhatja: a kapu a
    // kezdőképernyőt rajzolja olyan útvonalon, amit még máshogy hívnak.
    document.body.classList.toggle('landing-route', route === 'landing')
    // Ugyanaz a megfontolás a belépőlapon: az ikonsáv olyan helyekre mutatna,
    // ahová a látogató épp most próbál eljutni.
    document.body.classList.toggle('login-route', route === 'login')
  },

  applyNavVisibility () {
    if (!this.config) return
    document.querySelectorAll('.sidebar-btn[data-route]').forEach(btn => {
      const route = btn.dataset.route
      if (route === 'admin') return // handled by refreshAdminNav
      btn.classList.toggle('nav-flag-hidden', !pageAvailable(route))
    })
  },

  // ---- quick search modal ----

  openSearchModal () {
    const backdrop = document.getElementById('search-modal')
    const input = document.getElementById('search-modal-input')
    if (!backdrop.classList.contains('hidden')) { input.focus(); return }
    // Ahonnan jött, oda tér vissza a fókusz bezáráskor — egy billentyűzetes
    // néző különben a lap elejéről kezdené újra.
    this._searchReturnFocus = document.activeElement
    backdrop.classList.remove('hidden')
    // A placeholder nyitáskor is beáll, mert a nyelv közben változhatott.
    input.placeholder = T('search.placeholder')
    input.setAttribute('aria-label', T('search.placeholder'))
    input.value = ''
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
    document.getElementById('search-modal-results').replaceChildren(
      U.el('div', { class: 'search-modal-empty', text: T('search.prompt') })
    )
    input.focus()
  },

  closeSearchModal () {
    const backdrop = document.getElementById('search-modal')
    if (backdrop.classList.contains('hidden')) return
    backdrop.classList.add('hidden')
    const back = this._searchReturnFocus
    this._searchReturnFocus = null
    if (back && typeof back.focus === 'function' && document.contains(back)) back.focus({ preventScroll: true })
  },

  initSearchModal () {
    const backdrop = document.getElementById('search-modal')
    const input = document.getElementById('search-modal-input')
    const results = document.getElementById('search-modal-results')

    input.placeholder = T('search.placeholder')
    document.getElementById('sidebar-search')?.addEventListener('click', () => this.openSearchModal())

    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) this.closeSearchModal()
    })

    /*
     * COMBOBOX: a fókusz a mezőben marad, a nyilak a találatok közt lépnek
     * (`aria-activedescendant`), az Enter megnyitja a kijelöltet — vagy, ha
     * nincs kijelölt, a teljes keresőt ugyanezzel a szöveggel. Eddig a
     * találatokhoz csak egérrel lehetett eljutni: a Tab a modál mögötti lapra
     * ugrott.
     */
    let active = -1
    const options = () => [...results.querySelectorAll('[role="option"]')]
    const highlight = index => {
      const list = options()
      active = list.length ? Math.max(-1, Math.min(index, list.length - 1)) : -1
      list.forEach((el, i) => {
        el.setAttribute('aria-selected', String(i === active))
        el.classList.toggle('selected', i === active)
      })
      if (active >= 0) {
        input.setAttribute('aria-activedescendant', list[active].id)
        list[active].scrollIntoView({ block: 'nearest' })
      } else {
        input.removeAttribute('aria-activedescendant')
      }
    }
    const option = (index, attrs, children) => U.el('a', {
      id: `qs-opt-${index}`,
      role: 'option',
      'aria-selected': 'false',
      tabindex: '-1',
      onclick: () => this.closeSearchModal(),
      ...attrs
    }, children)

    let token = 0
    input.addEventListener('input', U.debounce(async () => {
      const query = input.value.trim()
      const current = ++token
      active = -1
      input.removeAttribute('aria-activedescendant')
      if (query.length < 2) {
        input.setAttribute('aria-expanded', 'false')
        results.replaceChildren(U.el('div', { class: 'search-modal-empty', text: T('search.prompt') }))
        return
      }
      results.replaceChildren(P.spinner({ small: true }))
      try {
        // The Yume catalogue answers from Postgres with tiered ranking, which
        // matches romaji/english/native titles and synonyms. When no backend
        // is configured the client falls back to AniList so quick search keeps
        // working standalone. The detail route takes a Yume uuid, so every
        // catalogue row can be linked — also one without an AniList id.
        const suggestions = await YumeAPI.suggest(query, 8) ?? []
        const media = suggestions.length
          ? suggestions.map(s => ({
            id: s.anilist_id ?? s.id,
            title: { userPreferred: s.canonical_title },
            coverImage: { large: s.cover_key ?? '' },
            format: s.format,
            seasonYear: s.season_year,
            episodes: s.episode_count
          }))
          : (await (await import('../entities/anime/catalogue.js')).Catalogue.searchOrAniList({ search: query, sort: ['SEARCH_MATCH'], perPage: 8 })).media ?? []
        if (current !== token) return
        results.replaceChildren()
        input.setAttribute('aria-expanded', 'true')
        if (!media.length) {
          results.append(U.el('div', { class: 'search-modal-empty', text: T('search.empty') }))
        }
        media.forEach((m, i) => {
          results.append(option(i, { class: 'search-result', href: `#/anime/${m.id}` }, [
            U.el('img', { src: m.coverImage?.large ?? '', alt: '', loading: 'lazy', decoding: 'async' }),
            U.el('div', {}, [
              U.el('div', { class: 'search-result-title', text: U.title(m) }),
              U.el('div', { class: 'search-result-sub', text: [U.format(m), U.seasonYear(m), m.episodes ? `${m.episodes} ${T('ep')}` : null].filter(Boolean).join(' · ') })
            ])
          ]))
        })
        // A teljes kereső ugyanezzel a szöveggel — szűrőkkel, lapozással.
        results.append(option(media.length, {
          class: 'search-result search-result-all',
          href: `#/search?q=${encodeURIComponent(query)}`
        }, [document.createTextNode(T('All results in search'))]))
      } catch (e) {
        if (current !== token) return
        results.replaceChildren(U.el('div', { class: 'search-modal-empty', text: T('search.failed') + ' ' + e.message }))
      }
    }, 250))

    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); highlight(active + 1) } else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1) } else if (e.key === 'Enter') {
        e.preventDefault()
        const chosen = options()[active]
        if (chosen) { chosen.click(); return }
        const query = input.value.trim()
        if (query) {
          this.closeSearchModal()
          window.location.hash = `#/search?q=${encodeURIComponent(query)}`
        }
      }
    })

    document.addEventListener('keydown', e => {
      const modalOpen = !backdrop.classList.contains('hidden')
      if (modalOpen && e.key === 'Escape') {
        e.preventDefault()
        this.closeSearchModal()
        return
      }
      // A modálban egyetlen fókuszálható elem van, a mező: a Tab ne vigye ki
      // a fókuszt a mögötte lévő lapra.
      if (modalOpen && e.key === 'Tab') { e.preventDefault(); input.focus(); return }
      // Ctrl/Cmd+K or "s" (outside inputs) opens quick search — same keybinds as the app
      const inField = /^(input|textarea|select)$/i.test(document.activeElement?.tagName ?? '') || document.activeElement?.isContentEditable
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || (!inField && !modalOpen && e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault()
        this.openSearchModal()
      }
    })
  },

  refreshAdminNav () {
    const nav = document.getElementById('nav-admin')
    if (!nav) return
    // admin nav follows the same gate as the /admin route (page.admin flag)
    const canAdmin = this._gateCheck('admin').ok && !!YumeAPI.user()
    nav.classList.toggle('hidden', !canAdmin)
  },

  /**
   * The face in the sidebar.
   *
   * The account's chosen picture when there is one, and the initial otherwise.
   * `replaceChildren` rather than `textContent`, because the picture is an
   * <img> with the letter behind it — see C.avatar.
   */
  refreshProfileAvatar () {
    const el = document.getElementById('sidebar-avatar')
    const btn = document.getElementById('profile-switcher')
    if (!el) return
    const local = Store.profile()
    const account = this.viewer
    const user = YumeAPI.user()
    // Kijelentkezve ez a gomb a belépés: egy „Profil" feliratú kezdőbetű egy
    // nem létező fiók menüjét nyitotta.
    el.replaceChildren(user
      ? C.avatar({
        name: account?.display_name ?? local?.name ?? user.username,
        avatar_key: account?.avatar_key ?? local?.avatar
      }, { size: 'sm' })
      : U.svg('<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/>', 20))
    const label = btn?.querySelector('.sidebar-profile-label')
    if (label) label.textContent = user ? (account?.display_name || user.username || T('nav.profile')) : T('Sign in')
    if (btn) {
      btn.title = label?.textContent ?? ''
      if (user) btn.setAttribute('aria-haspopup', 'menu')
      else btn.removeAttribute('aria-haspopup')
    }
  },

  /**
   * The unread count in the sidebar.
   *
   * Local signals are counted synchronously so the badge is never blank while
   * a request is in flight; the account's server-side notifications — a
   * monitoring alert, say — are added when they arrive. Signed out or offline,
   * the second half resolves to nothing and the badge is what it always was.
   */
  refreshNotifBadge () {
    const badge = document.getElementById('notif-badge')
    if (!badge) return
    const paint = count => {
      badge.textContent = count > 9 ? '9+' : String(count)
      badge.classList.toggle('hidden', count === 0)
    }
    let local = 0
    try { local = Store.unreadCount() } catch (e) { /* no data */ }
    paint(local)

    YumeAPI?.notifications?.({ unreadOnly: true, limit: 100 })
      .then(rows => paint(local + rows.length))
      .catch(() => {})
  },

  /**
   * The menu behind the sidebar avatar.
   *
   * It used to open with a list of profiles to switch between, and a way to
   * manage them. Both are gone with the profile picker; what is left is what
   * the menu was actually used for — the three places a viewer goes to look at
   * their own account.
   */
  initAccountMenu () {
    const btn = document.getElementById('profile-switcher')
    if (!btn) return
    const close = ({ restoreFocus = false } = {}) => {
      document.getElementById('profile-menu')?.remove()
      btn.setAttribute('aria-expanded', 'false')
      document.removeEventListener('pointerdown', this._accountMenuOutside, true)
      if (restoreFocus) btn.focus()
    }
    btn.addEventListener('click', () => {
      if (!YumeAPI.user()) { window.location.hash = '#/login'; return }
      if (document.getElementById('profile-menu')) { close(); return }
      const icon = paths => U.svg(paths, 18)
      const item = (href, paths, label) => U.el('a', {
        class: 'profile-menu-item',
        role: 'menuitem',
        href,
        onclick: () => close()
      }, [icon(paths), document.createTextNode(label)])
      const account = this.viewer
      const user = YumeAPI.user()
      const menu = U.el('div', { class: 'profile-menu', id: 'profile-menu', role: 'menu', 'aria-label': T('Account') }, [
        U.el('div', { class: 'profile-menu-head' }, [
          C.avatar({ name: account?.display_name ?? user?.username, avatar_key: account?.avatar_key }, { size: 'md' }),
          U.el('div', { style: 'min-width:0' }, [
            U.el('div', { class: 'profile-menu-name', text: account?.display_name || user?.username || '' }),
            U.el('div', { class: 'profile-menu-sub', text: user?.username ? '@' + user.username : '' })
          ])
        ]),
        U.el('div', { class: 'profile-menu-sep', role: 'separator' }),
        item('#/profile', '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', T('Profile & stats')),
        item('#/profile?tab=analytics', '<path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="7"/><rect x="12" y="7" width="3" height="11"/><rect x="17" y="4" width="3" height="14"/>', T('Analytics')),
        item('#/profile?tab=achievements', '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>', T('Achievements')),
        U.el('div', { class: 'profile-menu-sep', role: 'separator' }),
        item('#/settings?tab=account', '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>', T('Account settings')),
        U.el('button', {
          class: 'profile-menu-item',
          type: 'button',
          role: 'menuitem',
          onclick: async () => {
            close()
            await YumeAPI.logout()
            U.toast(T('You are signed out.'))
            await this.afterAuth()
          }
        }, [icon('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>'), document.createTextNode(T('Sign out'))])
      ])
      document.body.append(menu)
      btn.setAttribute('aria-expanded', 'true')
      const rect = btn.getBoundingClientRect()
      menu.style.left = Math.min(rect.right + 8, window.innerWidth - menu.offsetWidth - 8) + 'px'
      menu.style.bottom = Math.max(8, window.innerHeight - rect.bottom) + 'px'
      const items = () => [...menu.querySelectorAll('[role="menuitem"]')]
      items()[0]?.focus()
      menu.addEventListener('keydown', e => {
        const list = items()
        const at = list.indexOf(document.activeElement)
        if (e.key === 'Escape') { e.preventDefault(); close({ restoreFocus: true }) } else if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length]?.focus() } else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus() } else if (e.key === 'Tab') { close() }
      })
      this._accountMenuOutside = e => { if (!menu.contains(e.target) && !btn.contains(e.target)) close() }
      document.addEventListener('pointerdown', this._accountMenuOutside, true)
    })
  },

  // ---- mobile "More" bottom sheet ----

  /**
   * Every destination that isn't a primary bottom-bar tab. Icons are inline
   * SVG paths (drawn via U.svg) so the sheet stays self-contained.
   *
   * A method rather than the array constant it used to be, and that is a fix
   * rather than a style change. As a constant its labels were translated when
   * app.js loaded — before I18n.init() had adopted the viewer's language — so
   * the sheet was frozen in whatever language happened to be active at load,
   * and switching language never updated it: applyNavLabels() re-translates
   * the sidebar buttons only.
   *
   * Making the client ES modules is what surfaced it. A module-evaluation-time
   * T() call reaches into i18n.js while it is still initialising, which is a
   * ReferenceError rather than the wrong string — the same bug, finally loud.
   */
  moreItems () {
    return [
      { route: 'dashboard', label: T('Dashboard'), icon: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>' },
      { route: 'schedule', label: T('Schedule'), icon: '<rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>' },
      { route: 'w2g', label: T('Together'), icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>' },
      { route: 'community', label: T('Community'), icon: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>' },
      { route: 'changelog', label: T('Development log'), icon: '<path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/>' },
      { route: 'profile', label: T('Profile'), icon: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>' },
      { route: 'profile', href: '#/profile?tab=analytics', label: T('Analytics'), icon: '<path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="7"/><rect x="12" y="7" width="3" height="11"/><rect x="17" y="4" width="3" height="14"/>' },
      { route: 'profile', href: '#/profile?tab=achievements', label: T('Awards'), icon: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>' },
      { route: 'settings', label: T('Settings'), icon: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>' }
    ]
  },

  initMobileMore () {
    const btn = document.getElementById('nav-more')
    if (!btn) return
    btn.addEventListener('click', () => {
      if (document.getElementById('more-sheet')) { this.closeMoreSheet(); return }
      this.openMoreSheet()
    })
  },

  /**
   * The collapse tab on the mobile navigation pill.
   *
   * Labels cost about a third of the bar's height, and somebody who knows the
   * five icons would rather have that third back. The choice is remembered,
   * because a viewer who collapses it means it for more than one page.
   *
   * Built here rather than in index.html: it only exists below 720px, and a
   * control the desktop never shows has no business in the served markup where
   * a screen reader on a wide window would still announce it.
   */
  /**
   * Az oldalsáv összecsukása — gomb és beállítás, egy állapotra.
   *
   * A választás a PROFIL beállításai közt él (`Store.settings().navCollapsed`),
   * nem külön `localStorage` kulcson. Így a beállítások lapról is állítható,
   * profilonként külön, és az adatmentés is viszi. A sávon lévő gomb ugyanoda
   * ír — két kapcsoló, egy igazság.
   *
   * Keskeny képernyőn az oldalsáv nem látszik (ott az alsó sáv navigál), tehát
   * a beállításnak ott nincs hatása; ezt a beállítások lap ki is mondja.
   */
  initNavCollapse () {
    const sidebar = document.getElementById('sidebar')
    if (!sidebar || sidebar.querySelector('.nav-collapse')) return

    const tab = U.el('button', {
      class: 'nav-collapse',
      type: 'button',
      'aria-controls': 'sidebar',
      onclick: () => {
        Store.saveSettings({ navCollapsed: !Store.settings().navCollapsed })
        this.applyNavCollapsed()
      }
    }, [U.svg('<polyline points="6 9 12 15 18 9"/>', 16), U.el('span', { text: T('Collapse') })])

    sidebar.append(tab)

    /*
     * ÁTKÖLTÖZTETÉS a régi kulcsról, egyszer.
     *
     * Aki már összecsukta a sávot, annak a választása a `yume-nav-collapsed`
     * kulcsban ül. Enélkül az első betöltésnél visszaugrana nyitottra — egy
     * csendes „elfelejtettük, amit beállítottál".
     */
    try {
      const regi = window.localStorage.getItem('yume-nav-collapsed')
      if (regi !== null) {
        Store.saveSettings({ navCollapsed: regi === '1' })
        window.localStorage.removeItem('yume-nav-collapsed')
      }
    } catch { /* a tárolás tiltva: nincs mit átköltöztetni */ }

    this.applyNavCollapsed()
  },

  /**
   * Az összecsukott állapot érvényesítése a beállításból.
   *
   * Külön metódus, mert KÉT helyről kell: a sávon lévő gombtól és a
   * beállítások lapról. Az utóbbi a `shell.js`-en át hívja — egy képernyő ne
   * a DOM-ot igazgassa a router helyett, mert akkor a gomb felirata és az
   * `aria` állapot előbb-utóbb széttart attól, amit a sáv mutat.
   */
  /**
   * A keret minden szövege újra, az aktuális nyelven.
   *
   * A szótár lusta (csak annak jön le, aki azon a nyelven olvas): az induló
   * kód egy része még előtte feliratoz. Az összecsukó gomb és a gyorskereső
   * helyőrzője futás közbeni nyelvváltáskor sem frissült eddig — a navigáció
   * feliratai igen, ezek nem.
   */
  _relabelShell () {
    this.applyNavLabels()
    this.applyNavCollapsed()
    const input = document.getElementById('search-modal-input')
    if (input) input.placeholder = T('search.placeholder')
  },

  applyNavCollapsed () {
    const sidebar = document.getElementById('sidebar')
    const tab = sidebar?.querySelector('.nav-collapse')
    if (!sidebar || !tab) return
    const collapsed = Store.settings().navCollapsed === true
    sidebar.classList.toggle('nav-collapsed', collapsed)
    tab.setAttribute('aria-expanded', String(!collapsed))
    // Telefonon a feliratokat rejti, asztalon az egész sávot csukja össze —
    // a felirat mindkettőt a maga nevén mondja.
    const narrow = window.matchMedia?.('(max-width: 767px)').matches
    const label = narrow
      ? (collapsed ? T('Show labels') : T('Hide labels'))
      : (collapsed ? T('Expand sidebar') : T('Collapse sidebar'))
    tab.setAttribute('aria-label', label)
    tab.title = label
    const text = tab.querySelector('span')
    if (text) text.textContent = collapsed ? T('Expand') : T('Collapse')
  },

  openMoreSheet () {
    const current = this.parseHash().route
    const trigger = document.getElementById('nav-more')
    const backdrop = U.el('div', { class: 'more-backdrop', id: 'more-backdrop', onclick: () => this.closeMoreSheet() })
    const sheet = U.el('div', {
      class: 'more-sheet',
      id: 'more-sheet',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': T('nav.more')
    })

    sheet.append(U.el('div', { class: 'more-grabber', 'aria-hidden': 'true' }))

    const p = Store.profile()
    const account = this.viewer
    const user = YumeAPI.user()
    sheet.append(U.el('div', { class: 'more-profile' }, user
      ? [
          U.el('div', { class: 'more-profile-avatar' }, [
            C.avatar({ name: account?.display_name ?? p?.name ?? user.username, avatar_key: account?.avatar_key ?? p?.avatar }, { size: 'md' })
          ]),
          U.el('div', { style: 'min-width:0;' }, [
            U.el('div', { class: 'more-profile-name', text: account?.display_name || user.username }),
            U.el('div', { class: 'more-profile-sub', text: '@' + user.username })
          ]),
          U.el('a', { class: 'btn btn-secondary btn-sm', href: '#/settings?tab=account', onclick: () => this.closeMoreSheet() }, [document.createTextNode(T('Account'))])
        ]
      : [
          U.el('div', { style: 'min-width:0;' }, [
            U.el('div', { class: 'more-profile-name', text: T('Not signed in') }),
            U.el('div', { class: 'more-profile-sub', text: T('Your library and history on every device.') })
          ]),
          U.el('a', { class: 'btn btn-primary btn-sm', href: '#/login', onclick: () => this.closeMoreSheet() }, [document.createTextNode(T('Sign in'))])
        ]))

    // build the destination grid, appending Admin only when it's available
    const items = this.moreItems()
    const adminNav = document.getElementById('nav-admin')
    if (adminNav && !adminNav.classList.contains('hidden')) {
      items.splice(items.length - 1, 0, { route: 'admin', label: T('Admin'), icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>' })
    }

    const grid = U.el('div', { class: 'more-grid' })
    for (const it of items) {
      // hide destinations disabled / gated-unavailable by the site config
      const g = this._gateCheck(it.route)
      if (!g.ok && (g.kind === 'disabled' || g.kind === 'permission')) continue
      // plain profile route is "active" only for the bare Profile item, not its tabs
      const isActive = it.route === current && (it.route !== 'profile' || !it.href)
      grid.append(U.el('a', {
        class: 'more-item' + (isActive ? ' active' : ''),
        href: it.href ?? `#/${it.route}`,
        ...(isActive ? { 'aria-current': 'page' } : {}),
        onclick: () => this.closeMoreSheet()
      }, [U.svg(it.icon, 22), U.el('span', { text: it.label })]))
    }
    sheet.append(grid)

    document.body.append(backdrop, sheet)
    trigger?.setAttribute('aria-expanded', 'true')
    this._closeMoreTrap = C.trapModal(sheet, { onClose: () => this.closeMoreSheet({ fromTrap: true }) })
    // next frame -> trigger the slide-up / fade-in transitions
    requestAnimationFrame(() => { backdrop.classList.add('open'); sheet.classList.add('open') })
  },

  closeMoreSheet ({ fromTrap = false } = {}) {
    const backdrop = document.getElementById('more-backdrop')
    const sheet = document.getElementById('more-sheet')
    document.getElementById('nav-more')?.setAttribute('aria-expanded', 'false')
    // A csapda saját bezárása (Escape) már levette a figyelőt és visszaadta a
    // fókuszt; kívülről hívva (háttér, navigáció) mi kérjük meg rá.
    const trap = this._closeMoreTrap
    this._closeMoreTrap = null
    if (trap && !fromTrap) trap({ keepNode: true, silent: true })
    if (sheet) { sheet.classList.remove('open'); sheet.id = ''; setTimeout(() => sheet.remove(), 300) }
    if (backdrop) { backdrop.classList.remove('open'); backdrop.id = ''; setTimeout(() => backdrop.remove(), 300) }
  },

  /**
   * Nav labels from the central copy catalog, translated.
   *
   * Its own method because a language switch has to re-run it — as one call
   * inside init() the sidebar kept its old language until a full reload.
   */
  applyNavLabels () {
    document.querySelectorAll('.sidebar-btn').forEach(btn => {
      // Az első span nem mindig a felirat: a profilgombon az avatar áll elöl,
      // és amíg `querySelector('span')`-t kerestünk, a gomb tooltipje a
      // rókaemodzsi lett. A `:scope >` sem díszítés — az avatar maga is egy
      // spant tartalmaz (C.avatar rajzolja bele), ami fabejárásban előbb jön,
      // mint a felirat, tehát egy mély keresés a *képbe* írná a szöveget.
      if (btn.id === 'profile-switcher') return // a fiók nevét írja ki, lásd refreshProfileAvatar
      const span = btn.querySelector(':scope > span:not(.sidebar-avatar):not(.notif-badge)')
      const key = btn.id === 'nav-more' ? 'more' : btn.dataset.route
      if (span && key && Copy?.nav?.[key]) span.textContent = T('nav.' + key)
      const label = span?.textContent
      if (label) btn.title = label
    })
    // A csoportcímek és a gyorskereső gombja is a néző nyelvén.
    document.querySelectorAll('.sidebar-group-label[data-label]').forEach(el => {
      el.textContent = T(el.dataset.label)
    })
    const quick = document.querySelector('.sidebar-search-label')
    if (quick) quick.textContent = T('Quick search')
    document.getElementById('sidebar-search')?.setAttribute('aria-label', T('Quick search') + ' (Ctrl+K)')
    document.getElementById('sidebar')?.setAttribute('aria-label', T('Main navigation'))
    this.refreshProfileAvatar()
  },

  async init () {
    Store.ensureProfiles()
    Store.applyTheme()

    // Language before anything renders, so the first paint is already in the
    // viewer's language rather than flashing English and correcting itself.
    // Switching re-renders in place: a language change that demanded a reload
    // would throw away scroll position and any open panel.
    I18n.init(() => {
      // Az első festés előtt nincs mit újrarajzolni: az `init` úgyis megvárja
      // a szótárt, mielőtt először navigál.
      if (!this._booted) return
      this._relabelShell()
      this.navigate()
    })
    // A kezdő képernyő modulja és stíluslapja már most indul, a konfigurációval
    // párhuzamosan — a navigáció addigra jellemzően a kész modult kapja.
    this.prefetchRoute(this.parseHash().route)
    this.refreshProfileAvatar()
    this.refreshNotifBadge()
    this.initAccountMenu()
    this.normalisePath()
    /*
     * A KERET ELŐBB, MINT A HÁLÓZAT. Lásd `applyLayout`: enélkül a statikus
     * váz ikonsávja végigvillan a kezdőképernyő és a belépőlap előtt, amíg a
     * `loadConfig()` válasza megjön.
     */
    this.applyLayout(this.parseHash().route)
    this.applyNavLabels()
    this.initSearchModal()
    this.initMobileMore()
    this.initNavCollapse()
    /*
     * A karbantartás figyelése.
     *
     * Kétpercenként kérdez, karbantartás alatt húszmásodpercenként — és a
     * változásra ÚJRARAJZOL, hogy a néző ne egy elavult oldalt nézzen, amikor
     * már vége.
     */
    this._maintenance = createMaintenanceService({})
    this._maintenance.subscribe(() => { this.navigate() })
    this._maintenance.start()

    window.addEventListener('hashchange', () => {
      this.closeMoreSheet()
      this.closeSearchModal()
      document.getElementById('profile-menu')?.remove()
      this.navigate()
    })
    // A görgetés helye a history-bejegyzésbe: a vissza gomb ide tér vissza
    // (lásd `_navigateOnce`). Ritkítva, mert a `replaceState` nem ingyenes.
    let scrollTimer = null
    window.addEventListener('scroll', () => {
      if (scrollTimer) return
      scrollTimer = setTimeout(() => {
        scrollTimer = null
        try {
          window.history.replaceState({ ...(window.history.state ?? {}), yumeScroll: Math.round(window.scrollY) }, '')
        } catch { /* egy beágyazott nézet tilthatja: akkor nincs visszaállítás */ }
      }, 150)
    }, { passive: true })

    // load DB-driven site config + permissions, apply the site name, then route
    await this.loadConfig()
    this.perms = YumeAPI.user() ? await YumeAPI.myPermissions() : []
    this._publishFeatureState()
    this.refreshProfileAvatar()
    if (this.config?.site?.name) {
      const logoText = document.querySelector('.sidebar-logo-text')
      if (logoText) logoText.textContent = this.config.site.name.toLowerCase()
      this.setTitle(null)
    }
    await this.applyDefaultTheme()
    this.refreshAdminNav()
    this.applyNavVisibility()
    // A nyelv szótára (ha kell) az első festés előtt megérkezik: a lap ne
    // villanjon angolul, hogy aztán magyarra váltson.
    await I18n.ready()
    this._relabelShell()
    this._booted = true
    this.navigate()

    // sign-in library sync (best-effort, off the critical path)
    if (YumeAPI.user()) this._librarySync().then(sync => sync.init())

    // Preferences the viewer may have set on another device win over whatever
    // this browser happens to hold, then the wizard runs if this profile has
    // never answered. Both are off the critical path: the page is already
    // rendered by now, so neither can delay the first paint.
    if (YumeAPI.user()) {
      Prefs?.pull().then(() => this.maybeOnboard())
    } else {
      this.maybeOnboard()
    }
    window.addEventListener('library-synced', () => {
      // A fiókból most megérkezett könyvtár ezeken a lapokon számokat és sorokat
      // változtat — egy új eszközön a profil különben nulla címet mutatna.
      if (['home', 'list', 'dashboard', 'profile'].includes(this.parseHash().route)) this.navigate()
    })
  }
}
