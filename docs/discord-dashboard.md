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
   belépőlapon kimondja, mi hiányzik (és a belépés munkamenetét a kiszolgálón
   is lezárja). A `0084` migráció a `discord.manage`-et birtokló szerepköröknek
   az újat is megadta. Korábban a Discordon meglévő „Szerver kezelése” jog
   egymagában is bejuttatott — bárki, aki bármelyik, a botot használó
   szerveren admin volt. A szerverlista (`GET /guilds`) is e mögött van.
2. **Szerverenként** (`guildAccess`), két jogcímmel:
   * **YUME-jogosultság**: `discord.manage` — az üzemeltetőnek minden guildhez.
   * **Discord-jogosultság**: a felhasználó összekötötte a fiókját, tagja a
     guildnek, és ott `MANAGE_GUILD` joga van (vagy tulajdonos).

**A fiók-összekötés NEM a vezérlőpult része**: a főoldal Beállítások → Fiók
füléről indul (`returnTo: 'site'`), és bárki használhatja; a bot `/link`
parancsa is oda küld. A vezérlőpult saját Beállítások füle ugyanezt a
folyamatot indítja, a vezérlőpultra visszatérve.

A tárolt tagság **lejár** (5 perc): egy elavult jogosultság **nem** enged be.
Lejárt adatnál a **bot frissíti** a saját tokenjével (a guild rangjai és
tulajdonosa, meg a tag rangjai → ugyanaz a jog, amit a Discord számol) —
újra-összekötés nélkül. Ha a Discord szerint már nem tag, a tagsága törlődik;
ha a bot nem tudja megmondani (nincs token, a Discord nem válaszol), a válasz
nem (`stale`), és fél percig nem is kérdez újra. Egy nézet egyszerre induló
kérései egyetlen frissítésre várnak.

A felület a visszautasítás okát is kiírja — `no_link`, `not_member`, `stale`,
`insufficient` —, mert enélkül minden elutasítás „valami hiba" volna, és az
üzemeltető a rossz helyen keresné.

**A szerverválasztó** a kiszolgálótól jön (`GET /v1/discord/guilds`): az
üzemeltetőnek (`discord.manage`) minden szerver, amelyben a bot bent van —
összekötött fiók nélkül is; másnak az összekötött fiók szerverei, ahol
„Szerver kezelése” joga van és a bot is bent van. A lista kényelem, nem kapu.

**A munkamenet** a főoldaléval azonos módon frissül: a 15 perces hozzáférési
tokent a frissítő süti (HttpOnly, `/v1/auth`) cseréli, egyszerre egy
frissítéssel, fülek között is. A **Kilépés** a kiszolgálón is lezárja a
munkamenetet, és törli a sütit.

## 3. A nézetek — és mi van mögöttük

| Nézet | Adatforrás | Kell hozzá |
|---|---|---|
| **Áttekintés** | Discord REST + saját DB | bot token |
| **Tartós üzenetek** | saját DB + REST | bot token a küldéshez |
| **Tagok** | gateway (napi pillanatkép) | futó gateway; a **mozgáshoz** privilegizált intent |
| **Aktivitás** | gateway (üzenetszám) | futó gateway |
| **Csatornák** | Discord REST | bot token |
| **Szerepkörök** | Discord REST | bot token |
| **Parancsok** | Discord REST (regisztrált parancsok, kézbesítés) + `analytics_events` (30 nap) | bot token |
| **Szerver** | `discord_guild_settings` és társai + Discord REST (csatornák, rangok) | `manage_guild` |
| **Értesítések** | `webhook_deliveries` | — |
| **Bot állapota** | szondák + saját DB; késleltetés és a kapcsolat naponta (`discord_gateway_daily`) | a napi adathoz futó gateway |
| **Napló** | `audit_logs`; a tartós üzenetek napi hibái (`persistent_message_events`) | — |
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

