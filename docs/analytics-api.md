# Statisztikai API

Minden végpont **hitelesítést** kér, és a jogosultságot a **kiszolgáló**
dönti el — egy elrejtett gomb nem védelem.

Két jogosultság, nem egy:

| Jog | Mire jó |
|---|---|
| `analytics.view` | látogatottság, címek, keresés, teljesítmény, szolgáltatók, rendszer |
| `analytics.accounts` | **EGY fiók** tevékenysége, munkamenetei, eszközei — ez személyes adat |
| `analytics.export` | letöltés |

Előtag: `/v1/admin/analytics`

---

## Időszak

A legtöbb végpont ugyanazt a tartományt érti:

```
?range=today | yesterday | 7d | 30d | 90d | 365d       (alapértelmezés: 7d)
?from=2026-09-01&to=2026-09-21                          (egyedi, max 731 nap)
```

Fordított sorrendű egyedi tartományt megfordítunk: a szándék egyértelmű, egy
üres válasz csak rejtvény lenne. **Ismeretlen `range` értéket elutasítunk**,
nem értelmezünk át csendben.

Minden válasz tartalmaz egy `window` objektumot (`from`, `to`, `days`,
`label`) — ebből derül ki, mire vonatkozik a szám.

---

## Végpontok

### `GET /summary`
Az **Áttekintés** fül. Katalógus (anime, epizód, felhasználó), időszaki
mérőszámok, az **előző azonos hosszú időszak** ugyanazokkal a számokkal,
legnézettebb címek, szolgáltatói összegzés, komponensállapot.

A `coverage` mező megmondja, **mióta van adat egyáltalán**. Enélkül egy éves
nézet hibásnak látszana egy szeptemberben indult rendszeren.

> A neve `/summary`, nem `/overview`: az utóbbi ezen az előtagon már foglalt
> (a platform egészéről szóló nézet).

### `GET /visitors`
Napi sorok a tartományra + az előző időszak. Az összehasonlítás nem extra:
egy „1 234 látogató" önmagában nem mond semmit.

### `GET /timeseries?metric=&granularity=`
Egy mérőszám az időben.

* `metric`: **fehérlistás** — `sessions`, `visitors`, `page_views`,
  `registrations`, `logins`, `searches`, `episode_starts`,
  `episode_completions`, `watch_seconds`, `errors`, `zero_result_searches`.
  A név a lekérdezésbe kerül, ahová paraméter nem tehető; szabad szöveg itt
  SQL-injekció lenne.
* `granularity`: `day` | `week` | `month`.

Heti/havi bontásban az `analytics_periods`-ból olvas, és a sorokon ott a
`complete` mező: egy **folyamatban lévő** hét különben mindig
„visszaesésnek" látszana.

`errors` és `zero_result_searches` **csak napi** bontásban létezik — hetire
kérve `400`, nem csendes átértelmezés.

### `GET /data-quality`
Mit gyűjtünk, mióta, hány sor, meddig őrizzük, és **hol van lyuk** a napi
összesítőben (az utolsó 30 napból melyik napra nincs sor).

A hiányzó nap **nem ugyanaz**, mint a nulla forgalmú nap: az elsőnél nem
futott le az összesítő, a másodiknál lefutott, és nulla volt az eredmény.

### `GET /providers`
Szolgáltatónként kísérlet, kimenet, átlag és csúcs késleltetés, napi bontás,
legutóbbi 50 esemény, és **percentilisek**:

```json
"percentiles": [
  { "slug": "animeparadise", "samples": 412,
    "p50": 1000, "p95": 2000, "p99": 5000, "bucketed": true }
]
```

A `bucketed: true` nem dísz: a szám **felső korlát** („a kérések 95%-a ennyi
alatt volt"), nem az az egy mérés.

### `GET /system-health`
Komponensenkénti állapot a kiszolgáló tényleges ellenőrzéseiből. A
`not_configured` **nem hiba** — szándékosan nincs bekapcsolva; pirosra festve
a panel folyamatosan hibát jelezne egy működő rendszerre, és onnantól senki
nem nézné.

### `GET /anime`, `GET /anime/:id`, `GET /search`, `GET /performance`, `GET /users`, `GET /breakdown`, `GET /realtime`
Címek, keresés, válaszidők, fiókok, eszközbontás, élő nézet. A `realtime` az
egyetlen, ami **nyers** táblát olvas — szándékosan az utolsó öt percet, ahol
az ablak kicsi, tehát a tábla is.

### `GET /accounts/:userId`
Egy fiók tevékenysége. **Külön jogosultság** (`analytics.accounts`), mert ez
személyes adat.

### `GET /export`
Letöltés. Külön jogosultság, és **auditáljuk** — ki, mit, mikor vitt el.

---

## Gyűjtés

### `POST /v1/analytics/view`
A böngésző jelzése. Csak **útvonalat** fogad el, és azt is normalizálva
(`/anime/:id`, nem `/anime/<uuid>` — egy oldal EGY oldal, nem harmincezer).
A kliens **nem mondhatja meg**, ki ő és mikor volt: az azonosítót és az időt
a kiszolgáló írja.

F5 nyomva tartása nem sokszorozza a számot: 10 másodperces dedupe-ablak,
20 000 kulcsig.

---

## Hibák

RFC 9457 (`application/problem+json`). Az `instance` mezőben a kérés
azonosítója — ez az, amit egy hibabejelentésbe idézni kell.

| Kód | Mit jelent |
|---|---|
| 400 | a kérés hibás (ismeretlen tartomány, nem fehérlistás mérőszám) |
| 401 | nincs hitelesítés |
| 403 | van hitelesítés, nincs jogosultság |
| 503 | egy külső integráció nincs beállítva (nem üzemzavar) |

**Nincs 5xx egy rossz azonosítótól.** Ezt külön teszt méri a teljes
útvonaltáblán, mindkét állásban (névtelenül és belépve).
