# Discord Gateway

**Mit ad hozzá:** azt, amit a REST nem tud megmondani — hogy **mi történt**.

---

## 1. Miért kell

A REST megmondja, **mi van most**: hány tag, milyen csatornák, milyen
szerepkörök. Azt nem, hogy mi történt: az üzenetek, a csatlakozások és a
kilépések **események**. A Discord akkor küldi el őket, amikor megtörténnek,
és **visszamenőleg nem kérdezhetők le**.

Ebből egy következmény adódik, amit nem lehet megkerülni: **ami nem volt
begyűjtve, az nem létezik**. A bekapcsolás előtti időszakról nincs adat, és
kitalálni tilos. Az első értelmes idősor napokkal a bekapcsolás után lesz.

## 2. Miért nincs benne könyvtár

A protokoll négy dologból áll: egy WebSocket-kapcsolat, egy szívverés, egy
azonosítás és egy folytatás. Ez körülbelül háromszáz sor. Egy teljes
gateway-könyvtár ugyanezért több megabájt függőséget, saját életciklust és egy
olyan eseménymodellt hozna, amiből hármat használnánk. A Node 22-nek saját
`WebSocket`-je van.

## 3. Saját folyamat, nem a worker

A gateway **állandó** kapcsolatot tart, és ~41 másodpercenként szívvernie
kell. A worker ciklikus feladatokat futtat; egy hosszabb feladat alatt a
szívverés elmaradna, a Discord bontaná a kapcsolatot, és a rendszer
újracsatlakozási hurokba kerülne — ami pontosan úgy néz ki, mint egy hálózati
hiba, és órákig lehet keresni.

Ezért külön konténer: `docker compose up -d gateway`.

## 4. Intentek

| Intent | Bit | Kell? | Privilegizált |
|---|---|---|---|
| `GUILDS` | 1 | igen | nem |
| `GUILD_MESSAGES` | 512 | igen | nem |
| `GUILD_MEMBERS` | 2 | csak a mozgáshoz | **igen** |
| `MESSAGE_CONTENT` | 32768 | **soha** | igen |

**A privilegizáltat nem kérjük alapból**, és ez nem óvatoskodás: ha a
fejlesztői portálon nincs engedélyezve, a Discord a **csatlakozást** utasítja
vissza (4014). Nem kevesebb adat jönne, hanem **nulla**.

Az üzenettartalmat sosem kérjük: mi **számolunk**, nem olvasunk. Az esemény a
`MESSAGE_CONTENT` intent nélkül is megérkezik, csak a `content` mező üres — és
az nekünk nem kell.

Bekapcsolás: `DISCORD_GUILD_MEMBERS_INTENT=true`, **miután** a portálon is
engedélyezted.

## 5. Amit gyűjt

| Tábla | Mit | Hogyan |
|---|---|---|
| `discord_message_stats_daily` | üzenetszám nap × guild × csatorna, botok külön | **összeadódik** |
| `discord_member_stats_daily` | napi taglétszám-pillanatkép | **felülír** |
| `discord_member_stats_daily` | csatlakozás, kilépés | **összeadódik**, intenttel |

A létszám azért **felülír**, mert nem összeadódó mennyiség: egy naponta
ötvenszer érkező `GUILD_CREATE` ötvenszeres szervert mutatna.

**Semmilyen szöveget és szerzőt nem tárol.** A séma nem is tud ilyet, és egy
teszt őrzi, hogy ne is tudjon.

## 6. Állapot és helyreállítás

Az állapot egyetlen sorban él (`discord_gateway_state`): `status`,
`session_id`, `resume_url`, `sequence`, `last_event_at`, `reconnects`,
`intents`.

**Folytatás vs. új azonosítás.** Folytatni csak akkor lehet, ha van
munkamenetünk, van hova visszacsatlakozni, és tudjuk, hol tartottunk.
Bármelyik hiányzik → azonosítás. Egy hiányos folytatás `INVALID SESSION`-t
kapna, és egy fölösleges körrel többe kerülne.

**Elmaradt szívverés-nyugta = halott kapcsolat.** A TCP nem mondja meg, hogy a
másik oldal elhallgatott: a kapcsolat „nyitva" marad, és a bot némán semmit
nem kap. Nyugta nélkül **bontunk** és folytatunk.

**Végzetes lezárások** — ezeknél **nem** próbálkozunk újra:

| Kód | Mit jelent |
|---|---|
| 4004 | érvénytelen bot token |
| 4013 | érvénytelen intent |
| 4014 | **nem engedélyezett** privilegizált intent |

Ezek beállítási hibák, nem üzemzavarok: újracsatlakozással sosem javulnak
meg, és a végtelen próbálkozás csak forgalmat gyárt, miközben elfedi az igazi
okot. A `status` ilyenkor `failed`, és a `last_error` megmondja, mit kell
tenni.

Minden más kódnál exponenciális, **korlátos** visszalépés (1 s → 60 s),
véletlen szórással. Az **első** szakadás után azonnal próbálkozunk: a
leggyakoribb eset egy pillanatnyi zökkenő, ott egy másodperc várakozás
fölösleges kiesés.

**Az első szívverés véletlen késleltetéssel indul** — a Discord külön kéri:
enélkül egy nagy leállás után minden bot egyszerre kezdene szívverni.

## 7. Élő-e a kapcsolat

**Nem a `status` mező dönt.** Egy lefagyott folyamat `ready` állapotban hagyja
a sort, és onnantól a felület örökké azt hinné, hogy gyűjtünk. Az **utolsó
esemény ideje** a valódi jel: a szívverés ~41 másodperc, tehát ha öt percig
semmi nem jött, a kapcsolat halott.

Ezt a `discord-gateway` szonda is így méri, és a rendszerállapotban is így
jelenik meg.

## 8. Üzemeltetés

```bash
docker compose up -d gateway          # indítás
docker compose logs -f gateway        # napló (token SOHA nem kerül bele)
docker compose restart gateway        # újraindítás
```

Egy újraindítás néhány másodpercnyi üzenetszámlálót visz el. A `resume` a
kimaradt eseményeket pótolja, ha a munkamenet még folytatható; ha nem, az
adott percek hiányoznak. Ez helyes csere — egy statisztika pontatlansága nem
baj, egy duplán számolt üzenet viszont **hazudik**.

Szabályos leállásnál (`SIGTERM`) a pufferben lévő mérés **még kimegy**.

## 9. Mérve, élesben

Az első bekapcsoláskor (2026-09-22):

```
{"komponens":"discord-gateway","uzenet":"csatlakozás","url":"gateway"}
{"komponens":"discord-gateway","uzenet":"kész"}
{"komponens":"discord-gateway","uzenet":"mérések kiírva","sorok":2}
```

`discord_gateway_state`: `status=ready`, `intents=513`
(`GUILDS|GUILD_MESSAGES`), `reconnects=0`.
`discord_member_stats_daily`: `member_count=2`, `joins=NULL`, `leaves=NULL` —
a mozgás nincs mérve, mert a privilegizált intent nincs bekapcsolva, és a
`NULL` itt azt jelenti, hogy **nem mérjük**, nem azt, hogy nem történt.
