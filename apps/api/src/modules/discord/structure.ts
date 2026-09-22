/**
 * A YUME DISCORD-STRUKTÚRÁJA — egyetlen leírásban.
 *
 * MIÉRT EGY FÁJLBAN. Ez a rendszer egyetlen helye, ahol az áll, hogy MILYEN
 * legyen a szerver. A setup, a javítás, az előnézet és a takarítás mind
 * ebből dolgozik; ha egy csatorna neve két helyen szerepelne, a kettő
 * előbb-utóbb szétcsúszna, és a javítás oda-vissza írná ugyanazt.
 *
 * NINCS BENNE EGYETLEN DISCORD-AZONOSÍTÓ SEM, és ez nem stílus: az
 * azonosítót a Discord adja, guildenként mást. A kódban egy beégetett
 * azonosító egyetlen szerveren működne, és minden máson csendben rossz
 * objektumra mutatna. Itt LOGIKAI KULCSOK vannak (`channel:uj-epizodok`), a
 * leképezést a registry tartja.
 *
 * A VERZIÓ SZÁMÍT. Ha ez a leírás változik, a `VERSION` nő, és a javítás
 * ebből tudja, hogy egy régebbi verzióval létrehozott objektumot érdemes
 * átnézni. Enélkül egy átnevezett csatorna örökre a régi nevén maradna.
 */

/** A leírás verziója. Növeld, ha a struktúra változik. */
export const VERSION = 1

/**
 * A Discord csatornatípusai, amiket ez a setup használ.
 *
 * Számok, mert a Discord API is azok. Nevesítve, mert a `type: 4` hat hónap
 * múlva senkinek nem mond semmit.
 */
export const CHANNEL_TYPE = {
  TEXT: 0,
  CATEGORY: 4
} as const

/** Discord jogosultsági bitek, amiket a felülbírálatokhoz használunk. */
export const PERM = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_HISTORY: 1n << 16n,
  ADD_REACTIONS: 1n << 6n,
  MANAGE_MESSAGES: 1n << 13n,
  USE_APP_COMMANDS: 1n << 31n
} as const

export interface ChannelSpec {
  /** A MI kulcsunk. Ez kerül a registrybe; a Discord-azonosító nem ebből jön. */
  key: string
  name: string
  topic?: string
  /**
   * Írhat-e ide bárki.
   *
   * `false` esetén az `@everyone` elveszíti a küldés jogát, de LÁTJA a
   * csatornát: egy bejelentéscsatorna, amit senki nem lát, nem bejelentés.
   */
  everyoneCanSend?: boolean
}

export interface CategorySpec {
  key: string
  name: string
  channels: ChannelSpec[]
}

export interface RoleSpec {
  key: string
  name: string
  /** 0 = nincs saját szín. A Discord decimális RGB-t vár. */
  color: number
  hoist: boolean
  mentionable: boolean
  /**
   * A rang jogosultságai — BIT-ENKÉNT FELSOROLVA, nem egy szám.
   *
   * Üres tömb = semmilyen külön jog. Ez a helyes alapértelmezés: egy rang,
   * ami „csak jelölés", ne adjon hozzáférést semmihez. A
   * `YUME Verified` kifejezetten ilyen.
   */
  permissions: Array<keyof typeof PERM>
}

/**
 * A KATEGÓRIÁK ÉS CSATORNÁK.
 *
 * A sorrend a Discordon is ez lesz: a setup a tömb sorrendjét adja át
 * pozícióként.
 */
export const CATEGORIES: CategorySpec[] = [
  {
    key: 'category:informacio',
    name: 'Információ',
    channels: [
      { key: 'channel:informacio', name: '📌・informacio', topic: 'A YUME és a szerver tudnivalói.', everyoneCanSend: false },
      { key: 'channel:bejelentesek', name: '📢・bejelentesek', topic: 'Hivatalos bejelentések.', everyoneCanSend: false },
      { key: 'channel:szabalyzat', name: '📜・szabalyzat', topic: 'A szerver szabályai.', everyoneCanSend: false },
      { key: 'channel:udvozlet', name: '👋・udvozlet', topic: 'Új tagok köszöntése.', everyoneCanSend: false }
    ]
  },
  {
    key: 'category:kozosseg',
    name: 'Közösség',
    channels: [
      { key: 'channel:altalanos', name: '💬・altalanos', topic: 'Bármi, ami eszedbe jut.' },
      { key: 'channel:anime-beszelgetes', name: '🎌・anime-beszelgetes', topic: 'Animékről, spoilerjelöléssel.' },
      { key: 'channel:ajanlasok', name: '💭・ajanlasok', topic: 'Mit érdemes megnézni?' },
      { key: 'channel:off-topic', name: '🗣️・off-topic', topic: 'Minden más.' }
    ]
  },
  {
    key: 'category:yume',
    name: 'YUME',
    channels: [
      // EZEKBE A BOT ÍR. Az `everyoneCanSend: false` nem szigor, hanem a
      // tartós üzenetek feltétele: egy folyamatosan frissülő embed alá
      // beszúrt üzenetek miatt az embed feljebb csúszik, és senki nem látja.
      { key: 'channel:uj-epizodok', name: '📺・uj-epizodok', topic: 'Friss epizódok a YUME-ról.', everyoneCanSend: false },
      { key: 'channel:adasmenetrend', name: '📅・adasmenetrend', topic: 'Mi jön a következő napokban.', everyoneCanSend: false },
      { key: 'channel:nepszeru-animek', name: '🔥・nepszeru-animek', topic: 'A legnézettebb címek.', everyoneCanSend: false },
      { key: 'channel:statisztika', name: '📊・statisztika', topic: 'A YUME számokban.', everyoneCanSend: false },
      { key: 'channel:bot-allapot', name: '🟢・bot-allapot', topic: 'A bot és a rendszer állapota.', everyoneCanSend: false }
    ]
  },
  {
    key: 'category:bot',
    name: 'Bot',
    channels: [
      { key: 'channel:bot-parancsok', name: '⚙️・bot-parancsok', topic: 'Itt használd a parancsokat.' },
      { key: 'channel:bot-naplo', name: '🛠️・bot-naplo', topic: 'A bot műveleteinek naplója.', everyoneCanSend: false }
    ]
  }
]