**A sebességkorlát.** Egy végpont 429-ére csak az a hívás vár (a Discord
`retry_after`-je szerint). A **globális** 429 (`global: true`,
`X-RateLimit-Global`, `X-RateLimit-Scope: global`) viszont a bot összes
kérését érinti: utána az adott folyamat minden Discord-hívása megáll a
megadott ideig — ami belefér 15 másodpercbe, kivár, ami nem, azonnal
`rate_limited` hibával tér vissza, a Discordhoz nem is fordulva. Az
elutasított kéréseket a Discord számolja, és tömegesen a bot címének
kitiltásához vezetnek.

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

## 5b. A szerver-beállítások (Szerver nézet)

Minden írás `manage_guild`, és minden Discord-azonosító ellenőrizve, hogy ehhez
a szerverhez tartozik (csatorna: a Discord szerint melyik szerveré; rang: a
szerver rangjai között van, nem az `@everyone`, és nem integráció kezeli).

* **Nyelv** — a szerverre kimenő üzenetek (hírfolyam, moderálás) nyelve:
  magyar (alap), angol, vagy „a Discord-szerver nyelve szerint". A
  parancsválasz ettől függetlenül a hívó kliensének nyelvén megy.
* **Hírfolyam-szűrők** — műfaj (ha egy sincs bejelölve: minden) és „csak az
  aktuális szezon". Ami kiesik, azt nem foglaljuk le: ha a szűrő 48 órán
  belül bővül, még kimehet. **Felnőtt cím (`is_adult`) része soha nem megy
  ki a csatornába** (a borítója sem) — ahogy az oldal katalógusa is alapból
  elrejti; lásd `discord-commands.md`, Az animekártya.
* **A bejelentés tartalma** — a közös animekártyából: borító, a rész saját
  képe (ha nincs, a banner), másodlagos címek, leírás, rész / összes, hossz,
  pontszám egész százalékban, formátum és szezon, állapot a szerver nyelvén,
  adás napja, stúdió, műfajok, a rész leírása; gombok: Megnézem, Adatlap,
  Előzetes (ha az oldalon is látszik). A vezérlőpult gombja kimaradt: 2026-09-29
  óta csak jogosultsággal nyílik, egy tagnak zsákutca volt.
* **Animénként megszólítható rang** — az új rész bejelentése megemlíti, és
  CSAK azt (`allowed_mentions.roles` pontosan az az egy rang).
* **Moderálás** — lásd lent.
* **Szerepkör-szinkron** — az összekötött YUME-fiókú tagok rangja, és YUME-
  szerepkör → Discord-rang megfeleltetés. Tízpercenként, tagonként egy
  lekérdezéssel, a legrégebben szinkronizáltakkal kezdve. **A beállított
  rangokat a bot kezeli**: akinek nem jár, attól leveszi (kézzel adottat
  is) — csak erre használt rangot érdemes beállítani. Ha a Discord nem
  válaszol, semmihez nem nyúl; akinek a fiókja levált, attól a kezelt
  rangokat leveszi. Felfüggesztett vagy kitiltott YUME-fiók semmit nem kap.

## 5c. Moderálás Discordból

A beállított (PRIVÁT!) moderátori csatornába az új YUME-bejelentések kerülnek
— a tárgy rövid részlete, az oka, és a döntést segítő számok; **a bejelentő
neve nem**. Gombok: Elrejtés (ahol a tárgy elrejthető) és Elvetés, plusz az
adminfelület.

Dönteni csak az tud, akinek a Discord-fiókja YUME-fiókhoz van kötve, és annak
**YUME-moderátori joga** (`community.moderate`) van, aktív fiókkal — a
Discordon lévő rang nem számít. A jogot a gombnyomáskor ÉS az indoklás
elküldésekor is nézzük. A döntés ugyanazon az úton születik, mint az
adminfelületen (`moderation/resolve.ts`): ugyanaz a tranzakció, ugyanaz a
moderálási napló — és a bejelentést a tranzakción belül foglalja le, tehát
két egyszerre döntő moderátor közül csak az egyik jár sikerrel. Ha közben az
adminfelületen döntöttek, a Discord-üzenet a következő körben frissül.

