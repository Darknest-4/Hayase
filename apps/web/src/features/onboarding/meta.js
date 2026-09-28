// A bemutató varázsló adatai és indítási döntése — a felülete nélkül.
//
// Két helyről kell: a beállítások oldal ugyanezekkel a feliratokkal kínálja a
// választásokat (`ONBOARDING_CHOICES`), a router pedig itt kérdezi meg, esedékes-e
// a varázsló (`onboardingDue`). Eddig mindkettő az egész varázslót betöltötte — a
// router minden oldalon, üresjáratban —, pedig a varázsló ki van kapcsolva
// (59378d4e óta a `due()` hamis). Amíg ki van kapcsolva, a felülete és a
// stíluslapja le sem töltődik; visszakapcsolni itt kell.

/** Human labels for enum values. The spec carries keys, not prose. */
export const ONBOARDING_CHOICES = {
  'language.ui': [
    { value: 'hu', label: 'Magyar', hint: 'Hungarian interface' },
    { value: 'en', label: 'English', hint: 'English interface' }
  ],
  'language.titles': [
    { value: 'romaji', label: 'Romaji', hint: 'Shingeki no Kyojin' },
    { value: 'english', label: 'English', hint: 'Attack on Titan' },
    { value: 'hungarian', label: 'Magyar', hint: 'Titles where a Hungarian one exists' },
    { value: 'native', label: '日本語', hint: '進撃の巨人' }
  ],
  'playback.variant': [
    { value: 'sub', label: 'Subtitled', hint: 'Original audio with subtitles' },
    { value: 'dub', label: 'Dubbed', hint: 'Dubbed audio when there is one' },
    { value: 'any', label: 'No preference', hint: 'Whatever plays best' }
  ]
}

/** Esedékes-e a varázsló. Jelenleg kikapcsolva (lásd fent). */
export function onboardingDue () {
  return false
}
