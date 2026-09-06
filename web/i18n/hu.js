/* global window, I18n */
// Magyar fordítás.
//
// A kulcs az angol eredeti — ha egy sor hiányzik innen, az angol szöveg
// jelenik meg, nem egy azonosító és nem üres gomb. Lásd web/js/i18n.js.
//
// Amit szándékosan NEM fordítunk: tulajdonnevek és rövidítések (Yume, AniList,
// MyAnimeList, AL, MAL), illetve a demóadatok. Ezek magyarul is ugyanúgy
// hangzanak, és a lefordításuk csak zavart okozna.

I18n.register('hu', {
  // ---------------------------------------------------------------- navigáció
  Home: 'Főoldal',
  Search: 'Keresés',
  Schedule: 'Menetrend',
  Library: 'Könyvtár',
  Community: 'Közösség',
  Together: 'Közös nézés',
  Notifications: 'Értesítések',
  Settings: 'Beállítások',
  Profile: 'Profil',
  Dashboard: 'Áttekintés',
  Analytics: 'Statisztika',
  History: 'Előzmények',
  Achievements: 'Eredmények',
  Extensions: 'Kiegészítők',
  Admin: 'Adminisztráció',
  More: 'Továbbiak',
  Overview: 'Áttekintés',
  Details: 'Részletek',
  Information: 'Információ',
  Activity: 'Aktivitás',
  Awards: 'Elismerések',
  Comments: 'Hozzászólások',
  Episodes: 'Epizódok',
  episodes: 'epizód',
  Tags: 'Címkék',
  Status: 'Állapot',
  Content: 'Tartalom',
  Data: 'Adatok',
  Account: 'Fiók',
  Appearance: 'Megjelenés',
  About: 'Névjegy',

  // ---------------------------------------------------------------- lejátszás
  'Watch now': 'Megnézem',
  'Start Watching': 'Megnézem',
  Play: 'Lejátszás',
  'Play next': 'Következő',
  ' Play next': ' Következő',
  'Next episode': 'Következő rész',
  'Up next': 'Következik',
  'Continue watching': 'Folytatom',
  'Continue Watching': 'Folytatás',
  'Pick something to watch': 'Válassz valamit',
  'Mark watched': 'Megnézettnek jelöl',
  'Skip intro': 'Főcím átugrása',
  'Auto-skip intro / outro': 'Főcím és végefőcím automatikus átugrása',
  Fullscreen: 'Teljes képernyő',
  'Picture in picture': 'Kép a képben',
  'Picture-in-picture unavailable': 'A kép a képben nem érhető el',
  Speed: 'Sebesség',
  'Your progress': 'Hol tartasz',
  'Your Progress': 'Hol tartasz',
  'Increase progress': 'Előrelépés',
  'Decrease progress': 'Visszalépés',
  '+1 episode': '+1 rész',
  '-1 episode': '−1 rész',
  Filler: 'Töltelék',
  FILLER: 'TÖLTELÉK',
  'Automatically saved. You’ll resume right where you left off.':
    'Automatikusan mentve. Ott folytatod, ahol abbahagytad.',

  // ---------------------------------------------------------------- források
  'Pick a source': 'Válassz forrást',
  'Pick another source': 'Válassz másik forrást',
  'Change source': 'Forrásváltás',
  'Manual source': 'Kézi forrás',
  'Official streams': 'Hivatalos szolgáltatók',
  'Where to watch': 'Hol nézhető',
  'Paste a stream URL first': 'Előbb illessz be egy stream URL-t',
  'Paste a direct stream URL. Add more on separate lines and the player falls back automatically if one fails. Installed extensions supply sources here too.':
    'Illessz be egy közvetlen stream URL-t. Több sorba írva a lejátszó automatikusan a következőre vált, ha az egyik nem indul. A telepített kiegészítők is ide adják a forrásaikat.',
  'https://… direct video stream (mp4 / webm) — one per line to enable automatic fallback':
    'https://… közvetlen videostream (mp4 / webm) — soronként egy, így lesz automatikus váltás',
  'Could not play this episode from any available source.':
    'Ezt a részt egyik elérhető forrásból sem sikerült lejátszani.',
  'No episode data available.': 'Nincs elérhető epizódadat.',
  'Invalid watch link.': 'Érvénytelen nézési hivatkozás.',

  // ---------------------------------------------------------------- könyvtár
  'Add to list': 'Listára teszem',
  '+ Add to list': '+ Listára teszem',
  'Remove from list': 'Levétel a listáról',
  'Removed from list': 'Levéve a listáról',
  'Add to Planning': 'Tervezettekhez',
  'Added to Planning': 'Tervezettek közé került',
  'Already on your list': 'Már a listádon van',
  'List status': 'Listaállapot',
  Planning: 'Tervezett',
  Airing: 'Adásban',
  'Airing soon': 'Hamarosan',
  Favourite: 'Kedvenc',
  'Your score': 'Értékelésed',
  'Nothing here yet. Add anime from their detail page.':
    'Itt még nincs semmi. Az adatlapjukról tehetsz ide animéket.',
  'Your library is empty — add some anime and your stats will grow here.':
    'A könyvtárad üres — tegyél bele animéket, és itt épül fel a statisztikád.',
  'No favourites yet.': 'Még nincs kedvenced.',
  'Failed to load favourites.': 'A kedvencek betöltése nem sikerült.',

  // ---------------------------------------------------------------- keresés
  'Search anime...': 'Anime keresése…',
  Filters: 'Szűrők',
  'search, genre, season, year, format, status, sort':
    'keresés, műfaj, évad, év, formátum, állapot, rendezés',
  'By image': 'Kép alapján',
  'Upload a frame': 'Tölts fel egy képkockát',
  'Search by image (or paste/drop a frame)':
    'Keresés kép alapján (beilleszthetsz vagy ide húzhatsz egy képkockát)',
  'Image search failed: ': 'A képkeresés nem sikerült: ',
  'No confident match for that frame.': 'Erre a képkockára nincs biztos találat.',
  'Invalid file': 'Érvénytelen fájl',
  'No results found.': 'Nincs találat.',
  'Load more': 'Több betöltése',
  'View more': 'Továbbiak',
  'Show more ⌄': 'Több ⌄',
  All: 'Mind',
  Any: 'Bármelyik',

  // ---------------------------------------------------------------- adatlap
  'Also known as': 'Egyéb címei',
  'No known relations.': 'Nincs ismert kapcsolódó cím.',
  // Franchise / watch order. "Évadok" rather than "Szezonok": a season of a
  // show and a broadcast season are different words in Hungarian, and this is
  // the first one.
  'Watch order': 'Nézési sorrend',
  Related: 'Kapcsolódó címek',
  Seasons: 'Évadok',
  Films: 'Filmek',
  'Specials & OVAs': 'Speciálok és OVA-k',
  'you are here': 'itt tartasz',
  'Only the closest entries are shown — this franchise is larger.':
    'Csak a legközelebbi részek látszanak — ez a sorozatcsalád nagyobb ennél.',
  'No character data.': 'Nincs szereplőadat.',
  'No recommendations yet.': 'Még nincs ajánlás.',
  'Anime not found.': 'Nem található ilyen anime.',
  'Failed to load anime: ': 'Az anime betöltése nem sikerült: ',
  Trailer: 'Előzetes',
  trailer: 'előzetes',
  'trailer preview': 'előzetes',
  'No trailer available': 'Nincs elérhető előzetes',

  // ---------------------------------------------------------------- hozzászólás
  Post: 'Küldés',
  Reply: 'Válasz',
  Report: 'Jelentés',
  'Report submitted — thank you': 'Jelentés elküldve — köszönjük',
  'Comment posted': 'Hozzászólás elküldve',
  'No comments yet.': 'Még nincs hozzászólás.',
  'Comments are turned off.': 'A hozzászólás ki van kapcsolva.',
  'Failed to load comments: ': 'A hozzászólások betöltése nem sikerült: ',
  Spoiler: 'Spoiler',
  'Spoiler — click to reveal': 'Spoiler — kattints a megjelenítéshez',
  'Sign in to join the discussion and sync with the platform.':
    'Jelentkezz be, hogy hozzászólhass és szinkronizálj a platformmal.',
  'No discussion yet — be the first: open any anime and leave a comment.':
    'Még nincs beszélgetés — legyél az első: nyiss meg egy animét és szólj hozzá.',
  'Recent discussion': 'Friss beszélgetés',

  // ---------------------------------------------------------------- közös nézés
  'Watch Together': 'Közös nézés',
  'Create a room': 'Szoba létrehozása',
  'Create room': 'Szoba létrehozása',
  'Join a room': 'Csatlakozás szobához',
  Join: 'Csatlakozás',
  Leave: 'Kilépés',
  'Room code': 'Szobakód',
  'Room code (e.g. b7ce5ee3)': 'Szobakód (pl. b7ce5ee3)',
  'Room ': 'Szoba ',
  'Copy code': 'Kód másolása',
  'Code copied': 'Kód kimásolva',
  'Copy invite link': 'Meghívó másolása',
  'Invite link copied': 'Meghívó kimásolva',
  'Link copied': 'Hivatkozás kimásolva',
  'Room not found — it may have been closed.':
    'Nincs ilyen szoba — lehet, hogy bezárták.',
  'Got a code from a friend? Jump in and watch in sync.':
    'Kaptál kódot valakitől? Csatlakozz, és nézzétek együtt.',
  'Pick an anime — playback will sync to the room':
    'Válassz animét — a lejátszás a szobához igazodik',
  'Start a room, share the code, then pick something to watch — play, pause and seeks stay in sync for everyone.':
    'Nyiss szobát, oszd meg a kódot, és válasszatok valamit — az indítás, a szünet és a tekerés mindenkinél együtt mozog.',
  'Watch this episode in sync with friends — play, pause and seeks stay together.':
    'Nézd ezt a részt együtt másokkal — az indítás, a szünet és a tekerés együtt mozog.',
  ' watching now': ' néz most',

  // ---------------------------------------------------------------- profil
  'Profile name': 'Profil neve',
  'Profile & stats': 'Profil és statisztika',
  'Watch profile': 'Nézési profil',
  'Add profile': 'Új profil',
  'Manage profiles': 'Profilok kezelése',
  'Switch profile': 'Profilváltás',
  Switch: 'Váltás',
  'Delete profile': 'Profil törlése',
  'Profile deleted': 'Profil törölve',
  'Kids profile (hide mature content)': 'Gyerekprofil (felnőtt tartalom elrejtése)',
  KIDS: 'GYEREK',
  Avatar: 'Profilkép',
  Name: 'Név',

  // ---------------------------------------------------------------- fiók
  'Yume account': 'Yume-fiók',
  'Sign out': 'Kijelentkezés',
  'Sign in to your account to continue.': 'A folytatáshoz jelentkezz be.',
  'This section needs a signed-in account.': 'Ehhez a részhez bejelentkezés kell.',
  'No access': 'Nincs hozzáférés',
  'An administrator has disabled this part of the site.':
    'Az oldal ezt a részét egy adminisztrátor kikapcsolta.',
  Email: 'E-mail',
  'Email or username': 'E-mail vagy felhasználónév',
  Username: 'Felhasználónév',
  'Password (min 8 chars)': 'Jelszó (legalább 8 karakter)',
  'Yume server updated': 'A Yume-kiszolgáló frissítve',
  'Sync now': 'Szinkronizálás most',

  // ---------------------------------------------------------------- értesítés
  'Latest notifications': 'Friss értesítések',
  'Open inbox': 'Postaláda',
  'Mark all read': 'Összes olvasottnak',
  Unread: 'Olvasatlan',
  'Clear all': 'Összes törlése',
  Dismiss: 'Elvetés',
  'Choose which notifications appear in your inbox. These are generated from your library and activity — no account required.':
    'Válaszd ki, milyen értesítések jelenjenek meg. Ezek a könyvtáradból és az aktivitásodból készülnek — fiók sem kell hozzá.',

  // ---------------------------------------------------------------- statisztika
  'Quick stats': 'Gyors áttekintés',
  'Recent activity': 'Friss aktivitás',
  'Episodes watched per day': 'Naponta megnézett részek',
  'Library breakdown': 'Könyvtár megoszlása',
  'Genre distribution': 'Műfajok megoszlása',
  'Format distribution': 'Formátumok megoszlása',
  'Status distribution': 'Állapotok megoszlása',
  'Score histogram': 'Értékelések eloszlása',
  'Top genres': 'Legtöbbet nézett műfajok',
  'Top studios': 'Legtöbbet nézett stúdiók',
  'Not enough data yet.': 'Még nincs elég adat.',
  'No data yet on this profile. Add anime to your library and watch a few episodes — your analytics build up here automatically.':
    'Ezen a profilon még nincs adat. Tegyél animéket a könyvtáradba és nézz meg pár részt — a statisztika magától felépül.',
  'Nothing to show yet — add anime to your library and your dashboard fills in automatically.':
    'Még nincs mit mutatni — tegyél animéket a könyvtáradba, és az áttekintő magától megtelik.',
  'Nothing watched yet on this profile. Play an episode and it shows up here.':
    'Ezen a profilon még nem néztél semmit. Indíts el egy részt, és itt megjelenik.',
  'History cleared': 'Előzmények törölve',
  'Clear history': 'Előzmények törlése',
  '✓ Unlocked': '✓ Megszerezve',
  unlocked: 'megszerezve',
  'No widgets enabled. Use “Edit layout” to add some.':
    'Nincs bekapcsolt elem. Az „Elrendezés szerkesztése” gombbal adhatsz hozzá.',

  // ---------------------------------------------------------------- megjelenés
  'Theme Engine': 'Témamotor',
  Accent: 'Kiemelőszín',
  Base: 'Alapszín',
  'Custom accent': 'Egyedi kiemelőszín',
  'Pick any colour': 'Válassz bármilyen színt',
  'Tint surfaces': 'Felületek színezése',
  'Blend a hint of the accent colour into cards and panels.':
    'Egy kevés kiemelőszín keverése a kártyákba és panelekbe.',
  'Drag the picker — the whole UI recolours live.':
    'Húzd a választót — az egész felület azonnal átszíneződik.',
  'Personalise Yume — base, accent and surface tint apply instantly and are saved for this profile.':
    'Szabd személyre a Yumét — az alapszín, a kiemelőszín és a felületszínezés azonnal érvényes, és ehhez a profilhoz mentődik.',
  'Personalise Yume. Changes apply instantly and are saved for this profile.':
    'Szabd személyre a Yumét. A változtatások azonnal érvényesek, és ehhez a profilhoz mentődnek.',
  Preview: 'Előnézet',
  'Reset to default': 'Vissza az alapértelmezettre',
  'Move up': 'Fel',
  'Move down': 'Le',
  '✎ Edit': '✎ Szerkesztés',

  // ---------------------------------------------------------------- adatkezelés
  'Export data': 'Adatok exportálása',
  'Import data': 'Adatok importálása',
  'Data imported': 'Adatok importálva',
  'Delete all data': 'Minden adat törlése',
  'Clear cache': 'Gyorsítótár ürítése',
  'Allow adult (18+) content': 'Felnőtt (18+) tartalom engedélyezése',

  // ---------------------------------------------------------------- kiegészítők
  'No published extensions in this category yet.':
    'Ebben a kategóriában még nincs közzétett kiegészítő.',
  Install: 'Telepítés',
  Uninstall: 'Eltávolítás',
  Enable: 'Bekapcsolás',
  Disable: 'Kikapcsolás',
  'Sign in to install': 'Jelentkezz be a telepítéshez',
  'Installed, not running': 'Telepítve, de nem fut',
  'Save settings': 'Beállítások mentése',
  'Saved.': 'Mentve.',
  'This extension has nothing to configure.':
    'Ehhez a kiegészítőhöz nincs mit beállítani.',
  'Failed to load the store: ': 'A bolt betöltése nem sikerült: ',
  'Failed to load this extension: ': 'A kiegészítő betöltése nem sikerült: ',
  '← Extension Store': '← Kiegészítő-áruház',
  'Requested permissions': 'Kért jogosultságok',
  'None — this extension runs with no access beyond the sandbox.':
    'Semmit — ez a kiegészítő a sandboxon kívül semmihez nem fér hozzá.',
  Versions: 'Verziók',
  'No published versions.': 'Nincs közzétett verzió.',
  'No ratings yet': 'Még nincs értékelés',
  deprecated: 'elavult',
  '%n failures in the last 7 days': '%n hiba az elmúlt 7 napban',
  Reviews: 'Értékelések',
  Delete: 'Törlés',
  'No reviews yet.': 'Még nincs értékelés.',
  'Sign in to leave a review.': 'Jelentkezz be az értékeléshez.',
  'Install the extension to review it.': 'Telepítsd a kiegészítőt, hogy értékelhesd.',
  'What worked, what did not (optional)': 'Mi működött, mi nem (nem kötelező)',
  'Post review': 'Értékelés küldése',
  'Update review': 'Értékelés módosítása',
  'Pick a rating first.': 'Előbb válassz csillagot.',
  '%s stars': '%s csillag',
  'Failed to load the reviews: ': 'Az értékelések betöltése nem sikerült: ',
  'Why are you reporting this review? (spam, harassment, nsfw, spoiler, illegal, other)':
    'Miért jelented ezt az értékelést? (spam, harassment, nsfw, spoiler, illegal, other)',
  'Thanks — a moderator will look at it.': 'Köszönjük — egy moderátor megnézi.',
  'Developer Portal →': 'Fejlesztői portál →',

  // ---------------------------------------------------------------- általános
  Save: 'Mentés',
  Cancel: 'Mégse',
  Continue: 'Tovább',
  Back: 'Vissza',
  'Back home': 'Vissza a főoldalra',
  Done: 'Kész',
  or: 'vagy',
  '‹ Previous': '‹ Előző',
  'Next ›': 'Következő ›',
  'Almost there': 'Mindjárt megvan',
  'Failed to load.': 'A betöltés nem sikerült.',
  'Failed to load results: ': 'A találatok betöltése nem sikerült: ',
  'Failed to load the feed: ': 'A hírfolyam betöltése nem sikerült: ',
  'Something went wrong: ': 'Valami hiba történt: ',

  // ---------------------------------------------------------------- copy.js
  // A web/copy.js katalógus értékei. A T() előbb feloldja a pontozott kulcsot
  // a katalógusból, és az onnan kapott angol szöveget fordítja itt — így a
  // katalógus marad a szerkesztés helye, a fordítás pedig egy réteggel odébb.
  Discover: 'Felfedezés',
  'Popular This Season': 'Az évad népszerűi',
  'Trending Now': 'Most felkapott',
  'Airing Right Now': 'Most fut',
  'All Time Popular': 'Minden idők népszerűi',
  'Top Rated': 'Legjobbra értékelt',
  Movies: 'Filmek',
  Romance: 'Romantikus',
  Action: 'Akció',
  Adventure: 'Kaland',
  Fantasy: 'Fantasy',
  'Sequels You Missed': 'Folytatások, amikről lemaradtál',
  'Airing Schedule': 'Adásrend',
  Today: 'Ma',
  Tomorrow: 'Holnap',
  'Nothing airing this week.': 'Ezen a héten nincs adás.',
  'Failed to load schedule: ': 'A menetrend betöltése nem sikerült: ',
  'My Library': 'Könyvtáram',
  'Your List': 'A listád',
  '✓ In your list': '✓ A listádon',
  'Watch History': 'Nézési előzmények',
  Developer: 'Fejlesztő',
  'Loading…': 'Betöltés…',
  'No results.': 'Nincs találat.',
  'Search failed:': 'A keresés nem sikerült:',
  'Something went wrong': 'Valami hiba történt',
  'Type to search…': 'Kezdj el gépelni…',
  catalogue: 'katalógus',
  matched: 'találat',
  'Track, discover and watch anime — your list, your profiles, your way.':
    'Kövesd, fedezd fel és nézd az animéket — a te listád, a te profiljaid, a te módodon.',
  'built on the Yume design system': 'a Yume designrendszerére építve',

  // ---------------------------------------------------------------- varázsló
  'Welcome to Yume': 'Üdv a Yumén',
  'Two quick questions and you are set. You can change all of this later in Settings.':
    'Két gyors kérdés, és kész is. Mindezt később a Beállításokban átírhatod.',
  'What should we show you?': 'Mit mutassunk?',
  'How titles are written, and whether adult titles appear at all.':
    'Hogyan írjuk ki a címeket, és megjelenjenek-e egyáltalán a felnőtt tartalmak.',
  'How do you watch?': 'Hogyan nézed?',
  'Which version starts first when a source offers both.':
    'Melyik változat induljon először, ha a forrás mindkettőt kínálja.',
  Later: 'Később',
  'Saved — you can change these in Settings': 'Mentve — a Beállításokban bármikor átírhatod',
  'Interface language': 'A felület nyelve',
  'Buttons, menus and messages.': 'Gombok, menük és üzenetek.',
  'Title language': 'A címek nyelve',
  'How show titles are written. Romaji is what most of the community uses.':
    'Hogyan írjuk ki a sorozatok címét. A közösség többsége a romajit használja.',
  'Description language': 'A leírások nyelve',
  'Synopses and episode descriptions, where a translation exists.':
    'Ismertetők és epizódleírások, ahol van fordítás.',
  'Show adult content': 'Felnőtt tartalom mutatása',
  'Off unless you turn it on.': 'Alapból kikapcsolva.',
  'Subtitled or dubbed': 'Feliratos vagy szinkronos',
  'Which version to start first when a source offers both.':
    'Melyik változat induljon először, ha a forrás mindkettőt kínálja.',
  'Subtitle language': 'A felirat nyelve',
  'Preferred subtitle track.': 'Az előnyben részesített feliratsáv.',
  'Audio language': 'A hang nyelve',
  'Preferred audio track when a dub is available.':
    'Az előnyben részesített hangsáv, ha van szinkron.',
  'New episode alerts': 'Értesítés új részről',
  'Tell me when a show I follow gets a new episode.':
    'Szólj, ha egy követett sorozathoz új rész jön.',
  Subtitled: 'Feliratos',
  Dubbed: 'Szinkronos',
  'No preference': 'Mindegy',
  'Original audio with subtitles': 'Eredeti hang, magyar felirattal',
  'Dubbed audio when there is one': 'Szinkronos hang, ha van',
  'Whatever plays best': 'Ami a legjobban elindul',
  Language: 'Nyelv',
  Interface: 'Felület',
  Catalogue: 'Katalógus',
  Playback: 'Lejátszás',
  Off: 'Kikapcsolva',
  'Start over': 'Alaphelyzet',
  'Restore every language and playback setting to its default.':
    'Minden nyelvi és lejátszási beállítás visszaállítása alapértelmezettre.',
  'Language settings restored': 'A nyelvi beállítások visszaállítva',
  'Could not load the language options — check your connection and reload.':
    'A nyelvi beállítások nem töltődtek be — ellenőrizd a kapcsolatot és tölts újra.',
  'English interface': 'Angol felület',
  Staff: 'Stáb',
  'From extensions': 'Kiegészítőkből',
  'Skip outro': 'Végefőcím átugrása',
  Subtitles: 'Feliratok',
  'Episode {n} marked as watched': '{n}. rész megnézettnek jelölve',
  'Hungarian interface':
    'Magyar felület',
  'Titles where a Hungarian one exists':
    'A címek, ahol van magyar',
  'Your dashboard':
    'Az áttekintőd',
  'Sources, trackers and tools — sandboxed and permission-scoped':
    'Források, követők és eszközök — homokozóban, jogosultsághoz kötve',
  'What drops this week, day by day':
    'Mi jön ezen a héten, napról napra',
  '✕ Remove from list':
    '✕ Levétel a listáról',
  '＋ Add to List':
    '＋ Listára teszem',
  'Not syncing':
    'Nincs szinkron',
  'Syncing…':
    'Szinkronizálás…',
  '✓ Synced to your account':
    '✓ Szinkronizálva a fiókoddal',
  '⚠ Sync unavailable':
    '⚠ A szinkron nem érhető el',
  'Anime in library':
    'Anime a könyvtárban',
  Completed:
    'Befejezett',
  'Episodes watched':
    'Megnézett részek',
  'Watch time':
    'Nézési idő',
  'Mean score':
    'Átlagos értékelés',
  Favourites:
    'Kedvencek',
  'Level {level} · {xp} XP · {count} in library':
    '{level}. szint · {xp} XP · {count} a könyvtárban',
  'Extension Store':
    'Kiegészítő-bolt',
  'Live discussion across the whole platform':
    'Élő beszélgetés az egész platformról',
  'Your anime, tracked':
    'A követett animéid',
  'Your viewing at a glance':
    'A nézési szokásaid egy pillantásra',
  'All caught up':
    'Mindent megnéztél',
  'Synced rooms — play, pause and seeks stay together':
    'Szinkronizált szobák — az indítás, a szünet és a tekerés együtt mozog',
  'This description has not been translated yet.':
    'Ez a leírás még nincs lefordítva.',
  Version: 'Változat',
  Provider: 'Szolgáltató',
  Sub: 'Felirat',
  Dub: 'Szinkron',
  Raw: 'Nyers',
  Unknown: 'Ismeretlen',
  'Playing from': 'Forrás:',
  'Source failed': 'A forrás nem indult el',
  'trying the next one': 'megyünk a következőre',
  'No sources were offered for this episode.': 'Ehhez a részhez egyetlen forrás sem érkezett.',
  'Nothing playable here — keeping the current source':
    'Itt nincs lejátszható forrás — marad a mostani',
  'That source would not start — keeping the current one':
    'Ez a forrás nem indult el — marad a mostani'
})

if (typeof window !== 'undefined' && !window.I18n) {
  // A szótár a modul után töltődik, de ha valami mégis megelőzné, ne dőljön el
  // az oldal egy hiányzó globális miatt.
  console.warn('[i18n] a magyar szótár az I18n modul előtt töltődött be')
}
