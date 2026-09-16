# Terhelésmérés — 20260915T221142Z

| | |
|---|---|
| mérés azonosítója | `20260915T221142Z` |
| dátum | 2026-09-15T22:11:42Z |
| forgatókönyv | `tests/load/main.js` |
| build | `e0433697-dirty` |
| környezet | mérőverem (`docker-compose.load.yml`), http://127.0.0.1:4100 |
| gép | Linux 6.8.0-124-generic, 4 mag, 9969 MB memória |
| fokozatonként | 30s felfutás + 3m terhelés |

## A mért kapacitás

**250 egyidejű felhasználó** — ez a legmagasabb fokozat, ami küszöbsértés nélkül végigment.

Ez a fokozat **59.7 kérés/mp** átlagos terhelést jelentett, 
p95 **53 ms** késleltetéssel.

Az első fokozat, ami elbukott: **500 VU**. Amit a küszöb megfogott:

* `http_req_duration p(99)<2500`

Ugyanekkor a gépen:

* processzor: 100.0 % (terhelés/mag 2.32)
* memória: 45.0 %, swap 0.0 %
* Postgres: 26 / 100 kapcsolat, ebből 17 aktív
* leghosszabb futó lekérdezés: 2.6 s, zárolásra váró: 0
* feladatsor: 1 várakozó

> A futás a 500 VU-s fokozatnál állt le. A magasabb fokozatok nem futottak.


## Fokozatok

| VU | kérés/mp | iteráció | p50 | p90 | p95 | p99 | max | hiba | 429 | 5xx | időtúllépés |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 1.9 | 28 | 3 ms | 16 ms | 36 ms | 115 ms | 324 ms | 0.00 % | 0 | 0 | — |
| 25 | 5.4 | 84 | 3 ms | 13 ms | 39 ms | 205 ms | 590 ms | 0.00 % | 0 | 0 | — |
| 50 | 11.5 | 168 | 3 ms | 19 ms | 44 ms | 225 ms | 590 ms | 0.00 % | 0 | 0 | — |
| 100 | 23.0 | 328 | 3 ms | 17 ms | 43 ms | 196 ms | 649 ms | 0.00 % | 0 | 0 | — |
| 250 | 59.7 | 832 | 3 ms | 22 ms | 53 ms | 258 ms | 686 ms | 0.00 % | 0 | 0 | — |
| 500 | 114.2 | 1615 | 5 ms | 68 ms | 194 ms | 2.76 s | 12.81 s | 0.00 % | 0 | 0 | — |

### Egyidejű felhasználó ≠ kérés/mp

A két szám nem cserélhető fel, és a legtöbb „hány felhasználót bír" kérdés azért kap rossz választ, mert felcserélik őket.

Ebben a mérésben 500 egyidejű felhasználó 114.2 kérés/mp-et jelentett, vagyis fejenként **0.23 kérés/mp** — mert egy felhasználó a kérések között OLVAS. Ez a viselkedés tulajdonsága, nem a kiszolgálóé: türelmetlenebb közönséggel ugyanaz a felhasználószám több kérést jelent.

| fogalom | mit mér | ebben a mérésben |
|---|---|---|
| egyidejű felhasználó (VU) | hányan vannak egyszerre az oldalon | 250 |
| kérés/mp | mennyit dolgozik a kiszolgáló | 59.7 |
| sávszélesség | mennyi adat megy a vezetéken | lásd lent |
| egyidejű WebSocket | hány élő kapcsolat van nyitva | külön mérés (`websocket.js`) |
| videónéző | hány adatfolyam megy egyszerre | **nem ezen a gépen** — a források külsők |

## Lépésenkénti késleltetés (a legmagasabb lefutott fokozaton)