/**
 * A RANGOK.
 *
 * EGYIK SEM KAP ADMINISTRATORT, és ez szándékos korlát, nem feledékenység.
 * Az Administrator bit MINDEN mást felülír — egy „értesítések" rang, ami
 * mellékesen adminjogot ad, pontosan az a fajta hiba, amit hónapokkal
 * később, egy incidens közben szoktak megtalálni.
 *
 * A `YUME Bot` rangot a Discord maga hozza létre a bot meghívásakor; itt
 * azért szerepel, hogy a hierarchia-ellenőrzés hivatkozni tudjon rá.
 */
export const ROLES: RoleSpec[] = [
  {
    key: 'role:moderator',
    name: 'YUME Moderator',
    color: 0xE4_1E_63,
    hoist: true,
    mentionable: true,
    // Üzenetkezelés — ennél több nem kell a moderáláshoz, amit mi adunk.
    permissions: ['MANAGE_MESSAGES', 'VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_HISTORY']
  },
  {
    key: 'role:support',
    name: 'YUME Support',
    color: 0x35_C0_7A,
    hoist: true,
    mentionable: true,
    permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_HISTORY']
  },
  {
    key: 'role:notifications',
    name: 'YUME Notifications',
    color: 0x6A_A8_E0,
    hoist: false,
    mentionable: true,
    // JELÖLÉS, NEM JOGOSULTSÁG. Erre a rangra azért lehet hivatkozni, hogy
    // értesítést kapjon; hozzáférést nem ad semmihez.
    permissions: []
  },
  {
    key: 'role:verified',
    name: 'YUME Verified',
    color: 0xE0_A4_58,
    hoist: false,
    mentionable: false,
    // A kiírás külön kimondja: ez NEM adhat adminisztrátori hozzáférést.
    permissions: []
  }
]

/**
 * A TARTÓS ÜZENETEK HELYE.
 *
 * Melyik üzenettípus melyik logikai csatornába megy. A setup ebből tudja,
 * hova hozza létre őket — és ez is logikai kulcs, nem Discord-azonosító.
 */
export const PERSISTENT_MESSAGES: Array<{ key: string, messageType: string, channelKey: string }> = [
  { key: 'pm:server_statistics', messageType: 'server_statistics', channelKey: 'channel:statisztika' },
  { key: 'pm:yume_statistics', messageType: 'yume_statistics', channelKey: 'channel:statisztika' },
  { key: 'pm:anime_schedule', messageType: 'anime_schedule', channelKey: 'channel:adasmenetrend' },
  { key: 'pm:popular_anime', messageType: 'popular_anime', channelKey: 'channel:nepszeru-animek' },
  { key: 'pm:latest_releases', messageType: 'latest_releases', channelKey: 'channel:uj-epizodok' },
  { key: 'pm:bot_status', messageType: 'bot_status', channelKey: 'channel:bot-allapot' },
  { key: 'pm:system_health', messageType: 'system_health', channelKey: 'channel:bot-allapot' },
  { key: 'pm:provider_status', messageType: 'provider_status', channelKey: 'channel:bot-allapot' }
]

/** Minden csatorna, kategóriától függetlenül — a diff ezen megy végig. */
export function allChannels (): Array<ChannelSpec & { parentKey: string, position: number }> {
  const ki: Array<ChannelSpec & { parentKey: string, position: number }> = []
  for (const kategoria of CATEGORIES) {
    kategoria.channels.forEach((cs, i) => ki.push({ ...cs, parentKey: kategoria.key, position: i }))
  }
  return ki
}

/** Egy logikai kulcs leírása, bármelyik típusból. */
export function specFor (key: string): CategorySpec | ChannelSpec | RoleSpec | undefined {
  return CATEGORIES.find(c => c.key === key) ??
    allChannels().find(c => c.key === key) ??
    ROLES.find(r => r.key === key)
}

/** A jogosultsági bitek összege egy ranghoz, a Discord által várt alakban. */
export function permissionBits (spec: RoleSpec): string {
  let bits = 0n
  for (const nev of spec.permissions) bits |= PERM[nev]
  return bits.toString()
}