## 5d. DM-értesítés és belépés Discorddal (a főoldalon)

* **DM az új részekről** — a főoldal Beállítások → Fiók → Discord-értesítés
  kapcsolója (csak összekötött fióknál). Csak a könyvtár „nézem / tervezem /
  újranézem" címeiről, és csak a bekapcsolás és a cím felvétele UTÁN
  megjelent részekről; részenként egyszer (a kiválasztás és a foglalás egy
  utasítás). Három egymás utáni sikertelen kézbesítés után a kapcsoló
  magától kikapcsol. A Discord csak közös szerveren lévő tagnak engedi a
  bot üzenetét. A nyelv a felhasználó YUME-beli felületi nyelve.
* **Belépés Discorddal** — CSAK MÁR ÖSSZEKÖTÖTT fiókba (nem regisztráció).
  Ugyanazok a kapuk, mint a jelszavas belépésnél (aktív fiók, fiókesemény);
  kétlépcsős titokkal védett fiók ezen az úton nem jut be. Az állapot
  egyszer használható és a kezdeményező böngésző HttpOnly sütijéhez kötött
  (login CSRF ellen); a hozzáférési token nem kerül a címbe — a visszahívás
  a frissítő sütit állítja be, a főoldal abból vesz fel munkamenetet. A gomb
  csak akkor látszik, ha a `DISCORD_LOGIN_REDIRECT_URI` be van állítva ÉS a
  fejlesztői portálon regisztrálva van.

## 6. Beállítás

| Változó | Mire | Kötelező |
|---|---|---|
| `DISCORD_BOT_TOKEN` | REST és gateway | a Discord-adatokhoz igen |
| `DISCORD_CLIENT_ID` | OAuth | az összekötéshez |
| `DISCORD_CLIENT_SECRET` | OAuth | az összekötéshez |
| `DISCORD_GATEWAY_ENABLED` | gateway ki/be (alap: `true`) | nem |
| `DISCORD_GUILD_MEMBERS_INTENT` | tagmozgás (alap: `false`) | nem |
| `DISCORD_GATEWAY_STATE_MS` | az állapotsor írásának legsűrűbb üteme (alap: `10000`) | nem |
| `DISCORD_DEFER_MS` | ennyi után halasztott választ küld egy parancs (alap: `2000`) | nem |
| `DISCORD_MEMBERSHIP_RETRY_MS` | sikertelen tagság-frissítés után ennyit vár (alap: `30000`) | nem |
| `DISCORD_LOGIN_REDIRECT_URI` | a Discord-belépés visszatérési címe (pl. `https://animehub.hu/v1/auth/discord/callback`) — a portálon is regisztrálni kell | a belépéshez |
| `DISCORD_COMMAND_SYNC` | a parancsok automatikus szinkronja (alap: be; `false` kikapcsolja) | nem |
| `DISCORD_ROLE_SYNC_MS` / `DISCORD_ROLE_SYNC_BATCH` | a szerepkör-szinkron üteme (alap: 10 perc) és kötege (25 tag) | nem |
| `DISCORD_DM_BATCH` / `DISCORD_DM_MAX_AGE_HOURS` | DM-köteg körönként (20) és a részek kora (48 óra) | nem |
| `DISCORD_MODERATION_BATCH` / `DISCORD_MODERATION_MAX_AGE_DAYS` | bejelentések körönként (10) és a hátralék kora (7 nap) | nem |
| `PUBLIC_URL` / `MEDIA_BASE_URL` | a hivatkozások és a képek (borító, banner) címe — ugyanaz, mint az `app`-é; a `gateway` és a `worker` is megkapja (üres `MEDIA_BASE_URL`: `PUBLIC_URL/media/`) | nem |

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
