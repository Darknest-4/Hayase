// The client's entry point: the one script index.html loads.
//
// Everything below it is an ES module with real imports, so the browser
// resolves the graph and this file only has to name what is not reached by an
// import from somewhere else:
//
//   * the Hungarian catalogue, which registers itself into I18n;
//   * the HLS adapter, which registers itself into the stream engine;
//   * where the ambient banner images come from;
//   * who listens to the store — the library sync and the achievements screen;
//   * what a screen may ask of the shell: navigate, retitle, refresh;
//   * App.init(), which used to sit at the bottom of app.js and ran on load.
//
// That last one is why this file exists rather than a bare
// `<script type="module" src="router.js">`. A module that boots the
// application as a side effect of being imported cannot be imported by a
// test, and the router is imported by nine page modules.
//
// It is also the composition root, which is the useful part: the wiring that
// would otherwise be an upward import lives here instead. shared/ui knows how
// to draw a banner; it does not know that *this* application resolves anime
// through a catalogue that falls back to AniList, and the admin panel has no
// catalogue at all.

import { LibrarySync } from '../features/library-sync/library-sync.js'
import { PageAchievements } from '../features/achievements/achievements.js'
import { Catalogue } from '../entities/anime/catalogue.js'
import { provideShell } from '../shared/lib/shell.js'
import { observeStore } from '../shared/state/store.js'
import { C } from '../shared/ui/components.js'
import { App } from './router.js'

// Side-effect imports. Each registers itself with something it imports;
// nothing holds a reference back, so they are named here or never loaded.
import '../shared/i18n/hu.js'
import '../features/player/hls-handler.js'

// What a screen may ask of the shell around it. Registered here so a page can
// re-route or refresh a badge without importing the router — which imports
// every page, and so could not be imported back by one.
provideShell({
  navigate: () => App.navigate(),
  applyNavLabels: () => App.applyNavLabels(),
  setTitle: text => App.setTitle(text),
  refreshNotifications: () => App.refreshNotifBadge(),
  refreshChrome: async () => {
    await App.loadConfig()
    App.applyNavVisibility()
    App.refreshAdminNav()
  }
})

// The store reports what changed; these decide what that means. Registering
// here is what keeps shared/state from importing a feature and a page.
observeStore({
  sync: LibrarySync,
  achievements: PageAchievements
})

C.useBannerSource(async () => {
  const page = await Catalogue.searchOrAniList({ sort: ['POPULARITY_DESC'], perPage: 50 })
  return (page.media ?? []).filter(media => media.bannerImage)
})

App.init()
