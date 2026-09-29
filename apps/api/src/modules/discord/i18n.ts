/**
 * A BOT NYELVE — magyar vagy angol.
 *
 * A YUME magyar oldal, a bot alapnyelve is a magyar. A parancsválasz csak a
 * hívónak szól, ezért az ő Discord-kliensének nyelvén megy (az interakció
 * `locale` mezője): magyar kliensnek magyarul, minden másnak angolul — egy
 * német felhasználó az angolt érti jobban. Ha a Discord nem küld nyelvet,
 * magyar.
 *
 * A SZERVERRE KIMENŐ üzenetek (hírfolyam, tartós üzenetek, köszöntő) a
 * szerver beállítását követik (a vezérlőpulton; alapból magyar) — lásd
 * `guild-settings.ts`.
 */

export type Nyelv = 'hu' | 'en'

/** A Discord locale-kódjából (`hu`, `en-US`, `de`…): magyar vagy angol. */
export function nyelvBol (locale: string | null | undefined, alap: Nyelv = 'hu'): Nyelv {
  if (!locale) return alap
  return locale.toLowerCase().startsWith('hu') ? 'hu' : 'en'
}

/** Mm:ss vagy óó:pp:mm — a lejátszási pozíció emberi alakja. */
export function idopont (masodperc: number): string {
  const s = Math.max(0, Math.floor(masodperc))
  const ora = Math.floor(s / 3600)
  const perc = Math.floor((s % 3600) / 60)
  const mp = String(s % 60).padStart(2, '0')
  return ora > 0 ? `${ora}:${String(perc).padStart(2, '0')}:${mp}` : `${perc}:${mp}`
}

