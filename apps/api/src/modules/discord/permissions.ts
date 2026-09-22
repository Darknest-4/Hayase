/**
 * Discord-jogosultságok → mit szabad a vezérlőpulton.
 *
 * A DISCORD BITMEZŐBEN ADJA MEG a jogokat, 64 bites egészként. Ez két dolgot
 * jelent a gyakorlatban, és mindkettőt könnyű elrontani:
 *
 *   1. A JavaScript `number` 2^53 fölött pontosságot veszít, a Discord
 *      jogosultsági bitjei pedig már rég túl vannak ezen (a `MANAGE_EVENTS`
 *      a 33. bit, az `MODERATE_MEMBERS` a 40.). Ezért `BigInt` — egy `Number`
 *      alapú maszkolás CSENDBEN rossz eredményt ad a magasabb biteknél.
 *
 *   2. Az `ADMINISTRATOR` bit MINDENT felülír a Discord oldalán. Aki ezt
 *      elfelejti, az a saját felületén megtagadhat valamit egy olyan
 *      embertől, akinek a Discord szerint joga van hozzá — és fordítva,
 *      soha nem szabad többet adni, mint amit a Discord ad.
 *
 * AMIT EZ A MODUL NEM CSINÁL: nem dönt a YUME-jogosultságokról. Az, hogy
 * valaki egyáltalán beléphet-e a vezérlőpultra, a YUME session- és
 * jogosultságrendszerének a dolga. Ez a réteg csak azt mondja meg, hogy a
 * Discord szerint mihez van joga EBBEN a guildben.
 */

/** A Discord jogosultsági bitjei, amiket használunk. */
export const PERMISSION_BITS = {
  /** Mindent felülír. */
  ADMINISTRATOR: 1n << 3n,
  MANAGE_GUILD: 1n << 5n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_ROLES: 1n << 28n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n
} as const

/** Amit a vezérlőpulton meg lehet tenni. */
export type Capability =
  /** A guild statisztikáinak megtekintése. */
  | 'view_stats'
  /** Tartós üzenetek létrehozása, módosítása, törlése. */
  | 'manage_messages'
  /** A guild beállításainak módosítása. */
  | 'manage_guild'
  /** Csatornákhoz kötött beállítások. */
  | 'manage_channels'
  /** Szerepkörökhöz kötött beállítások. */
  | 'manage_roles'

export interface GuildMembership {
  /** A guild tulajdonosa-e. A Discord szerint ez is mindent felülír. */
  owner: boolean
  /** A tag összesített jogosultsági bitmezője, ahogy a Discord adta. */
  permissions: bigint
}

/**
 * A nyers jogosultsági mező beolvasása.
 *
 * A Discord API SZTRINGKÉNT adja vissza (`"2147483647"`), épp azért, mert a
 * JSON-szám nem bírja el. Aki `Number`-ré alakítja, az a magasabb biteket
 * elveszíti — és a hiba néma: a jogosultság egyszerűen hiányzónak látszik.
 */
export function parsePermissions (raw: unknown): bigint {
  if (typeof raw === 'bigint') return raw
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw)
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    try { return BigInt(raw.trim()) } catch { return 0n }
  }
  return 0n
}

/** Megvan-e ez a bit. Az `ADMINISTRATOR` külön kezelendő — lásd `can`. */
export function hasBit (permissions: bigint, bit: bigint): boolean {
  return (permissions & bit) === bit
}

/**
 * Szabad-e ez a művelet ebben a guildben.
 *
 * A SORREND VÉDELEM: előbb a tulajdonos és az `ADMINISTRATOR` — ezek a
 * Discord szerint mindent felülírnak, és ha utánuk néznénk, egy hiányzó
 * részjog tévesen megtagadna valamit egy adminisztrátortól.
 */
export function can (membership: GuildMembership, capability: Capability): boolean {
  if (membership.owner) return true
  if (hasBit(membership.permissions, PERMISSION_BITS.ADMINISTRATOR)) return true

  switch (capability) {
    /*
     * A STATISZTIKA MEGTEKINTÉSE A `MANAGE_GUILD`-HOZ VAN KÖTVE, nem a puszta
     * tagsághoz. Egy szerver taglétszáma, aktivitási görbéje és
     * csatornastatisztikája ÜZEMELTETŐI adat: aki nem vezeti a szervert,
     * annak nem jár. A 7.2. pont is ezt mondja: „Normál tag: ne kapjon
     * dashboard-konfigurációs hozzáférést alapértelmezés szerint."
     */
    case 'view_stats':
    case 'manage_messages':
    case 'manage_guild':
      return hasBit(membership.permissions, PERMISSION_BITS.MANAGE_GUILD)
    case 'manage_channels':
      return hasBit(membership.permissions, PERMISSION_BITS.MANAGE_CHANNELS)
    case 'manage_roles':
      return hasBit(membership.permissions, PERMISSION_BITS.MANAGE_ROLES)
    default:
      // ISMERETLEN KÉPESSÉG = NEM. Egy elgépelt név nem nyithat kaput.
      return false
  }
}

/**
 * Amit a botnak tudnia kell ahhoz, hogy üzenetet tegyen egy csatornába.
 *
 * MIND A HÁROM KELL. A `SEND_MESSAGES` önmagában kevés: beágyazott tartalom
 * `EMBED_LINKS` nélkül üres üzenetként megy ki, a `VIEW_CHANNEL` nélkül pedig
 * a csatorna a bot számára nem is létezik.
 */
export function canPostEmbed (permissions: bigint): boolean {
  if (hasBit(permissions, PERMISSION_BITS.ADMINISTRATOR)) return true
  return hasBit(permissions, PERMISSION_BITS.VIEW_CHANNEL) &&
    hasBit(permissions, PERMISSION_BITS.SEND_MESSAGES) &&
    hasBit(permissions, PERMISSION_BITS.EMBED_LINKS)
}

/** Ember által olvasható lista arról, mi hiányzik. Az üzemeltetőnek szól. */
export function missingForEmbed (permissions: bigint): string[] {
  if (hasBit(permissions, PERMISSION_BITS.ADMINISTRATOR)) return []
  const out: string[] = []
  if (!hasBit(permissions, PERMISSION_BITS.VIEW_CHANNEL)) out.push('VIEW_CHANNEL')
  if (!hasBit(permissions, PERMISSION_BITS.SEND_MESSAGES)) out.push('SEND_MESSAGES')
  if (!hasBit(permissions, PERMISSION_BITS.EMBED_LINKS)) out.push('EMBED_LINKS')
  return out
}
