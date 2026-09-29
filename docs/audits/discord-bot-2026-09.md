# A Discord-bot és -vezérlőpult átnézése — 2026-09-29

**Hatókör:** `apps/api/src/modules/discord/` (≈6900 sor: gateway, REST-kliens,
parancsok, OAuth, tartós üzenetek, köszöntő, epizód-hírfolyam, setup),
`apps/discord/src/` (a vezérlőpult felülete, ≈1800 sor), az élesben futó
`yume-gateway` konténer naplója és állapota. A megállapítások a kódból és
élesben (csak olvasva) mérve.

## Élesben, most

| | |
|---|---|
| Gateway | `ready`, intentek: 515 (szerverek, tagok, üzenetszám — üzenettartalom NEM) |
| Újracsatlakozás | 5 nap alatt 54 (naponta ≈11), mind folytatással, újraazonosítás nélkül — egészséges |
| Köszöntő | 1/1 szerveren bekapcsolva (a tag-intent élesben engedélyezve) |
| Tartós üzenetek | 8, egyik sem hibás |
| Összekötött fiókok | 1 |

Ami jól van, és marad: a végzetes bontási kódok (4004, 4010–4014) nem
próbálkoznak újra; a zombi kapcsolatot a szívverés-nyugta fogja meg; a folytatás
feltételei pontosak; a REST-hívásoknak időkorlátjuk van, a 429 `retry_after`
szerint vár; az admin parancsok jogát a kiszolgáló is ellenőrzi; az OAuth
tokent nem tároljuk, az állapot hashelt, egyszer használható és lejár; az
epizód-bejelentés előbb foglal (`ON CONFLICT DO NOTHING`), így nem ismétel.

## Ma javítva (2026-09-29)

1. **A vezérlőpult nem nyilvános.** Eddig bárki bejutott, aki bármelyik, a
   botot használó Discord-szerveren „Szerver kezelése” joggal bírt. Most a
   belépéshez `discord.dashboard` (vagy `discord.manage`) YUME-jogosultság
   kell; a `0084` migráció a `discord.manage`-et birtokló szerepköröknek
   megadta. Jogosultság nélkül minden nézet `403 no_dashboard_permission`, és a
   felület kimondja, mi hiányzik.
2. **Fiók-összekötés a főoldalon** (Beállítások → Fiók): a meglévő
   `/v1/discord/oauth/*` végpontokra épül, a visszatérés helye zárt listából
   (`returnTo: 'site' | 'dashboard'`, az állapot mellé tárolva — nem a
   címsorból, az nyitott átirányítás volna).
3. **A bot `/link`, `/unlink`, `/profile`, `/watchlist` tanácsa** eddig a
   vezérlőpultra küldött — oda egy átlagos tag ma már nem jut be; most a
   főoldal Fiók fülére.

Tesztek: `discord-routes` (a Discord-jog egymagában nem elég; az összekötés
nyitva marad), `discord-oauth` (a visszatérési cél, lemondáskor is),
`tests/e2e/discord-dashboard` (jogosultság nélkül a belépőlap marad),
`tests/e2e/discord-link` (a főoldali kör valódi böngészőben).

## Hibák

