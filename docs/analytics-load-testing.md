# A statisztikai felület terhelésmérése

**Mért számok, nem becslés.** Ami itt szerepel, az egy futásból származik; ami
nem lett megmérve, az nincs benne.

---

## 1. Mit mér, és mit nem

A `tests/load/main.js` azt méri, amit a **látogatók** csinálnak: böngészés,
keresés, lejátszás. Az adminfelület teljesen más alakú terhelés — **kevés**
egyidejű felhasználó, de mindegyik kérése **összesítő lekérdezés** több tízezer
soron. Egy vegyes mérésben ez elveszne: tíz admin kérése a látogatók tízezre
mellett statisztikai zaj, miközben pont az a kérdés, hogy egy 365 napos
kimutatás mennyi ideig fut.

Ezért van külön forgatókönyv: `tests/load/analytics.js`.

**Amit nem mér:** hogy mi lesz egy évnyi VALÓDI adaton. A mérőverem
összesítőit szintetikus vetés tölti (lásd lent); az alakjuk valósághű, de
nem éles szám.

## 2. A mérőverem

**Soha nem az éles rendszer.** Külön konténer, külön adatbázis, külön
JWT-titok:

```bash
docker compose -f docker-compose.yml -f docker-compose.load.yml \
  --profile load up -d --build load-postgres load-app
```

| | |
|---|---|
| app | `127.0.0.1:4100` |
| adatbázis | `127.0.0.1:15433` |
| sebességkorlát | kivétel `LOAD_TEST_KEY`-jel — enélkül a mérés a korlátot mérné |

## 3. Az adat

A katalógus az éles mentésből jön (`scripts/load/seed-db.sh`): **32 463 anime,
364 064 epizód**. Az összesítőket külön vetjük:

```bash
LOAD_DATABASE_URL=postgres://yume:<jelszó>@127.0.0.1:15433/yume \
  node scripts/load/seed-analytics.mjs --days 365 --anime 400
```

Ez **szintetikus adat, és csak a mérőverembe megy**. A script megtagadja a
futást bármilyen más adatbázison: a mérőverem portja 15433, és ami nem ott
van, azt nem írja. Az éles összesítőket a worker tölti, valódi eseményekből.

A vetés után:

| Tábla | Sor |
|---|---|
| `analytics_daily` | 365 |
| `anime_stats_daily` | **146 000** |
| `analytics_breakdown` | 10 585 |
| `analytics_periods` | 66 |

## 4. A jogosult token

Az adatállomány mérőfiókjai közönséges felhasználók: a statisztikai
végpontokra 403-at kapnának, és a mérés a **jogosultság-ellenőrzés**
sebességét mérné, nem a kimutatásokét.

```bash
LOAD_DATABASE_URL=... LOAD_TEST_KEY=... node scripts/load/admin-token.mjs
```

## 5. A futtatás

```bash
k6 run tests/load/analytics.js -e VUS=25 -e DURATION=45s -e RAMP=10s \
  -e BASE_URL=http://127.0.0.1:4100 -e LOAD_TEST_KEY=... -e ADMIN_TOKEN=...
```

Egy iteráció **11 kérés** — egy teljes panelnyitás, ahogy egy üzemeltető
tényleg csinálja: Áttekintés, majd fülről fülre.

## 6. Eredmény

**Gép:** 4 mag, 9 969 MB RAM, Linux 6.8 — ugyanaz a gép, amin az éles rendszer is fut, tehát ezek a számok egy MEGOSZTOTT gépen születtek. **Build:** `41cbcba2`.
**Futás:** 45 s terhelt szakasz, 10 s felfutás, fokozatonként külön futás.

| VU | kérés/mp | p50 | p95 | p99 | max | hiba | 5xx |
|---|---|---|---|---|---|---|---|
| 5 | 222 | 7 ms | **63 ms** | 84 ms | 190 ms | 0,00% | 0 |
| 10 | 251 | 12 ms | **127 ms** | 182 ms | 345 ms | 0,00% | 0 |
| 25 | 261 | 48 ms | **257 ms** | 329 ms | 469 ms | 0,00% | 0 |
| 50 | 254 | 135 ms | **445 ms** | 541 ms | 743 ms | 0,00% | 0 |

**Minden fokozat megfelelt a küszöböknek** (p95 < 3000 ms, p99 < 6000 ms,
hibaarány < 1%, 5xx = 0, 429 = 0).

### Végpontonként (p95, ms)

| Végpont | 5 VU | 10 VU | 25 VU | 50 VU |
|---|---|---|---|---|
| `/summary` | 75 | 168 | 298 | 378 |
| `/visitors` | 9 | 16 | 63 | 164 |
| `/timeseries` | **6** | 11 | 55 | 158 |
| `/anime` | 87 | 202 | 352 | **447** |
| `/search` | 19 | 36 | 83 | 178 |
| `/performance` | 67 | 141 | 237 | 327 |
| `/providers` | 9 | 18 | 64 | 161 |
| `/users` | 8 | 15 | 61 | 162 |
| `/data-quality` | 75 | 147 | 311 | **575** |
| `/system-health` | 7 | 13 | 96 | 282 |
| `/realtime` | 43 | 72 | 136 | 226 |

## 7. Amit ez elárul

**Az átbocsátás 250 kérés/mp körül tetőzik**, és 10 VU fölött már nem nő: a
késleltetés emelkedik helyette. Ez a klasszikus telítődési alak — a
kiszolgáló ennyit tud, és a további egyidejűség sorban állás.

**A `/timeseries` a leggyorsabb** (p95 = 6 ms 5 VU-n), pedig 365 napot ad
vissza. Ez az összesítő tervének a mérése: egy napi sor olvasása 365-ször
olcsóbb, mint 365 nap nyers eseményeinek összegzése.

**A két leglassabb a `/data-quality` és az `/anime`.** Mindkettőnek megvan az
oka, és mindkettő szándékos:

* a `/data-quality` **tizenöt tábla** sorszámát olvassa (`count(*)`, pontos
  szám, nem becslés);
* az `/anime` 146 000 soros összesítőt csoportosít és rendez.

**Ha egyszer milliós nagyságrendűek lesznek ezek a táblák**, a `/data-quality`
pontos számolását becslésre (`pg_class.reltuples`) kell cserélni — de akkor a
válasz mondja is meg, hogy becslés. Ma a pontos szám olcsóbb, mint a
félreértés.

## 8. Mikor kell újra megmérni

* ha egy összesítő tábla nagyságrendet nő;
* ha új panel-végpont kerül be;
* ha a napi összesítés szerkezete változik.

Az adatok és a jelentés a `docs/analytics/load-reports/` alatt maradnak, futás
szerint dátumozva.
