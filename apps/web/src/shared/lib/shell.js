// What a screen may ask of the application shell around it.
//
// A page needs to re-route after an action, refresh the unread badge, or put a
// name in the browser tab. Importing the router to do that inverts the
// dependency — twelve screens and one feature did, which meant no screen could
// be loaded, tested or reused without the whole router and everything it
// imports coming with it, and the router imports every screen.
//
// So the shell registers what it can do, and screens ask for it by name. The
// wiring happens once, in app/main.js.
//
// Deliberately small. This is not a service locator: adding to it is a claim
// that a screen genuinely needs the shell to act, and most do not — the four
// entries here are the four that survived asking.

const noop = () => {}

const shell = {
  /** Re-run the router for the current address. */
  navigate: noop,
  /** Re-translate the navigation labels after a language change. */
  applyNavLabels: noop,
  /** Put a name in the browser tab, or null for the site's own. */
  setTitle: noop,
  /** Re-read the unread count and repaint the badge. */
  refreshNotifications: noop,
  /** Re-read the configuration, permissions and nav visibility after a change. */
  refreshChrome: async () => {}
}

export function provideShell (implementation) {
  Object.assign(shell, implementation)
}

export const navigate = (...args) => shell.navigate(...args)
export const applyNavLabels = (...args) => shell.applyNavLabels(...args)
export const setTitle = (...args) => shell.setTitle(...args)
export const refreshNotifications = (...args) => shell.refreshNotifications(...args)
export const refreshChrome = (...args) => shell.refreshChrome(...args)
