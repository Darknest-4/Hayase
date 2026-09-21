// What the server has told this client about itself: the site's name and
// tagline, and which optional features are switched on for the viewer.
//
// A module rather than properties on the router, because the shared UI asks
// these questions — the footer wants the site name, a card wants to know
// whether hover previews are on — and a component that imports the router to
// find out has inverted the dependency: the foundation then needs the
// application standing on it, and cannot be lifted into a package a second
// application (the admin panel) could share.
//
// The router still owns the *answer*: it loads the configuration and the
// viewer's permissions and calls configure(). This only remembers, and
// everything else is reading rather than reaching.

let config = null
let permissions = []
/** The signed-in account's own profile row: display name, and its artwork. */
let viewer = null
let signedIn = () => false

/** The site's own settings — name, tagline, whether it is private. */
export function site () {
  return config?.site ?? null
}

/**
 * Tud-e ez a példány bármit lejátszani.
 *
 * Alapértelmezésben igen: amíg a konfiguráció meg nem jött, egy elrejtett
 * gomb rosszabb, mint egy, ami esetleg nem vezet sehova — a lejátszóoldal
 * kapuja úgyis megfogja. Csak egy határozott `false` rejt el bármit.
 */
export function playbackAvailable () {
  return site()?.playbackAvailable !== false
}

/** The preference schema the server publishes, when it has been loaded. */
export function preferences () {
  return config?.preferences ?? null
}

/** Called by the router once the configuration and permissions have loaded. */
export function configure (options = {}) {
  if ('config' in options) config = options.config
  if ('permissions' in options) permissions = options.permissions ?? []
  if ('viewer' in options) viewer = options.viewer ?? null
  if ('signedIn' in options) signedIn = options.signedIn ?? (() => false)
}

/**
 * Is this feature available to the person looking?
 *
 * Absent configuration means yes: a client that has not reached the API yet
 * should render the site rather than an empty shell, and the server refuses
 * anything the flag would have hidden regardless — a flag is presentation,
 * never the enforcement point.
 */
/**
 * The grants this viewer holds.
 *
 * Returned as a copy: a page that wanted to know what to draw once managed to
 * push onto the array it was handed, and every later question answered yes.
 *
 * This is for deciding what to *offer* — a moderator's pin button, the "new
 * board" form. It is not authorisation: every one of those actions is checked
 * again on the server, which is the only check that counts.
 */
export function permissionsHeld () {
  return [...permissions]
}

/**
 * The account's profile as the server holds it — the picture included.
 *
 * Local settings still own the name a signed-out viewer chose; this is the
 * account's own row, and it is what the sidebar, the comments and the profile
 * header draw. Null when signed out, which every caller has to handle anyway.
 */
export function viewerProfile () {
  return viewer
}

/**
 * Az útvonalak, amiket a hozzáférési kapu SOSEM zár el.
 *
 * Itt, és nem a routerben: a navigációs elemek láthatósága és a kapu döntése
 * ugyanabból a listából kell dolgozzon. Két külön másolat pont azt a
 * széttartást adná, ami miatt ez a modul bővült — a belépőlap eltűnése a
 * menüből egy privát példányon azt jelentené, hogy nincs út befelé.
 */
export const GATE_EXEMPT = ['settings', 'landing', 'login']

/**
 * Elérhető-e ez az oldal ANNAK, AKI ÉPP NÉZI.
 *
 * EZ AZ EGYETLEN HELY, AHOL EZ ELDŐL. Korábban a fejléc (`applyNavVisibility`)
 * futásidőben szűrt a kapcsolótáblából, a lábléc viszont egy BEDRÓTOZOTT
 * linklistát épített újra minden rendereléskor — vagyis egy adminban
 * kikapcsolt oldal eltűnt a fejlécből, és ott maradt a láblécben. Ugyanaz a
 * kérdés, két külön válasz.
 *
 * A szabály sorrendje számít:
 *
 *   1. konfiguráció nélkül IGENT mondunk — egy még be nem töltött beállítás ne
 *      ürítse ki a navigációt; a kapu és a kiszolgáló úgyis megfogja, ami nem
 *      jár;
 *   2. privát példányon a kijelentkezett látogatónak csak a mentes útvonalak;
 *   3. hiányzó kapcsolósor = „ezt senki nem állította be" → jár. Így egy új
 *      oldal nem tűnik el a régi telepítéseken;
 *   4. kikapcsolva vagy jogosultsághoz kötve → csak annak, aki jogosult.
 *
 * NEM BIZTONSÁGI HATÁR. Ez azt mondja meg, mit AJÁNLUNK fel; amit egy oldal
 * tényleg kiszolgál, azt a kiszolgáló dönti el.
 */
export function pageAvailable (route) {
  if (!config) return true
  if (config.site?.requireLogin && !signedIn() && !GATE_EXEMPT.includes(route)) return false
  const flag = config.flags?.['page.' + route]
  if (!flag) return true
  if (!flag.enabled) return false
  if (flag.access === 'permission' && !permissions.includes(flag.permission)) return false
  return true
}

/**
 * Létezik-e egyáltalán ez a kapcsoló a szerver tábláján.
 *
 * A `featureOn` szándékosan MEGENGEDŐ: amiről a tábla nem tud, azt átengedi,
 * hogy egy új funkció ne tűnjön el a régi telepítéseken. Van, aminél pont ez
 * a rossz irány — egy teljes lejátszócserénél a hiányzó sor nem „engedd át",
 * hanem „még nem kapcsoltuk be". Az ilyen hívó ezt kérdezi meg előbb.
 */
export function flagDeclared (key) {
  return Boolean(config?.flags?.[key])
}

export function featureOn (name) {
  if (!config) return true
  const flag = config.flags?.['feature.' + name]
  if (!flag || !flag.enabled) return !flag
  if (flag.access === 'auth' && !signedIn()) return false
  if (flag.access === 'permission' && !permissions.includes(flag.permission)) return false
  return true
}
