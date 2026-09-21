/**
 * A Discord felé mutató KAPU — és miért port, nem közvetlen hívás.
 *
 * A tartós üzenetek motorjának a nehéz része nem a HTTP-hívás, hanem az, ami
 * körülötte van: ne küldjön feleslegesen, ne duplikáljon, ne próbálkozzon
 * végtelenül, és egy kézzel törölt üzenetet kontrolláltan hozzon vissza. Ez
 * mind MÉRHETŐ egy hamis klienssel — a valódi Discord nélkül is.
 *
 * Ez nem elméleti kényelem. A YUME-nak MA NINCS Discord bot tokenje, és a
 * tokent kitalálni nem lehet. Ezzel a felosztással a motor teljes egészében
 * megépíthető és letesztelhető most; ami a tokenre vár, az egyetlen vékony
 * megvalósítás.
 */

/** Egy elküldött vagy módosított üzenet azonosítója. */
export interface SentMessage {
  id: string
}

/**
 * Amit a motor a Discordtól kér.
 *
 * MINDEN METÓDUS DOBHAT. A hibák osztályozása a motor dolga (lásd
 * `classifyError`), nem a kliensé: a kliens annyit mond, mi történt.
 */
export interface DiscordClient {
  /** Új üzenet a csatornába. */
  send: (channelId: string, payload: unknown) => Promise<SentMessage>
  /** Meglévő üzenet módosítása. `MessageNotFound`, ha időközben törölték. */
  edit: (channelId: string, messageId: string, payload: unknown) => Promise<SentMessage>
  /** Létezik-e még. A motor ezt a módosítás ELŐTT nem hívja meg — lásd lent. */
  fetch: (channelId: string, messageId: string) => Promise<SentMessage | null>
  /** Van-e a botnak joga írni ebbe a csatornába. */
  canPost: (channelId: string) => Promise<boolean>
}

/**
 * Amit egy hibáról tudni kell ahhoz, hogy eldőljön, mi legyen.
 *
 * NEM A HIBAÜZENET SZÖVEGE DÖNT. Egy szöveges összehasonlítás („tartalmazza-e
 * azt, hogy not found") a Discord egyetlen szövegváltoztatásával elromlik, és
 * a hiba némán rossz ágra visz: egy jogosultsági hibát üzenet-újralétrehozásnak
 * néznénk, és percenként küldenénk egy újat.
 */
export type ErrorKind =
  /** Az üzenet nincs meg — törölték. Újra létre lehet hozni. */
  | 'message_not_found'
  /** A csatorna nincs meg. ÚJRALÉTREHOZÁS NEM SEGÍT. */
  | 'channel_not_found'
  /** Nincs jogunk. Újrapróbálás nem segít, amíg az üzemeltető nem ad jogot. */
  | 'forbidden'
  /** A Discord lassít. Várni kell, `retryAfterMs` szerint. */
  | 'rate_limited'
  /** Átmeneti: hálózat, 5xx. Újrapróbálható. */
  | 'transient'
  /** Ismeretlen. Óvatosan: újrapróbálható, de számít a kudarcszámlálóba. */
  | 'unknown'

export interface DiscordError extends Error {
  kind?: ErrorKind
  /** `rate_limited` esetén, ezredmásodpercben. */
  retryAfterMs?: number
}