| lépés | med | p95 | p99 | max | hívás |
|---|---:|---:|---:|---:|---:|
| `step_browse` | 7 ms | 149 ms | 536 ms | 3.53 s | 993 |
| `step_config` | 2 ms | 30 ms | 252 ms | 402 ms | 1899 |
| `step_continue` | 4 ms | 37 ms | 423 ms | 3.60 s | 643 |
| `step_details` | 4 ms | 29 ms | 149 ms | 3.90 s | 8516 |
| `step_episodes` | 4 ms | 36 ms | 303 ms | 3.84 s | 2129 |
| `step_favorites` | 2 ms | 8 ms | 18 ms | 279 ms | 356 |
| `step_home` | 3 ms | 20 ms | 119 ms | 240 ms | 2768 |
| `step_library` | 4 ms | 26 ms | 384 ms | 532 ms | 734 |
| `step_progress` | 3 ms | 19 ms | 56 ms | 689 ms | 2583 |
| `step_schedule` | 4 ms | 8 ms | 14 ms | 28 ms | 187 |
| `step_search` | 66 ms | 620 ms | 1.55 s | 3.88 s | 1293 |
| `step_sources` | 3 ms | 29 ms | 295 ms | 413 ms | 1650 |
| `step_suggest` | 27 ms | 343 ms | 1.03 s | 3.72 s | 3879 |

## Erőforrások fokozatonként

| VU | CPU % | terh./mag | RAM % | swap % | háló be | háló ki | PG kapcs. | PG aktív | tps | gyorsítótár-találat | sor |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 8.4 | 0.24 | 25.9 | 0.0 | 58.8 kB/s | 2.62 MB/s | 10/100 | 2 | 16 | 95.78 % | 1 |
| 25 | 11.0 | 0.18 | 26.3 | 0.0 | 46.5 kB/s | 1.28 MB/s | 12/100 | 2 | 25 | 90.80 % | 1 |
| 50 | 12.2 | 0.07 | 26.0 | 0.0 | 42.4 kB/s | 24.4 kB/s | 9/100 | 2 | 45 | 96.00 % | 1 |
| 100 | 16.7 | 0.21 | 28.0 | 0.0 | 57.9 kB/s | 26.1 kB/s | 10/100 | 3 | 82 | 97.93 % | 1 |
| 250 | 51.8 | 0.25 | 34.7 | 0.0 | 39.4 kB/s | 24.5 kB/s | 16/100 | 3 | 209 | 97.90 % | 1 |
| 500 | 100.0 | 2.32 | 45.0 | 0.0 | 53.4 kB/s | 23.7 kB/s | 26/100 | 17 | 368 | 97.82 % | 1 |

Konténerenként (csúcs):

| VU | app CPU % | app RAM % | worker CPU % | postgres CPU % |
|---:|---:|---:|---:|---:|
| 10 | 16.0 | 7.9 | 1.2 | 29.2 |
| 25 | 13.3 | 9.8 | 1.0 | 48.5 |
| 50 | 14.5 | 8.0 | 0.7 | 58.0 |
| 100 | 26.7 | 8.1 | 1.0 | 104.6 |
| 250 | 295.6 | 24.9 | 1.1 | 148.3 |
| 500 | 299.9 | 76.3 | 0.6 | 217.8 |

## Mi fogyott el először

* **processzor** — 100.0 %-on állt a gép a 500 VU-s fokozaton.

## Sávszélesség

A legmagasabb lefutott fokozaton a kimenő forgalom csúcsa **23.7 kB/s**, a bejövőé 53.4 kB/s.

Ez az **alkalmazás** forgalma: JSON-válaszok és a statikus kliens. A videó ebben nincs benne és nem is lesz: a források külső szolgáltatóknál vannak, az adatfolyam nem ezen a gépen megy át. Ha egyszer saját forrás kerül a rendszerbe, a videó sávszélessége külön mérés, külön költséggel.

## Mit NEM mond ez a mérés

* Nem mond semmit a mért fokozatokon túli kapacitásról. A legmagasabb megfelelt fokozat a válasz; ami fölötte van, azt meg kell mérni, nem megbecsülni.
* A mérőverem ugyanazon a gépen fut, mint az éles példány. A futás ideje alatt osztoznak a processzoron, tehát ezek a számok inkább alsó becslések, mint felsők.
* A videó lejátszásának terhelését nem méri — lásd a sávszélesség szakaszt.
* Egyetlen futás nem trend. Két mérés között a build és az adatállomány is változik; a jelentés fejléce épp ezért írja ki mindkettőt.
