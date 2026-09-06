/* global window */
// ============================================================================
// CENTRAL COPY CATALOG — every fixed piece of text on the site lives here.
// Change a label once here and it updates everywhere it is used. Read in the
// UI via T('path.to.key'), e.g. T('home.rails.trending').
//
// This is the single place to edit site copy — no need to hunt through the
// page code. Keep the keys; edit the values.
// ============================================================================

window.Copy = {
  // left sidebar + mobile bottom bar
  nav: {
    home: 'Home',
    dashboard: 'Dashboard',
    search: 'Search',
    schedule: 'Schedule',
    w2g: 'Watch Together',
    community: 'Community',
    list: 'Library',
    notifications: 'Notifications',
    themes: 'Themes',
    admin: 'Admin',
    settings: 'Settings',
    more: 'More'
  },

  // home page rails (the horizontal rows of anime)
  home: {
    rails: {
      popularSeason: 'Popular This Season',
      trending: 'Trending Now',
      airing: 'Airing Right Now',
      allTimePopular: 'All Time Popular',
      topRated: 'Top Rated',
      movies: 'Movies',
      romance: 'Romance',
      action: 'Action',
      adventure: 'Adventure',
      fantasy: 'Fantasy'
    },
    continueWatching: 'Continue Watching',
    sequelsYouMissed: 'Sequels You Missed',
    yourList: 'Your List'
  },

  // weekly airing schedule
  schedule: {
    title: 'Airing Schedule',
    today: 'Today',
    tomorrow: 'Tomorrow',
    empty: 'Nothing airing this week.',
    loadError: 'Failed to load schedule: ',
    episodeShort: 'Ep '
  },

  // quick search (Ctrl+K) and the search page
  search: {
    prompt: 'Type to search…',
    empty: 'No results.',
    failed: 'Search failed:',
    placeholder: 'Search anime...',
    catalogueBadge: 'catalogue',
    matchedVia: 'matched'
  },

  // site footer
  footer: {
    tagline: 'Track, discover and watch anime — your list, your profiles, your way.',
    discover: 'Discover',
    library: 'Library',
    community: 'Community',
    yume: 'Yume',
    myLibrary: 'My Library',
    profile: 'Profile',
    watchHistory: 'Watch History',
    analytics: 'Analytics',
    colophon: 'built on the Yume design system'
  },

  // small, reused labels and buttons
  common: {
    watchNow: 'Watch now',
    trailer: 'Trailer',
    addToList: 'Add to list',
    inYourList: '✓ In your list',
    loading: 'Loading…',
    somethingWrong: 'Something went wrong'
  }
}
