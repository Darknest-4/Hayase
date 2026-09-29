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

**Mind a nyolc javítva (2026-09-29, második kör)** — lásd lent a „Javítva”
szakaszt. A táblázat az eredeti megállapítás; a javítás módja és a tesztje
alatta.

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

## Javítva (2026-09-29, második kör)

| # | Hogyan | Teszt |
|---|---|---|
| 1 | Lejárt tagságnál a **bot** kérdezi a Discordot (`rest-client.ts` `memberAccess`: a guild rangjai és tulajdonosa + a tag rangjai → `permissions.ts` `basePermissions`, ugyanaz a számítás, mint a Discordé; az időkorlátozott tag nem kezelhet). Csak meglévő sort frissít; „nem tag” (10007) → a sor törlődik; ha a bot nem tudja megmondani → `stale`, és fél percig nem kérdez újra (különben minden kattintás a 10 s-os időkorlátig várna). Egy nézet párhuzamos kérései egy frissítésre várnak. | `discord-routes` (frissít, elvett jog, kilépett tag, nem válaszoló Discord, négy párhuzamos kérés = két hívás), `discord-permissions` (jogszámítás, 10007 ≠ 403 ≠ Unknown Guild, időkorlát) |
| 2 | Új végpont: `GET /v1/discord/guilds` — az üzemeltetőnek a bot összes szervere (összekötés nélkül is), másnak az összekötött fiók szerverei, ahol joga van **és** a bot is bent van. A vezérlőpult-kapu erre is vonatkozik (a `startsWith('/guilds/')` a perjel miatt kihagyta volna — külön tétel őrzi). | `discord-routes` (négy eset), E2E: az üzemeltető a bot szervereit látja |
| 3 | A vezérlőpult kliense frissít, mint a főoldal: 401 → egy frissítés a sütivel (egyszerre egy, fülek között zárral, `refresh_rotated` után egy újrapróba) → a kérés megismétlése; ha a frissítés sem megy, a belépőlapra lép. A **Kilépés** eddig csak a tárolót ürítette — most a kiszolgálón is lezárja a munkamenetet és törli a harmincnapos sütit; a jogosultság nélküli belépés sem hagy élő munkamenetet. | E2E: lejárt (valódi kulccsal aláírt) token után sem léptet ki; süti nélkül a belépőlapra lép; kilépés után a süti és a régi token is halott |
| 4 | `AllapotIro`: egyszerre egy írás, az események összevonva, legfeljebb 10 s-onként (`DISCORD_GATEWAY_STATE_MS`); az állapotváltás azonnal; elbukott írás mezői visszaolvadnak; a sorszám nem léphet vissza. Valódi folyamattal mérve: 52 esemény + 15 szívverés-nyugta 6 s alatt **5 írás** (eddig 52+). | `discord-gateway` (összevonás, ritkítás, egyszerre egy, hibatűrés, leállás elérhetetlen adatbázissal) |
| 5 | `commands.respond`: ha a kezelő 2 s alatt (`DISCORD_DEFER_MS`) nem végez, előbb halasztott válasz (5-ös típus, csak a hívónak), utána `PATCH …/messages/@original`. | `discord-commands` (gyors, lassú, sikertelen halasztás, kezelő hibája); valódi folyamattal is |
| 6 | Minden gateway-naplósor elején `ido` (ISO); a parancshiba naplósorában is. | valódi folyamattal: minden sorban |
| 7 | `guardUnhandledRejections('gateway')` — és a `0085` migráció, mert az `error_logs` megszorítása a `gateway` forrást **elutasította volna**, a hibarögzítés pedig a saját hibáját elnyeli: a puszta címkecsere csendben elnyelte volna a gateway hibáit. | `error-reporting` (0085 nélkül bukik, vele átmegy) |
| 8 | `manage_messages` → `manage_bot` (a régi név semmit nem nyit). | `discord-permissions` |

Minden új tétel mutációval ellenőrizve: a javítás kivételére elbukik.

### Javítás közben talált további hibák (javítva)

* **A csendes szerveren halottnak látszó gateway.** Az élőség az utolsó
  DISPATCH-esemény ideje volt; a szívverés-nyugta nem számított, pedig a
  `STALE_MS` leírása erre épít. Egy szerveren, ahol öt percig senki nem ír, a
  Bot állapota nézet „nem fut”-at mutatott volna, a `/status` parancs pedig
  ugyanezt a gatewayen át érkezett kérdésre. Élesben most nem jelentkezik,
  mert a tartós üzenetek percenkénti szerkesztése eseményt ad (mérve: két
  esemény percenként). Most a nyugta is életjel (az `AllapotIro` ritkítja).
* **Minden telepítés egy hamis újracsatlakozás volt.** Szabályos leálláskor a
  lezárás-kezelő „kapcsolat bontva, újracsatlakozás” sort írt, és növelte a
  számlálót — a napi újracsatlakozás így a telepítéseket is mérte.

## Javítandók (nem hibák, de számítanak)

Az első három elkészült (2026-09-29, harmadik kör):

| Mi | Hogyan | Teszt |
|---|---|---|
| **A bot állapota nézet:** késleltetés és napi újracsatlakozás | A gateway méri a szívverés körútidejét (elküldés → nyugta), és naponta gyűjti a szakadásokat, a folytatásokat (RESUMED — nem veszett el esemény) és az új munkameneteket (READY — ami közben történt, elveszett), a körútidő átlagával és csúcsával (`0086`: `discord_gateway_state.heartbeat_rtt_ms`, `discord_gateway_daily`). Az állapotsorral EGY utasításban írja, hogy egy újrapróbált írás se számoljon kétszer. A nézet két új kártyát (késleltetés, mai újracsatlakozás) és egy napi panelt kapott. | `discord-gateway` (összevonás, a nyugta nem sürgős, a napi sor), `discord-routes` (a végpont), E2E (a nézet) |
| **A globális sebességkorlát** külön kezelése | Egy globális 429 (`global: true`, `X-RateLimit-Global`, `X-RateLimit-Scope: global`) után a folyamat MINDEN Discord-hívása megáll a megadott ideig: ami belefér a várakozási korlátba (15 s), kivár, ami nem, azonnal `rate_limited` — a Discordhoz nem is fordul. A végpontszintű 429 marad, ahogy volt. | `discord-permissions` (a többi végpont is vár, hosszú szünetnél nem kérdez, fejlécből is, a végpontszintű nem állít meg mindent) |
| **Napi hibaösszesítő** a tartós üzenetekről | `GET /guilds/:guildId/message-failures`: a frissítési előzményből napra és üzenettípusra bontva, hány kísérletből hány hibázott, és mi volt az utolsó hiba — csak a hibás napok, legfeljebb 30 nap (az előzmény megőrzése). A Napló nézet tetején. | `discord-routes` (számolás, guild-határ, ablak), E2E (a nézet) |

Nyitva:

* **Tagság az összekötés után csatlakozott szerverekhez:** a bot csak a már
  tárolt tagságot frissíti; egy később csatlakozott szerver az újra-összekötésig
  nem jelenik meg a nem-üzemeltetőnek (szándékosan: különben bárki bármelyik
  guild-azonosítóval Discord-hívásokat indíthatna).

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
