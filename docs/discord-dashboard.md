# Discord vezérlőpult

**Cím:** `https://discord.animehub.hu` — saját név, saját felület, ugyanaz az
alkalmazás.

---

## 1. Miért külön cím

Nem esztétika: **más a közönsége és más a jogcíme**.

Ide az is beléphet, akinek a YUME-ban **nincs** admin jogosultsága, csak a
Discord-szerverén van „Szerver kezelése" joga. Egy ilyen embernek nem kell —
és nem is szabad — látnia a katalógust, a felhasználókat vagy a moderációt.
Amíg a Discord-rész a YUME adminpaneljében ült, a kettő nem volt
szétválasztható.

**Ugyanaz az alkalmazás szolgálja ki.** A fordított proxy a
`discord.animehub.hu` minden nem-API címét a `/dashboard` előtag alá írja át;
az API-előtagok (`/v1`, `/graphql`, `/ws`) változatlanul mennek. Ebből
következik, hogy:

* **nincs CORS** — a lap és az API ugyanaz az eredet;
* **nincs második telepítés** — egy kép, egy konténer;
* **a lapkészlet közös** a webklienssel; két példány a design-rendszerből azt
  jelentené, hogy két helyen kell javítani ugyanazt.

**A munkamenet viszont külön.** A böngésző eredetenként tárol, tehát ide külön
kell belépni (`yume-discord-auth` kulcs). Ez így helyes: a két felület két
különböző jogosultsági kört szolgál.

## 2. Ki juthat be

**A vezérlőpult nem nyilvános (2026-09-29 óta).** Két kapun kell átjutni,
mindkettő a kiszolgálón van:

1. **Belépés a vezérlőpultba** — YUME-jogosultság: `discord.dashboard`, vagy az
   üzemeltetői `discord.manage`. Enélkül minden nézet (`/status`,
   `/guilds/:guildId/…`) `403 no_dashboard_permission`, és a felület a
   belépőlapon kimondja, mi hiányzik. A `0084` migráció a `discord.manage`-et
   birtokló szerepköröknek az újat is megadta. Korábban a Discordon meglévő
   „Szerver kezelése” jog egymagában is bejuttatott — bárki, aki bármelyik, a
   botot használó szerveren admin volt.
2. **Szerverenként** (`guildAccess`), két jogcímmel:
   * **YUME-jogosultság**: `discord.manage` — az üzemeltetőnek minden guildhez.
   * **Discord-jogosultság**: a felhasználó összekötötte a fiókját, tagja a
     guildnek, és ott `MANAGE_GUILD` joga van (vagy tulajdonos).

**A fiók-összekötés NEM a vezérlőpult része**: a főoldal Beállítások → Fiók
füléről indul (`returnTo: 'site'`), és bárki használhatja; a bot `/link`
parancsa is oda küld. A vezérlőpult saját Beállítások füle ugyanezt a
folyamatot indítja, a vezérlőpultra visszatérve.

A tárolt tagság **lejár** (5 perc): egy elavult jogosultság **nem** enged be.
A felület a visszautasítás okát is kiírja — `no_link`, `not_member`, `stale`,
`insufficient` —, mert enélkül minden elutasítás „valami hiba" volna, és az
üzemeltető a rossz helyen keresné.

## 3. A nézetek — és mi van mögöttük

| Nézet | Adatforrás | Kell hozzá |
|---|---|---|
| **Áttekintés** | Discord REST + saját DB | bot token |
| **Tartós üzenetek** | saját DB + REST | bot token a küldéshez |
| **Tagok** | gateway (napi pillanatkép) | futó gateway; a **mozgáshoz** privilegizált intent |
| **Aktivitás** | gateway (üzenetszám) | futó gateway |
| **Csatornák** | Discord REST | bot token |
| **Szerepkörök** | Discord REST | bot token |
| **Parancsok** | — | **nincs implementált parancs** |
| **Értesítések** | `webhook_deliveries` | — |
| **Bot állapota** | szondák + saját DB | — |
| **Napló** | `audit_logs` | — |
| **Beállítások** | OAuth-összekötés | `DISCORD_CLIENT_ID`/`SECRET` |

**Ami nincs, arról azt írja ki.** A tagstatisztika gateway nélkül nem üres
lista és nem nulla, hanem egy doboz, ami megmondja, hogy az adat
**szerkezetileg** nem létezik, és mi kellene hozzá. A nulla azt állítaná, hogy
mérünk, és senki nem csatlakozott.

## 4. A REST és a gateway határa

| Kérdés | Honnan | Privilegizált intent? |
|---|---|---|
| hány tag van MOST | REST (`?with_counts=true`) | nem |
| milyen csatornák vannak | REST | nem |
| milyen szerepkörök vannak | REST | nem |
| hány üzenet ment ma | **gateway** | nem |
| ki lépett be, ki ki | **gateway** | **igen** (`GUILD_MEMBERS`) |
| mit írtak | — | **nem gyűjtjük** |

Az **online létszám tízre kerekítve** megy ki mindenhová, ahol tartós üzenetbe
kerül: a jelenlét percenként ingadozik, és nyersen minden körben új
ujjlenyomatot adna — vagyis az üzenet a nap minden frissítésénél módosulna,
pusztán attól, hogy valaki lelépett.

## 5. Fiók összekötése

`Beállítások → Összekötés a Discorddal`. A folyamat:

1. a felület kér egy **állapotot** (`state`) a kiszolgálótól;
2. a böngésző a Discord engedélyezési lapjára megy;
3. a Discord visszairányít a **rögzített** visszatérési címre;
4. a kiszolgáló beváltja az állapotot (**egyszer használható**), lekéri a
   fiókot és a szervereket, majd **eldobja** a hozzáférési tokent.

Két dolgot kérünk: `identify` és `guilds`. Üzenetet nem olvasunk.

**Egy Discord-fiók egy YUME-fiókhoz köthető.** Enélkül a jogosultság-
ellenőrzés megkerülhető lenne egy második regisztrációval: ugyanaz a
Discord-admin két néven lépne be.

## 6. Beállítás

| Változó | Mire | Kötelező |
|---|---|---|
| `DISCORD_BOT_TOKEN` | REST és gateway | a Discord-adatokhoz igen |
| `DISCORD_CLIENT_ID` | OAuth | az összekötéshez |
| `DISCORD_CLIENT_SECRET` | OAuth | az összekötéshez |
| `DISCORD_GATEWAY_ENABLED` | gateway ki/be (alap: `true`) | nem |
| `DISCORD_GUILD_MEMBERS_INTENT` | tagmozgás (alap: `false`) | nem |

A Discord fejlesztői portálon a visszairányítási címet is regisztrálni kell:
`https://discord.animehub.hu/v1/discord/oauth/callback`.

## 7. Amit a felület nem csinál

* **nem törli** a már kiküldött Discord-üzenetet, ha a nyilvántartást törlöd —
  egy nyilvántartás törlése nem jogosít fel arra, hogy idegen csatornából
  eltüntessünk valamit; kivétel a kézi **újraküldés**, ami a SAJÁT üzenetünket
  cseréli le;
* **nem küld** az előnézetkor — a 11.2. pont külön kimondja, és a teszt az
  adatbázisban ellenőrzi, nem a felirat szövegében;
* **nem mutat** kitalált számot ott, ahol nincs mérés.