const HU = {
  // általános
  csakSzerveren: 'Ez a parancs csak szerveren használható.',
  nincsJog: 'Ehhez „Szerver kezelése" jogosultság kell.',
  varj: (s: number) => `Várj még ${s} másodpercet.`,
  ismeretlenParancs: 'Ismeretlen parancs.',
  ismeretlenAlparancs: 'Ismeretlen alparancs.',
  hiba: 'A parancs végrehajtása nem sikerült. Próbáld újra később.',
  lejart: 'Ez a gomb már nem érvényes — futtasd újra a parancsot.',

  // /help
  helpCim: 'YUME — parancsok',
  helpSorok: [
    '**/help** — ez a lista',
    '**/status** — a bot és a rendszer állapota',
    '**/stats** — a YUME számokban',
    '**/anime search | info | latest | schedule | random** — a katalógus',
    '**/next** — a következő rész, amit nézni fogsz',
    '**/watchlist list | add** — a könyvtárad, és hozzáadás',
    '**/profile** — a YUME-fiókod',
    '**/link**, **/unlink** — fiók-összekötés',
    '**/notifications** — értesítési rang be- és kikapcsolása',
    '',
    '_Adminoknak:_ **/setup**, **/config**, **/announce**, **/logs**'
  ],

  // /status
  allapotCim: 'Rendszerállapot',
  nincsAllapot: 'Nincs állapotadat.',
  ujracsatlakozas: 'Újracsatlakozás',
  fut: '✅ fut',
  nemFut: '⚠️ nem fut',

  // /stats
  statCim: 'YUME — statisztika',
  animek: 'Animék',
  epizodok: 'Epizódok',
  felhasznalok: 'Felhasználók',
  munkamenetMa: 'Munkamenet (ma)',
  oldalletoltesMa: 'Oldalletöltés (ma)',
  statLablec: 'A számok a YUME adatbázisából jönnek.',

  // /anime
  ketKarakter: 'Adj meg legalább két karaktert.',
  nincsTalalat: (q: string) => `Nincs találat erre: **${q}**`,
  talalatok: (q: string) => `Találatok: ${q}`,
  allapot: 'Állapot',
  ev: 'Év',
  legfrissebb: 'Legfrissebb epizódok',
  resz: (n: string | number) => `${n}. rész`,
  nincsEpizod: 'Még nincs publikus epizód.',
  kovetkezok: 'Következő epizódok',
  nincsAdasido: 'Egyetlen címhez sincs jövőbeli adásidő.',
  uresKatalogus: 'A katalógus üres.',
  veletlenCim: 'Véletlen cím',
  veletlenLeiras: 'Véletlenül választva a katalógusból.',

  // fiók
  nincsKotve: 'Ehhez a Discord-fiókhoz nincs YUME-fiók kötve.',
  kosdOssze: (url: string) => `Összekötheted itt: ${url}`,
  konyvtar: 'Könyvtár',
  kedvencek: 'Kedvencek',
  konyvtarCim: 'A könyvtárad',
  uresKonyvtar: 'A könyvtárad üres. Hozzáadni: /watchlist add',
  marKotve: (nev: string) => `Ez a Discord-fiók már össze van kötve ezzel: **${nev}**`,
  osszekotesItt: (url: string) => `Az összekötés a YUME-fiókod beállításaiban indul, mert böngésző kell hozzá:\n${url}`,
  kotveVagy: (nev: string, url: string) =>
    `A(z) **${nev}** fiókkal vagy összekötve.\nA bontás a YUME-fiókod beállításaiban: ${url}`,
  statusz: {
    WATCHING: 'nézem', PLANNING: 'tervezem', COMPLETED: 'befejeztem',
    PAUSED: 'szünetel', DROPPED: 'abbahagytam', REWATCHING: 'újranézem'
  } as Record<string, string>,

  // /watchlist add
  hozzaadjam: 'Hozzáadjam a könyvtáradhoz?',
  hozzaadGomb: 'Hozzáadom',
  megseGomb: 'Mégse',
  hozzaadva: (cim: string) => `✅ Hozzáadva a könyvtáradhoz (tervezem): **${cim}**`,
  marKonyvtarban: (cim: string, st: string) => `Ez már a könyvtáradban van: **${cim}** — ${st}`,
  megse: 'Rendben, nem adtam hozzá semmit.',
  eltunt: 'Ez a cím időközben eltűnt a katalógusból.',

  // /next
  folytasd: (cim: string, n: string) => `▶️ Folytasd: **${cim}** — ${n}. rész`,
  ahol: (hol: string) => `Ott folytatod, ahol abbahagytad: ${hol}`,
  kovetkezik: (cim: string, n: string) => `▶️ Következik: **${cim}** — ${n}. rész`,
  megNemJelent: (cim: string, n: string) => `**${cim}**: a(z) ${n}. rész még nem jelent meg.`,
  nincsFolyamatban: 'Nincs folyamatban lévő sorozatod. Nézz körül: /anime latest',
  megnezem: 'Megnézem',

  // /notifications
  nincsRang: 'Az értesítési rang nincs beállítva ezen a szerveren. Futtasd a setupot.',
  rangMegkaptad: 'Megkaptad az értesítési rangot — szólunk az új részekről. Kikapcsolás: /notifications',
  rangLevettem: 'Levettem az értesítési rangot.',
  rangHiba: 'Nem sikerült — lehet, hogy a bot rangja alacsonyabban áll, mint az értesítési rang.',

  // admin
  setupCim: 'YUME setup — állapot',
  setupLeiras: (n: number, utolso: string, url: string) =>
    `Nyilvántartott objektum: **${n}**\nUtolsó futás: ${utolso}\n\nA setup futtatása a vezérlőpulton: ${url}`,
  megNemFutott: 'még nem futott',
  setupLablec: 'Veszélyes műveletet parancsból nem végzünk.',
  beallitasokCim: 'A bot beállításai',
  koszonto: 'Köszöntő',
  tartosUzenet: 'Tartós üzenet',
  be: '✅ be',
  ki: '➖ ki',
  szerkesztes: (url: string) => `A szerkesztés a vezérlőpulton: ${url}`,
  hianyzikBejelentes: 'Hiányzik a csatorna vagy a szöveg.',
  tulHosszu: 'A szöveg túl hosszú (legfeljebb 1800 karakter).',
  idegenCsatorna: 'Ez a csatorna nem ehhez a szerverhez tartozik.',
  nemLatja: 'A bot nem látja ezt a csatornát.',
  nemEllenorizheto: 'A csatorna most nem ellenőrizhető a Discordnál — próbáld újra.',
  bejelentes: 'Bejelentés',
  nemMentEl: (hiba: string) => `Nem sikerült elküldeni: ${hiba}`,
  elkuldve: 'Elküldve.',
  muveletekCim: 'Legutóbbi műveletek',
  nincsMuvelet: 'Még nem történt művelet.',

  // moderálás
  nemModerator: 'Ehhez YUME-moderátori jog kell — az összekötött YUME-fiókodon, nem a Discordon.',
  indoklasCim: (mit: string) => `${mit} — indoklás`,
  indoklas: 'Indoklás (a moderálási naplóba kerül)',
  rovidIndoklas: 'Az indoklás legalább 3 karakter.',
  nemRejtheto: 'Ez a bejelentés nem rejthető el — csak elvethető.'
}

type Szotar = typeof HU