| # | Súly | Hiba | Hol | Javítás iránya |
|---|---|---|---|---|
| 1 | **magas** | **A szerverenkénti jog 5 perc után „lejár”, és semmi nem frissíti.** A tagságot (ki kezeli a szervert) csak az összekötés pillanatában kérjük le az OAuth-tokennel; a tokent szándékosan nem tároljuk, a kapu viszont 5 perc után `stale`-lel elutasít. Aki nem `discord.manage`-es, az az összekötés után 5 perccel kizáródik, amíg újra nem köt. Mióta a vezérlőpulthoz `discord.dashboard` kell, ez az út épp a nem-üzemeltető kezelőké. | `oauth.ts` `syncGuilds` (csak `completeLink` hívja), `guild-access.ts` `MEMBERSHIP_TTL_MS` | Lejárt tagságnál a **bot** kérdezze le a saját tokenjével: `GET /guilds/{g}/members/{u}` + a szerepkörök + a tulajdonos → a jog kiszámolható, OAuth-token tárolása nélkül. |
| 2 | közepes | **Összekötés nélkül üres a szerverválasztó** — egy `discord.manage`-es üzemeltető is csak „nincs összekötött szerver”-t lát, mert a lista az összekötött fiók szervereiből jön. | `apps/discord/src/app.js` `indul()` → `linkStatus().guilds` | Egy `GET /v1/discord/guilds` a `discord.manage`-eseknek: azok a szerverek, amelyekben a bot benne van (a gateway `GUILD_CREATE`-jéből vagy REST-ből). |
| 3 | közepes | **A vezérlőpult 15 percenként kiléptet.** A kliensben nincs tokenfrissítés; a frissítő süti a vezérlőpult nevén is megvan (`/v1/auth`), csak senki nem használja. | `apps/discord/src/api.js` | Ugyanaz a frissítés, mint a főoldalon (`credentials: 'include'`, egyszerre egy, fülek között zár — `apps/web/src/shared/api/yume.js`). |
| 4 | közepes (terhelés) | **Minden Discord-esemény egy adatbázis-írás** ugyanarra a sorra (`discord_gateway_state`), ritkítás nélkül; a `void`-dal indított írások sorrendje felcserélődhet, a tárolt sorszám visszaléphet. Kis szerveren észrevehetetlen, forgalmasban írási vihar. | `gateway-main.ts` (`void allapotIr({ event: true, sequence })`), `gateway.ts` `allapotIr` | Összevonás: legfeljebb 5–10 másodpercenként egy írás, mindig a legutolsó értékkel. |
| 5 | alacsony–közepes | **A slash parancs csak a kezelő végén válaszol, halasztás nélkül.** A Discord 3 másodpercet ad; egy terhelt adatbázis mellett a néző „The application did not respond”-ot kap. | `gateway-main.ts` `interakcio()` | Ha a kezelő 2 s alatt nem végez: előbb `DEFERRED` (5-ös típus), utána a válasz szerkesztése (`PATCH /webhooks/{app}/{token}/messages/@original`). |
| 6 | alacsony | A gateway naplósoraiban **nincs időbélyeg** (JSON idő nélkül) — csak a Docker saját időbélyegével olvasható. | `gateway-main.ts` `naplo()` | `ido: new Date().toISOString()` minden sorba. |
| 7 | alacsony | A gateway folyamat a kezeletlen hibákat **`worker`-ként** naplózza (másolás maradéka). | `gateway-main.ts` `guardUnhandledRejections('worker')` | `'gateway'`. |
| 8 | alacsony | A `manage_messages` képesség valójában a „Szerver kezelése” bitet nézi — ma helyes, de a név félrevezető, és egy jövőbeli „ez csak üzenetkezelés” feltételezés rést nyitna. | `permissions.ts` `can()` | Átnevezés (`manage_bot`), vagy a parancsoknál közvetlenül `manage_guild`. |

## Javítandók (nem hibák, de számítanak)

* **A bot állapota nézet** mutassa a szívverés-nyugta körútidejét (a Discord
  felé mért késleltetés) és a napi újracsatlakozást — ma csak az állapot és a
  darabszám látszik.
* **A globális sebességkorlát** (`X-RateLimit-Global`) külön kezelése: most
  minden 429 ugyanúgy vár.
* **A tartós üzenetek** hibánál ma helyben számolnak (`failure_count`); egy
  napi összesítő a vezérlőpult Napló nézetében előbb szólna, mint egy panasz.
* **Tesztek**, ha az 1., 4. és 5. pont elkészül: a tagság frissítése a bot
  tokenjével, az összevont állapotírás és a halasztott válasz.

## Ötletek — mit érdemes hozzáadni

Mind arra épül, ami ma már megvan: az összekötött fiókra (mostantól a
főoldalról is), a gatewayre és a tartós üzenetekre.

1. **Személyes értesítés DM-ben** (bekapcsolható): új rész a könyvtárad egy
   címéhez — az összekötött fiókon át, a meglévő epizód-hírfolyam mintájára.
2. **Szerepkör-szinkron:** „YUME-tag” rang az összekötött fiókoknak; a YUME
   szerepköreihez (pl. moderátor) rendelt Discord-rangok.
3. **Könyvtárkezelés parancsból:** `/watchlist add`, `/next` (a következő
   megnézendő rész) — megerősítéssel, a saját fiókra.
4. **Csatornánkénti hírfolyam-szűrő:** műfaj vagy szezon szerint, animénként
   megszólítható ranggal.
5. **Belépés Discorddal a főoldalon** — csak már összekötött fiókra; ugyanaz az
   OAuth (`identify`). Biztonsági átnézést kér, mert új belépési út.
6. **Moderálás Discordból:** a YUME-bejelentések a moderátori csatornába,
   gombokkal (elrejtés, elvetés) — a döntés a YUME moderálási sorába íródik.
7. **A bot üzenetei a szerver nyelvén** (magyar/angol), a guild `preferred_locale`-je szerint.
