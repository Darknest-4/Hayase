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

export function featureOn (name) {
  if (!config) return true
  const flag = config.flags?.['feature.' + name]
  if (!flag || !flag.enabled) return !flag
  if (flag.access === 'auth' && !signedIn()) return false
  if (flag.access === 'permission' && !permissions.includes(flag.permission)) return false
  return true
}
