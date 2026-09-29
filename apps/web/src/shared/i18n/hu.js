/* global window */
// Magyar fordítás.
//
// A kulcs az angol eredeti — ha egy sor hiányzik innen, az angol szöveg
// jelenik meg, nem egy azonosító és nem üres gomb. Lásd apps/web/js/i18n.js.
//
// Amit szándékosan NEM fordítunk: tulajdonnevek és rövidítések (Yume, AniList,
// MyAnimeList, AL, MAL), illetve a demóadatok. Ezek magyarul is ugyanúgy
// hangzanak, és a lefordításuk csak zavart okozna.

import { I18n } from './i18n.js'

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
  Themes: 'Témák',
  Admin: 'Adminisztráció',
  More: 'Továbbiak',
  Overview: 'Áttekintés',
  Details: 'Részletek',
  Information: 'Információ',
  Activity: 'Aktivitás',
  Awards: 'Elismerések',
  Comments: 'Hozzászólások',
  Episodes: 'Epizódok',
  Episode: 'Epizód',
  Ep: 'Rész',
  'Ep ': 'Rész ',
  Level: 'Szint',
  Relations: 'Kapcsolódó',
  Characters: 'Szereplők',
  Recommendations: 'Ajánlott',
  Duration: 'Hossz',
  'Start date': 'Kezdés',
  Studio: 'Stúdió',
  Source: 'Forrás',
  // A forrásanyag hat értéke (anime.source_material).
  Original: 'Eredeti',
  Manga: 'Manga',
  'Light novel': 'Light novel',
  'Visual novel': 'Visual novel',
  'Video game': 'Videojáték',
  Other: 'Egyéb',
  'Not yet aired.': 'Még nem került adásba.',
  Country: 'Ország',
  Popularity: 'Népszerűség',
  min: 'perc',
  episodes: 'epizód',
  ep: 'rész',
  each: 'egyenként',
  Tags: 'Címkék',
  Status: 'Állapot',
  Content: 'Tartalom',
  Data: 'Adatok',
  Account: 'Fiók',
  Appearance: 'Megjelenés',

  // ---------------------------------------------------------------- lejátszás
  'Watch now': 'Megnézem',
  'Read more': 'Tudj meg többet',
  Watching: 'Nézem',
  Paused: 'Szüneteltetve',
  Dropped: 'Félbehagyva',
  Rewatching: 'Újranézem',
  'Late night': 'Késő éjszaka',
  'Good morning': 'Jó reggelt',
  'Good afternoon': 'Szép napot',
  'Good evening': 'Jó estét',
  Dreamer: 'Álmodó',
  '✓ Done': '✓ Kész',
  '⚙ Edit layout': '⚙ Elrendezés',
  'just aired': 'most ment adásba',
  soon: 'hamarosan',
  'just now': 'az imént',
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
  'No source yet': 'Még nincs forrás',
  'Autoplaying in': 'Automatikus indítás:',
  'The episode list below is complete.': 'Az epizódok listája lent megvan.',
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
  'Paste a direct stream URL. Add more on separate lines and the player falls back automatically if one fails.':
    'Illessz be egy közvetlen stream URL-t. Több sorba írva a lejátszó automatikusan a következőre vált, ha az egyik nem indul.',
  'https://… direct video stream (mp4 / webm) — one per line to enable automatic fallback':
    'https://… közvetlen videostream (mp4 / webm) — soronként egy, így lesz automatikus váltás',
  'Could not play this episode from any available source.':
    'Ezt a részt egyik elérhető forrásból sem sikerült lejátszani.',
  // NULLA forrás — más helyzet, más mondat. Lásd `episode-player.js`.
  'No playable source is available for this episode yet.':
    'Ehhez a részhez jelenleg nincs elérhető forrás.',
  'No episode data available.': 'Nincs elérhető epizódadat.',
  'Invalid watch link.': 'Érvénytelen nézési hivatkozás.',

  // A Player 2.0 hibataxonómiája (`core/player-errors.js`). Fordítás nélkül a
  // lejátszó pont azt csinálná, amit a saját fejléce kifogásol: angol
  // fejlesztői mondatot tenne a képernyőre egy magyar oldalon.
  Player: 'Lejátszó',
  'These apply to the video player. Changes take effect the next time a player opens.':
    'Ezek a videólejátszóra vonatkoznak. A következő lejátszó megnyitásakor lépnek életbe.',
  'There is no source for this episode yet.': 'Ehhez a részhez még nincs forrás.',
  'The source did not respond.': 'A forrás nem válaszolt.',
  'Your browser cannot play this format.': 'A böngésződ nem tudja lejátszani ezt a formátumot.',
  'The connection was lost.': 'Megszakadt a kapcsolat.',
  'The video is damaged or unreadable.': 'A videó sérült vagy olvashatatlan.',
  'This source does not allow playback from here.': 'Ez a forrás nem engedi innen a lejátszást.',
  'This content is protected.': 'Ez a tartalom másolásvédett.',
  'The subtitles could not be loaded.': 'A feliratot nem sikerült betölteni.',
  'That quality is not available.': 'Ez a minőség nem érhető el.',
  'Could not play this.': 'Ezt nem sikerült lejátszani.',

  // ---------------------------------------------------------------- könyvtár
  'Add to list': 'Listára teszem',
  '+ Add to list': '+ Listára teszem',
  'Remove from list': 'Levétel a listáról',
  'Removed from list': 'Levéve a listáról',
  'Add to Planning': 'Tervezettekhez',
  'On your list': 'A listádon',
  'Add to list…': 'Listára…',
  Favourited: 'Kedvenc',
  Watched: 'Megnézve',
  unmarked: 'jelölés visszavonva',
  'marked as watched': 'megnézettnek jelölve',
  'Added to favourites': 'Hozzáadva a kedvencekhez',
  'Removed from favourites': 'Eltávolítva a kedvencekből',
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
  'titles tracked': 'cím követve',
  Trending: 'Felkapott',
  Score: 'Pontszám',
  Newest: 'Legújabb',
  Title: 'Cím',
  unread: 'olvasatlan',
  'See all →': 'Mind →',
  'Library →': 'Könyvtár →',
  'Inbox →': 'Értesítések →',
  'Achievements →': 'Eredmények →',
  'Analytics →': 'Statisztika →',
  'Schedule →': 'Menetrend →',
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
  Genre: 'Műfaj',
  Season: 'Évad',
  Year: 'Év',
  Format: 'Formátum',
  Sort: 'Rendezés',

  // ---------------------------------------------------------------- adatlap
  'Also known as': 'Egyéb címei',
  'No known relations.': 'Nincs ismert kapcsolódó cím.',
  // Franchise / watch order. "Évadok" rather than "Szezonok": a season of a
  // show and a broadcast season are different words in Hungarian, and this is
  // the first one.
  'Watch order': 'Nézési sorrend',
  // Forrásállapot az epizódlistán.
  'No source': 'Nincs forrás',
  'Nothing to play this episode from yet.': 'Ehhez az epizódhoz még nincs lejátszható forrás.',
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
  'Show more': 'Több megjelenítése',

  // ------------------------------------------------------------ kozosseg
  Feed: 'Hírfolyam',
  Forum: 'Fórum',
  'Live chat': 'Élő chat',
  'Boards, rooms and everything people are saying': 'Kategóriák, szobák és minden, amiről beszélnek',
  'Anyone can start a board. Be reasonable and it stays.': 'Bárki indíthat kategóriát. Ha értelmes, marad is.',
  'New board': 'Új kategória',
  'Board name': 'A kategória neve',
  'What is it for? (optional)': 'Miről szól? (nem kötelező)',
  'A board needs a name of at least 3 characters.': 'A kategóriának legalább 3 karakteres név kell.',
  'No boards yet. Start the first one.': 'Még nincs egy kategória sem. Indítsd el az elsőt.',
  'All boards': 'Összes kategória',
  topics: 'téma',
  posts: 'hozzászólás',
  locked: 'lezárva',
  'New topic': 'Új téma',
  'Nothing here yet. Write the first topic.': 'Itt még nincs semmi. Írd meg az első témát.',
  'Write the first post…': 'Írd meg az első hozzászólást…',
  'A topic needs a title and something to say.': 'A témához cím és tartalom is kell.',
  'Write a reply…': 'Írj választ…',
  'This topic is locked. Nobody can reply.': 'Ez a téma le van zárva, nem lehet hozzászólni.',
  'Sign in to reply.': 'Jelentkezz be a válaszhoz.',
  Pin: 'Kitűzés',
  Unpin: 'Kitűzés levétele',
  Lock: 'Lezárás',
  Unlock: 'Feloldás',
  'Hide this post': 'Hozzászólás elrejtése',
  '(edited)': '(szerkesztve)',
  'No chat rooms yet.': 'Még nincs chatszoba.',
  'Write a message…': 'Írj egy üzenetet…',
  Send: 'Küldés',
  'Sign in to join the conversation.': 'Jelentkezz be a beszélgetéshez.',
  'Could not load the history: ': 'Az előzményt nem sikerült betölteni: ',
  'Could not join the room: ': 'Nem sikerült csatlakozni a szobához: ',
  'Live updates are unavailable — reload to see new messages.':
    'Az élő frissítés nem elérhető — töltsd újra az új üzenetekhez.',
  'Disconnected. Reload to reconnect.': 'Megszakadt a kapcsolat. Töltsd újra.',
  'Not connected — reload the page.': 'Nincs kapcsolat — töltsd újra az oldalt.',
  'The server never confirmed this message.': 'A szerver nem erősítette meg ezt az üzenetet.',
  'Remove this message': 'Üzenet törlése',

  // ------------------------------------------------- fejlesztesi naplo
  'Development log': 'Fejlesztési napló',
  'What shipped, what is being built, what is next': 'Mi készült el, min dolgozunk, mi jön',
  Everything: 'Minden',
  Planned: 'Tervezett',
  'In progress': 'Folyamatban',
  Released: 'Kiadva',
  Added: 'Új',
  Changed: 'Változott',
  Fixed: 'Javítva',
  Removed: 'Eltávolítva',
  Security: 'Biztonság',
  'Nothing written here yet.': 'Ide még nem került semmi.',
  'Nothing listed under this version yet.': 'Ehhez a verzióhoz még nincs tétel.',

  'Profile name': 'Profil neve',
  'Profile & stats': 'Profil és statisztika',
  'Your account': 'A fiókod',
  'Account settings': 'Fiókbeállítások',
  Avatar: 'Profilkép',

  // ----------------------------------------------- profilkep es banner
  'Profile picture': 'Profilkép',
  'Profile banner': 'Profil banner',
  'Pick any title from the catalogue. Its cover becomes your picture.':
    'Válassz bármelyik címet a katalógusból — a borítója lesz a képed.',
  'The widest artwork we hold for a title, across the top of your profile.':
    'A legszélesebb kép, amink egy címhez van, a profilod tetején.',
  'Choose a profile picture': 'Profilkép választása',
  'Choose a banner': 'Banner választása',
  'Search the catalogue…': 'Keresés a katalógusban…',
  'From your library. Type to search everything.':
    'A könyvtáradból. Írj be valamit a teljes kereséshez.',
  'Popular right now. Type to search everything.':
    'Most népszerű. Írj be valamit a teljes kereséshez.',
  'Search results': 'Találatok',
  'Nothing matched.': 'Nincs találat.',
  'No banner yet': 'Még nincs banner',
  'From: ': 'Innen: ',
  Choose: 'Választás',
  Change: 'Csere',
  'Remove picture': 'Kép eltávolítása',
  'Remove banner': 'Banner eltávolítása',
  'Profile picture updated': 'Profilkép frissítve',
  'Banner updated': 'Banner frissítve',
  'Profile picture removed': 'Profilkép eltávolítva',
  'Banner removed': 'Banner eltávolítva',
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
  Password: 'Jelszó',
  'Password (min 8 chars)': 'Jelszó (legalább 8 karakter)',
  '3–32 characters, letters and numbers.': '3–32 karakter, betű és szám.',
  'At least 8 characters.': 'Legalább 8 karakter.',
  'Sign in': 'Belépés',
  'Watch Together needs the Yume server. None is reachable at': 'A közös nézéshez a YUME kiszolgálója kell, de nem érhető el itt:',
  'you need an account to create or join a room.': 'szoba nyitásához vagy csatlakozáshoz fiók kell.',
  Register: 'Regisztráció',
  'Create account': 'Fiók létrehozása',
  'Create an account': 'Fiók létrehozása',
  // A szóköz a végén szándékos: a felhasználónév kerül utána.
  'Signed in as ': 'Belépve: ',
  'You are signed in': 'Már be vagy lépve',
  'Your list, your history and your settings follow you.':
    'A listád, az előzményeid és a beállításaid veled tartanak.',
  'It takes a moment, and nothing but an email address.':
    'Egy pillanat, és nem kell hozzá más, csak egy e-mail-cím.',
  // ----------------------------------------------------------- oldalsáv
  Navigation: 'Navigáció',
  Sidebar: 'Oldalsáv',
  Expanded: 'Nyitva',
  Collapsed: 'Összecsukva',
  'Whether the side navigation shows its labels. The arrow at the bottom of the rail does the same thing. On a narrow screen the rail is replaced by the bottom bar, so this has no effect there.':
    'Kiírja-e az oldalsáv a feliratokat. A sáv alján lévő nyíl ugyanezt állítja. Keskeny képernyőn a sáv helyett az alsó sáv navigál, ott ennek nincs hatása.',

  // ---------------------------------------------------------- hozzászólások
  'Delete this comment? This cannot be undone.':
    'Törlöd ezt a hozzászólást? Nem vonható vissza.',
  'Comment deleted': 'A hozzászólás törölve',
  'This comment was deleted.': 'Ezt a hozzászólást törölték.',

  // ------------------------------------------------------------ beállítások
  //
  // A lap fele angolul állt egy magyar felületen — nem azért, mert hiányzott
  // a T(), hanem mert a szótárban nem volt mit találnia.
  'Signed in': 'Be vagy lépve',
  'Not signed in': 'Nem vagy belépve',
  'Sign in to sync your library across devices and join the discussion.':
    'Lépj be, hogy a könyvtárad minden eszközödön ugyanaz legyen, és hozzászólhass.',
  'Shown on your profile page.': 'Ez jelenik meg a profilodon.',
  'Profile artwork': 'Profilképek',
  'Library sync': 'Könyvtár szinkronizálása',
  'Your library status and episode progress follow you across devices while signed in.':
    'Belépve a könyvtárad állapota és az epizódjaid állása minden eszközödön ugyanaz.',
  'Synced to your account': 'Szinkronizálva a fiókoddal',
  'Sync unavailable': 'A szinkronizálás nem elérhető',
  'Library synced': 'A könyvtár szinkronizálva',
  Saved: 'Mentve',

  Theme: 'Téma',
  'Base, accent and surface tint apply instantly and are saved for this profile.':
    'Az alap, a kiemelőszín és a felület árnyalata azonnal érvényes, és megmarad ennél a profilnál.',
  Titles: 'Címek',
  'How anime titles are displayed across the app.':
    'Milyen nyelven jelenjenek meg az anime címek az oldalon.',
  'Preferred (AniList default)': 'Ahogy az AniList adja',
  Native: 'Eredeti',

  'Include 18+ entries in search results and listings.':
    'A 18+ címek is megjelennek a keresésben és a listákban.',
  'Autoplay next episode': 'A következő rész automatikus indítása',
  'Automatically start the next episode when one finishes.':
    'Ha egy rész véget ér, a következő magától elindul.',
  'Auto-skip intros': 'A főcím automatikus átugrása',
  'Skip openings and endings automatically when timing data is available (AniSkip).':
    'A főcím és a záró automatikus átugrása, ha van hozzá időadat (AniSkip).',

  'What you are told about': 'Miről kapsz értesítést',
  'Airing episodes': 'Megjelenő epizódok',
  'When a new episode of something in your library airs.':
    'Ha megjelenik egy új rész abból, ami a könyvtáradban van.',
  'Reminders to pick up shows you started but paused.':
    'Emlékeztető azokról, amiket elkezdtél, de félbehagytál.',
  Achievements: 'Eredmények',
  'When you unlock a new achievement.': 'Ha új eredményt szerzel.',
  'Notification inbox': 'Értesítési postaláda',
  'These are generated from your library and activity — no account required.':
    'Az értesítések a könyvtáradból és a tevékenységedből készülnek — fiók sem kell hozzájuk.',

  'Your data': 'Az adataid',
  'Export and import': 'Mentés és visszatöltés',
  'Your anime list, favourites and progress live only in this browser. Export them as JSON to back them up or move devices.':
    'A listád, a kedvenceid és az állásod csak ebben a böngészőben élnek. JSON-ba mentve megőrizheted vagy átviheted másik eszközre.',
  'API cache': 'Gyorsítótár',
  'Responses from AniList, Jikan and ani.zip are kept locally to keep the app fast and to stay under their rate limits.':
    'Az AniList, a Jikan és az ani.zip válaszai helyben megmaradnak, hogy az oldal gyors legyen, és ne fussunk bele a korlátaikba.',
  'Danger zone': 'Veszélyes műveletek',
  'Delete all local data': 'Minden helyi adat törlése',
  'Your list, favourites, history and settings in this browser. This cannot be undone.':
    'A listád, a kedvenceid, az előzményeid és a beállításaid ebben a böngészőben. Nem vonható vissza.',
  'Delete ALL local data (list, favourites, settings)?':
    'Tényleg törlöd MINDEN helyi adatot (lista, kedvencek, beállítások)?',

  About: 'Névjegy',
  'Framework-free web client on the Yume design system. Catalogue data from AniList, Jikan (MyAnimeList) and ani.zip.':
    'Keretrendszer nélküli webkliens a Yume designrendszerén. A katalógus adatai az AniListről, a Jikanből (MyAnimeList) és az ani.zipről származnak.',
  Sources: 'Források',

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
  'Browse the catalogue': 'Böngészés a katalógusban',
  // Formátumok és állapotok. A katalógus enumjai angolul jönnek, a felület
  // ezeken keresztül fordítja őket (lásd U.format / U.status / U.seasonYear).
  Movie: 'Film',
  'TV Short': 'Rövid TV',
  Special: 'Speciális',
  Music: 'Zene',
  Finished: 'Befejezett',
  'Not yet aired': 'Még nem indult',
  Cancelled: 'Törölve',
  Hiatus: 'Szünetel',
  Winter: 'Tél',
  Spring: 'Tavasz',
  Summer: 'Nyár',
  Fall: 'Ősz',
  'No notifications yet. Add airing anime to your library and they show up here.':
    'Még nincs értesítés. Tegyél futó sorozatokat a könyvtáradba, és itt fognak megjelenni.',
  'Nothing in this filter.': 'Ebben a szűrőben nincs semmi.',
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
  Install: 'Telepítés',
  Enable: 'Bekapcsolás',
  Disable: 'Kikapcsolás',
  Reviews: 'Értékelések',
  Delete: 'Törlés',
  'Why are you reporting this review? (spam, harassment, nsfw, spoiler, illegal, other)':
    'Miért jelented ezt az értékelést? (spam, harassment, nsfw, spoiler, illegal, other)',

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
  // A katalógus műfajai (a `genres` tábla teljes készlete). A hivatkozás
  // értéke marad angol — az megy a keresésbe —, csak a felirat fordul.
  Comedy: 'Vígjáték',
  Drama: 'Dráma',
  Horror: 'Horror',
  'Mahou Shoujo': 'Varázslólány',
  Mecha: 'Mecha',
  Mystery: 'Rejtély',
  Psychological: 'Pszichológiai',
  'Sci-Fi': 'Sci-fi',
  'Slice of Life': 'Hétköznapi',
  Sports: 'Sport',
  Supernatural: 'Természetfeletti',
  Thriller: 'Thriller',
  Ecchi: 'Ecchi',
  Hentai: 'Hentai',
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
  'Track, discover and watch anime — your list, your way.':
    'Kövesd, fedezd fel és nézd az animéket — a te listád, a te profiljaid, a te módodon.',
  'built on the Yume design system': 'a Yume designrendszerére építve',
  // A kapu címének előtagja. Összefűzve kapja a szakasz nevét: „Belépés
  // ehhez: Beállítások". Magyarul a kettőspont természetesebb, mint az
  // angol elöljáró tükörfordítása.
  'Sign in for': 'Belépés ehhez:',
  'Anime data from': 'Az anime-adatok forrása:',

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
    'Ez a forrás nem indult el — marad a mostani',

  // ---------------------------------------------------------------- 2026-09 újratervezés: keret és navigáció
  'Quick search': 'Gyorskeresés',
  'Main navigation': 'Fő navigáció',
  Yours: 'Saját',
  'All results in search': 'Minden találat a keresőben',
  'You are signed out.': 'Kijelentkeztél.',
  'Your library and history on every device.': 'A könyvtárad és az előzményeid minden eszközödön.',
  'Show labels': 'Feliratok mutatása',
  'Hide labels': 'Feliratok elrejtése',
  'Expand sidebar': 'Oldalsáv kinyitása',
  'Collapse sidebar': 'Oldalsáv összecsukása',
  Expand: 'Kinyitás',
  Collapse: 'Összecsukás',

  // ---------------------------------------------------------------- 2026-09 újratervezés: főoldal
  'Next: episode {n}': 'Következik: {n}. rész',
  'Continue: episode {n}': 'Folytatás: {n}. rész',
  'In your list': 'A listádon',
  'Trending now': 'Most felkapott',
  'Browse by genre': 'Böngéssz műfaj szerint',
  'All filters': 'Minden szűrő',
  'Average score': 'Átlagpontszám',
  'Try again': 'Újra',

  // ---------------------------------------------------------------- 2026-09 újratervezés: adatlap
  'Episode {n}': '{n}. rész',
  'Saved as: {status}': 'Mentve: {status}',
  'Show less': 'Kevesebb',
  'No description yet.': 'Ehhez a címhez még nincs leírás.',
  'About this title': 'A címről',
  'Episode range': 'Epizódtartomány',
  'Mark episode {n} watched': 'A(z) {n}. rész megjelölése megnézettként',
  'Mark episode {n} unwatched': 'A(z) {n}. rész megjelölésének törlése',
  'Mark as watched': 'Megnézettnek jelölöm',
  'Mark as unwatched': 'Mégsem néztem meg',
  Sequel: 'Folytatás',
  Prequel: 'Előzmény',
  'Side story': 'Mellékszál',
  'Parent story': 'Fő történet',
  'Spin-off': 'Spin-off sorozat',
  Alternative: 'Alternatív változat',
  Summary: 'Összefoglaló',
  Adaptation: 'Adaptáció',
  Main: 'Főszereplő',
  Supporting: 'Mellékszereplő',
  Background: 'Háttérszereplő',
  Share: 'Megosztás',
  'Could not copy': 'Nem sikerült kimásolni',
  Copied: 'Kimásolva',

  // ---------------------------------------------------------------- 2026-09 újratervezés: kereső
  'Find a title by name, or browse the catalogue with filters.': 'Keress cím alapján, vagy böngéssz a katalógusban szűrőkkel.',
  'Title, alternative title or abbreviation': 'Cím, alternatív cím vagy rövidítés',
  'Clear search': 'Keresés törlése',
  'Search anime': 'Anime keresése',
  'Remove filter: {name}': 'Szűrő törlése: {name}',
  Relevance: 'Relevancia',
  'Nothing matches “{q}”': 'Nincs találat erre: „{q}”',
  'Nothing matches these filters': 'Ezekkel a szűrőkkel nincs találat',
  'Clear filters': 'Szűrők törlése',
  '{n} titles': '{n} cím',
  '{n}+ titles': '{n}+ cím',
  'Looking the frame up at trace.moe…': 'A képkockát a trace.moe keresi…',
  'Best match: {pct}% · episode {ep} (via trace.moe)': 'Legjobb egyezés: {pct}% · {ep}. rész (trace.moe)',
  Loading: 'Betöltés',

  // ---------------------------------------------------------------- 2026-09 újratervezés: belépés
  'We cannot reach the server. Check your connection and try again.': 'Nem érjük el a kiszolgálót. Ellenőrizd a kapcsolatot, és próbáld újra.',
  'Something went wrong. Please try again.': 'Valami félrement. Próbáld újra.',
  'Too many attempts. Wait a few minutes and try again.': 'Túl sok próbálkozás. Várj néhány percet, és próbáld újra.',
  'The server ran into a problem. Please try again in a moment.': 'A kiszolgálón hiba történt. Próbáld újra egy kicsit később.',
  'Wrong email, username or password.': 'Hibás e-mail-cím, felhasználónév vagy jelszó.',
  'This account is suspended.': 'Ez a fiók fel van függesztve.',
  'That email address or username is already taken.': 'Ez az e-mail-cím vagy felhasználónév már foglalt.',
  'Registration is closed on this site.': 'Ezen az oldalon a regisztráció jelenleg zárva van.',
  'This reset link is invalid, already used or expired. Request a new one.': 'Ez a visszaállító link érvénytelen, már felhasználták, vagy lejárt. Kérj újat.',
  'Check the details you entered.': 'Ellenőrizd a megadott adatokat.',
  'Show password': 'Jelszó megjelenítése',
  'Hide password': 'Jelszó elrejtése',

  // ---------------------------------------------------------------- 2026-09 újratervezés: könyvtár
  '{n} titles tracked': '{n} cím követve',
  'Filter by title': 'Szűrés cím szerint',
  'Recently updated': 'Legutóbb módosított',
  Progress: 'Haladás',
  'Tap the heart on a title to keep it here.': 'Egy cím szívére koppintva ide kerül.',
  'Add titles from their page with the list button.': 'Egy címet az adatlapján a lista gombbal vehetsz fel.',
  'Nothing in “{status}” yet': 'A(z) „{status}” lista még üres',
  'Status of {title}': '{title} állapota',
  'Remove {title} from the list': '{title} levétele a listáról',
  Undo: 'Visszavonás',

  // ---------------------------------------------------------------- 2026-09 újratervezés: beállítások
  'Signed in as {name}': 'Belépve: {name}',
  'Changing it signs you out everywhere else; this device stays signed in.': 'A csere minden más eszközön kijelentkeztet; ez az eszköz belépve marad.',
  'Change password': 'Jelszó módosítása',
  'Sign out everywhere': 'Kijelentkezés mindenhol',
  'Ends every session of this account — phones, other browsers, this one too. Use it if you think somebody else is signed in.': 'A fiók minden munkamenetét lezárja — telefonon, más böngészőkben és ezen is. Akkor használd, ha úgy gondolod, más is be van lépve a fiókodba.',
  'Delete account': 'Fiók törlése',
  'Your email address, username and password are erased and every session ends. Comments you wrote stay, without your name. This cannot be undone.': 'Az e-mail-címed, a felhasználóneved és a jelszavad törlődik, minden munkamenet lezárul. Az írt hozzászólásaid megmaradnak, a neved nélkül. Ez nem vonható vissza.',
  'Save password': 'Jelszó mentése',
  'Current password': 'Jelenlegi jelszó',
  'New password': 'Új jelszó',
  'New password again': 'Új jelszó még egyszer',
  'The new password must differ from the current one.': 'Az új jelszó nem lehet ugyanaz, mint a mostani.',
  'Password changed. Every other device has been signed out.': 'A jelszó megváltozott. Minden más eszközön kijelentkeztettünk.',
  'The current password is not right.': 'A jelenlegi jelszó nem stimmel.',
  'Sign out everywhere?': 'Kijelentkezel mindenhol?',
  'Every device signed in to this account will be signed out, including this one.': 'A fiókba belépett minden eszköz kijelentkezik, ez is.',
  'Signed out on every device.': 'Minden eszközön kijelentkeztél.',
  'Delete my account': 'Törlöm a fiókomat',
  'Your password': 'A jelszavad',
  'Type it to confirm that it is you.': 'Írd be, hogy megerősítsd: te vagy az.',
  'Your account has been deleted.': 'A fiókodat töröltük.',
  'The password is not right.': 'A jelszó nem stimmel.',
  'This is not a Yume export file.': 'Ez nem Yume-mentésfájl.',
  'Import data?': 'Betöltöd az adatokat?',
  'The file replaces the list, favourites, settings and history stored in this browser.': 'A fájl felülírja az ebben a böngészőben tárolt listát, kedvenceket, beállításokat és előzményeket.',
  'Data imported into this browser. Your account copy is not overwritten; a title is sent to it the next time you change it.': 'Az adatok betöltve ebbe a böngészőbe. A fiókodban lévő példányt ez nem írja felül; egy cím a következő módosításakor kerül át oda.',
  'Your library is also kept in your account. This exports what this browser holds — list, favourites, settings and history — as a JSON file.': 'A könyvtárad a fiókodban is megvan. Ez azt menti le JSON-fájlba, ami ebben a böngészőben van: listát, kedvenceket, beállításokat és előzményeket.',
  'Cache cleared': 'Gyorsítótár ürítve',
  'Your list, favourites, history and settings in this browser. Your account keeps its copy. This cannot be undone.': 'A listád, a kedvenceid, az előzményeid és a beállításaid ebben a böngészőben. A fiókodban lévő példány megmarad. Ez nem vonható vissza.',
  'Delete all local data?': 'Törlöd az összes helyi adatot?',
  OK: 'Rendben',
  Close: 'Bezárás',

  // ---------------------------------------------------------------- 2026-09 újratervezés: profil
  '{n} in library': '{n} a könyvtárban',
  'Edit profile': 'Profil szerkesztése',
  '{d}d {h}h': '{d} nap {h} ó',
  '{h}h {m}m': '{h} ó {m} p',
  '{m}m': '{m} p',

  // ---------------------------------------------------------------- 2026-09 újratervezés: értesítések
  '{n} unread': '{n} olvasatlan',
  'Clear all notifications?': 'Törlöd az összes értesítést?',
  'The notifications generated from your library are removed from this list. Account notifications stay until you read them.': 'A könyvtáradból képzett értesítések kikerülnek a listából. A fiókod értesítései addig maradnak, amíg el nem olvasod őket.',
  Filter: 'Szűrő',
  'Dismiss: {title}': 'Elvetés: {title}',
  'You left off at episode {n} — pick it back up?': 'A(z) {n}. résznél hagytad abba — folytatod?',

  // ---------------------------------------------------------------- 2026-09 újratervezés: menetrend
  'The next seven days, in your time zone ({zone}).': 'A következő hét nap, a saját időzónádban ({zone}).',
  'Only titles in my library': 'Csak a könyvtáramban lévők',
  'Nothing from your library airs on this day.': 'Ezen a napon a könyvtáradból semmi nem kerül adásba.',
  'Nothing airs on this day.': 'Ezen a napon semmi nem kerül adásba.',
  Aired: 'Adásba került',

  // ---------------------------------------------------------------- 2026-09 újratervezés: áttekintés
  'Edit layout': 'Elrendezés szerkesztése',
  'Move {name} up': '{name} feljebb',
  'Move {name} down': '{name} lejjebb',
  'Show {name}': '{name} megjelenítése',
  'In library': 'A könyvtárban',

  // ---------------------------------------------------------------- 2026-09 újratervezés: eredmények
  'Achievement unlocked': 'Új eredmény',
  '{n} XP to the next level': '{n} XP a következő szintig',
  bronze: 'bronz',
  silver: 'ezüst',
  gold: 'arany',
  'First Steps': 'Első lépések',
  'Watch your first episode.': 'Nézd meg az első részedet.',
  'Getting Into It': 'Belejössz',
  'Watch 50 episodes.': 'Nézz meg 50 részt.',
  'Binge Watcher': 'Sorozatfaló',
  'Watch 500 episodes.': 'Nézz meg 500 részt.',
  'No Life': 'Élet? Az mi?',
  'Watch 2,000 episodes.': 'Nézz meg 2000 részt.',
  'The End': 'Vége',
  'Complete your first anime.': 'Fejezd be az első animédet.',
  Collector: 'Gyűjtő',
  'Complete 25 anime.': 'Fejezz be 25 animét.',
  'Century Club': 'Százas klub',
  'Complete 100 anime.': 'Fejezz be 100 animét.',
  Librarian: 'Könyvtáros',
  'Have 50 titles in your library.': 'Legyen 50 cím a könyvtáradban.',
  Planner: 'Tervező',
  'Plan to watch 20 titles.': 'Tervezz be 20 címet.',
  Curator: 'Kurátor',
  'Favourite 10 titles.': 'Jelölj kedvencnek 10 címet.',
  Critic: 'Kritikus',
  'Rate 25 titles.': 'Pontozz 25 címet.',
  'Day One': 'Egy teljes nap',
  'Watch a full day (24h) of anime.': 'Nézz meg egy teljes napnyi (24 óra) animét.',
  Marathon: 'Maraton',
  'Watch 10 episodes in a single day.': 'Nézz meg 10 részt egyetlen nap alatt.',
  Consistent: 'Kitartó',
  'Be active on 7 different days.': 'Légy aktív 7 különböző napon.',
  Explorer: 'Felfedező',
  'Watch across 10 different genres.': 'Nézz 10 különböző műfajban.',
  Omnivore: 'Mindenevő',
  'Watch every format (TV, Movie, OVA, ONA, Special).': 'Nézz minden formátumban (TV, film, OVA, ONA, különkiadás).',

  // ---------------------------------------------------------------- 2026-09 újratervezés: közösség
  'The community needs the server, and it is not reachable right now.': 'A közösségi részhez kiszolgáló kell, és most nem érjük el.',
  'Tried: {url}. Try again in a moment.': 'Próbált cím: {url}. Próbáld újra egy kicsit később.',

  // ---------------------------------------------------------------- 2026-09 újratervezés: hozzászólások
  'Delete comment?': 'Törlöd a hozzászólást?',
  'Sign in to join the discussion.': 'Lépj be, hogy hozzászólhass.',
  'Share your thoughts… (mark spoilers!)': 'Oszd meg a véleményed… (a spoilert jelöld!)',
  'Spam or advertising': 'Kéretlen reklám',
  'Harassment or hate': 'Zaklatás vagy gyűlöletkeltés',
  'Unmarked spoiler': 'Jelöletlen spoiler',
  'Adult content': 'Felnőtt tartalom',
  'Illegal content': 'Jogellenes tartalom',
  'Something else': 'Egyéb',
  'What is wrong with it? (optional)': 'Mi a gond vele? (nem kötelező)',
  'Send report': 'Jelentés küldése',
  Reason: 'Ok',
  'You have already reported this.': 'Ezt már jelentetted.',
  'Watch Together needs the server, and it is not reachable right now (tried: {url}).': 'A közös nézéshez kiszolgáló kell, és most nem érjük el (próbált cím: {url}).',
  'Sign in to create or join a room.': 'Lépj be, hogy szobát nyiss vagy csatlakozz.',

  // ---------------------------------------------------------------- 2026-09 újratervezés: lejátszó
  'Play/Pause': 'Lejátszás/szünet',
  Volume: 'Hangerő',
  Mute: 'Némítás',
  'Playback speed': 'Lejátszási sebesség',
  'Player settings': 'Lejátszó beállításai',
  'Back 10 seconds': '10 mp vissza',
  'Forward 10 seconds': '10 mp előre',
  Breadcrumb: 'Morzsamenü',

  // ---------------------------------------------------------------- 2026-09 újratervezés: statisztika és előzmények fül
  'Days active': 'Aktív napok',
  'on this device': 'ezen az eszközön',
  'Episodes watched per day on this device, over the last two weeks.': 'Naponta megnézett részek az elmúlt két hétben, ezen az eszközön.',
  'Nothing watched on this device in the last two weeks.': 'Az elmúlt két hétben ezen az eszközön egy részt sem néztél meg.',
  '{date}: {n} episodes': '{date}: {n} rész',
  Formats: 'Formátumok',
  'Score distribution': 'Pontszámok megoszlása',
  'Across {n} rated titles.': '{n} értékelt cím alapján.',
  'Score {score}: {n} titles': '{score} pont: {n} cím',
  'Studios you watch the most, by number of titles in your library.': 'A stúdiók, amelyektől a legtöbb cím szerepel a könyvtáradban.',
  Yesterday: 'Tegnap',
  'Your watch history is kept on this device only.': 'Az előzményeket csak ez az eszköz tárolja.',
  'This clears the list on this device only. Your library and progress stay as they are.': 'Csak az ezen az eszközön vezetett listát törli — a könyvtárad és a haladásod megmarad.',
  'Nothing watched on this device yet. Play an episode and it shows up here.': 'Ezen az eszközön még nem néztél semmit. Indíts el egy részt, és itt megjelenik.',
  'Track, discover and watch anime — your way.': 'Kövesd, fedezd fel és nézd az animéket — a te módodon.',

  // ---------------------------------------------------------------- 2026-09 újratervezés: fórum és csevegés
  Boards: 'Kategóriák',
  'The forum is empty': 'A fórum még üres',
  '{n} topics': '{n} téma',
  Create: 'Létrehozás',
  'What is it for?': 'Miről szól?',
  'Optional — one sentence is enough.': 'Nem kötelező — egy mondat elég.',
  'No topics yet': 'Még nincs téma',
  Topics: 'Témák',
  pinned: 'kitűzve',
  '{n} posts': '{n} hozzászólás',
  'First post': 'Az első hozzászólás',
  Topic: 'Téma',
  Posts: 'Hozzászólások',
  'Your reply': 'Válaszod',
  'Hide the post by {name}': '{name} hozzászólásának elrejtése',
  'Hide this post?': 'Elrejted a hozzászólást?',
  Hide: 'Elrejtés',
  'A topic needs a title of at least 3 characters.': 'A téma címe legalább 3 karakter legyen.',
  'Write something in the first post.': 'Írj valamit az első hozzászólásba.',
  'It disappears from the thread for everyone. It is hidden, not deleted.': 'Mindenkinek eltűnik a témából. Elrejtjük, nem töröljük.',
  'Chat rooms': 'Csevegőszobák',
  '{n} messages today': 'ma {n} üzenet',
  'Messages in {room}': 'Üzenetek: {room}',
  'Message to {room}': 'Üzenet ide: {room}',
  'Remove the message from {name}': '{name} üzenetének eltávolítása',
  'No messages here yet. Say hello!': 'Ebben a szobában még nincs üzenet. Köszönj be!',

  // ---------------------------------------------------------------- Maradék angol feliratok (404, kapuk, értesítéstípusok, hibaazonosító, beágyazott lejátszó)
  'Sign in to continue': 'Lépj be a folytatáshoz',
  'Page not found': 'Nincs ilyen oldal',
  'There is nothing at this address.': 'Ezen a címen nincs semmi.',
  'You do not have access to this section.': 'Ehhez a részhez nincs hozzáférésed.',
  'on {title}': 'itt: {title}',
  'Infrastructure alert': 'Infrastruktúra-riasztás',
  'Daily summary': 'Napi összefoglaló',
  'Open for details': 'Nyisd meg a részletekért',
  'Copy so you can report it': 'Másold ki, hogy jelezni tudd',
  copy: 'másolás',
  'Embedded player': 'Beágyazott lejátszó',
  'This episode plays in the provider’s own player. The site’s playback controls do not apply to it.': 'Ez a rész a szolgáltató saját lejátszójában fut. Az oldal lejátszásvezérlői itt nem hatnak.',

  // ---------------------------------------------------------------- Discord-fiók összekötése (Beállítások → Fiók)
  'Connected accounts': 'Összekötött fiókok',
  'The Yume bot recognises you in the Discord servers that use it.': 'A YUME-bot felismer azokon a Discord-szervereken, amelyek használják.',
  'The Discord link could not be checked right now.': 'A Discord-összekötést most nem sikerült ellenőrizni.',
  'Linked as {name}': 'Összekötve: {name}',
  Unlink: 'Összekötés bontása',
  'Discord linking is not set up on this site.': 'Ezen az oldalon nincs beállítva Discord-összekötés.',
  'Link Discord account': 'Discord-fiók összekötése',
  'Unlink Discord?': 'Bontod a Discord-összekötést?',
  'The Yume bot will no longer recognise you in Discord servers. You can link again at any time.': 'A YUME-bot ezután nem ismer fel a Discord-szervereken. Bármikor újra összekötheted.',
  'Your Discord account is unlinked.': 'A Discord-fiókod összekötése megszűnt.',
  'Your Discord account is linked.': 'A Discord-fiókod össze van kötve.',
  'Discord linking was cancelled.': 'A Discord-összekötést megszakítottad.',
  'The link request expired. Try again.': 'Az összekötési kérés lejárt. Próbáld újra.',
  'This Discord account is already linked to another Yume account.': 'Ez a Discord-fiók már egy másik YUME-fiókhoz van kötve.',
  'Discord linking failed. Try again.': 'A Discord-összekötés nem sikerült. Próbáld újra.',
  'Discord notifications': 'Discord-értesítés',
  'A direct message from the Yume bot when a new episode of a title on your list comes out. It needs a server you share with the bot, with direct messages from server members allowed.': 'Privát üzenet a YUME-bottól, amikor a listád egyik címéhez új rész jelenik meg. Közös szerver kell a bottal, és engedélyezett privát üzenet a szerver tagjaitól.',
  'New episodes will arrive as Discord messages.': 'Az új részekről Discord-üzenetben szólunk.',
  'Discord notifications are off.': 'A Discord-értesítés kikapcsolva.',
  // ---------------------------------------------------------------- Belépés Discorddal
  'Sign in with Discord': 'Belépés Discorddal',
  'For accounts already linked to Discord.': 'Már Discordhoz kötött fiókokhoz.',
  'The Discord sign-in did not open a session. Try again.': 'A Discord-belépés után nem jött létre munkamenet. Próbáld újra.',
  'This Discord account is not linked to a Yume account. Sign in with your password, then link Discord under Settings → Account.': 'Ehhez a Discord-fiókhoz nincs YUME-fiók kötve. Lépj be jelszóval, aztán kösd össze a Beállítások → Fiók alatt.',
  'This account cannot sign in right now.': 'Ez a fiók most nem léphet be.',
  'This account uses two-step sign-in — sign in with your password.': 'Ez a fiók kétlépcsős belépést használ — lépj be jelszóval.',
  'Discord sign-in was cancelled.': 'A Discord-belépést megszakítottad.',
  'The Discord sign-in expired. Try again.': 'A Discord-belépés lejárt. Próbáld újra.',
  'Discord sign-in failed. Try again.': 'A Discord-belépés nem sikerült. Próbáld újra.'
})

if (typeof window !== 'undefined' && !I18n) {
  // A szótár a modul után töltődik, de ha valami mégis megelőzné, ne dőljön el
  // az oldal egy hiányzó globális miatt.
  console.warn('[i18n] a magyar szótár az I18n modul előtt töltődött be')
}