const EN: Szotar = {
  csakSzerveren: 'This command only works in a server.',
  nincsJog: 'This needs the "Manage Server" permission.',
  varj: (s: number) => `Wait ${s} more second${s === 1 ? '' : 's'}.`,
  ismeretlenParancs: 'Unknown command.',
  ismeretlenAlparancs: 'Unknown subcommand.',
  hiba: 'The command failed. Please try again later.',
  lejart: 'This button is no longer valid — run the command again.',

  helpCim: 'YUME — commands',
  helpSorok: [
    '**/help** — this list',
    '**/status** — the bot and the system',
    '**/stats** — YUME in numbers',
    '**/anime search | info | latest | schedule | random** — the catalogue',
    '**/next** — the next episode you are going to watch',
    '**/watchlist list | add** — your library, and adding to it',
    '**/profile** — your YUME account',
    '**/link**, **/unlink** — account linking',
    '**/notifications** — turn the notification role on or off',
    '',
    '_For admins:_ **/setup**, **/config**, **/announce**, **/logs**'
  ],

  allapotCim: 'System status',
  nincsAllapot: 'No status data.',
  ujracsatlakozas: 'Reconnects',
  fut: '✅ running',
  nemFut: '⚠️ not running',

  statCim: 'YUME — statistics',
  animek: 'Anime',
  epizodok: 'Episodes',
  felhasznalok: 'Users',
  munkamenetMa: 'Sessions (today)',
  oldalletoltesMa: 'Page views (today)',
  statLablec: 'The numbers come from the YUME database.',

  ketKarakter: 'Type at least two characters.',
  nincsTalalat: (q: string) => `No results for: **${q}**`,
  talalatok: (q: string) => `Results: ${q}`,
  allapot: 'Status',
  ev: 'Year',
  legfrissebb: 'Latest episodes',
  resz: (n: string | number) => `episode ${n}`,
  nincsEpizod: 'No public episodes yet.',
  kovetkezok: 'Upcoming episodes',
  nincsAdasido: 'No title has an upcoming air date.',
  uresKatalogus: 'The catalogue is empty.',
  veletlenCim: 'Random title',
  veletlenLeiras: 'Picked at random from the catalogue.',

  nincsKotve: 'No YUME account is linked to this Discord account.',
  kosdOssze: (url: string) => `You can link it here: ${url}`,
  konyvtar: 'Library',
  kedvencek: 'Favourites',
  konyvtarCim: 'Your library',
  uresKonyvtar: 'Your library is empty. To add: /watchlist add',
  marKotve: (nev: string) => `This Discord account is already linked to **${nev}**`,
  osszekotesItt: (url: string) => `Linking starts in your YUME account settings, because it needs a browser:\n${url}`,
  kotveVagy: (nev: string, url: string) =>
    `You are linked to **${nev}**.\nUnlink in your YUME account settings: ${url}`,
  statusz: {
    WATCHING: 'watching', PLANNING: 'planning', COMPLETED: 'completed',
    PAUSED: 'paused', DROPPED: 'dropped', REWATCHING: 'rewatching'
  },

  hozzaadjam: 'Add it to your library?',
  hozzaadGomb: 'Add it',
  megseGomb: 'Cancel',
  hozzaadva: (cim: string) => `✅ Added to your library (planning): **${cim}**`,
  marKonyvtarban: (cim: string, st: string) => `Already in your library: **${cim}** — ${st}`,
  megse: 'Okay, nothing was added.',
  eltunt: 'This title has since left the catalogue.',

  folytasd: (cim: string, n: string) => `▶️ Continue: **${cim}** — episode ${n}`,
  ahol: (hol: string) => `You pick up where you left off: ${hol}`,
  kovetkezik: (cim: string, n: string) => `▶️ Up next: **${cim}** — episode ${n}`,
  megNemJelent: (cim: string, n: string) => `**${cim}**: episode ${n} is not out yet.`,
  nincsFolyamatban: 'You have nothing in progress. Have a look around: /anime latest',
  megnezem: 'Watch',

  nincsRang: 'The notification role is not set up on this server. Run the setup.',
  rangMegkaptad: 'You got the notification role — we will tell you about new episodes. To turn it off: /notifications',
  rangLevettem: 'The notification role is off.',
  rangHiba: 'That did not work — the bot\'s role may sit below the notification role.',

  setupCim: 'YUME setup — status',
  setupLeiras: (n: number, utolso: string, url: string) =>
    `Registered objects: **${n}**\nLast run: ${utolso}\n\nRun the setup on the dashboard: ${url}`,
  megNemFutott: 'never',
  setupLablec: 'Dangerous operations are not done from a command.',
  beallitasokCim: 'Bot settings',
  koszonto: 'Welcome',
  tartosUzenet: 'Persistent messages',
  be: '✅ on',
  ki: '➖ off',
  szerkesztes: (url: string) => `Edit on the dashboard: ${url}`,
  hianyzikBejelentes: 'The channel or the text is missing.',
  tulHosszu: 'The text is too long (1800 characters at most).',
  idegenCsatorna: 'That channel does not belong to this server.',
  nemLatja: 'The bot cannot see that channel.',
  nemEllenorizheto: 'The channel cannot be checked with Discord right now — try again.',
  bejelentes: 'Announcement',
  nemMentEl: (hiba: string) => `Could not send it: ${hiba}`,
  elkuldve: 'Sent.',
  muveletekCim: 'Recent operations',
  nincsMuvelet: 'Nothing has happened yet.',

  nemModerator: 'This needs YUME moderator rights — on your linked YUME account, not on Discord.',
  indoklasCim: (mit: string) => `${mit} — reason`,
  indoklas: 'Reason (goes into the moderation log)',
  rovidIndoklas: 'The reason must be at least 3 characters.',
  nemRejtheto: 'This report cannot be hidden — only dismissed.'
}

const SZOTARAK: Record<Nyelv, Szotar> = { hu: HU, en: EN }

/** A parancsszövegek az adott nyelven. */
export function szovegek (nyelv: Nyelv): Szotar {
  return SZOTARAK[nyelv]
}
