# Terhelésmérés — 20260915T214511Z

| | |
|---|---|
| mérés azonosítója | `20260915T214511Z` |
| dátum | 2026-09-15T21:45:11Z |
| forgatókönyv | `tests/load/main.js` |
| build | `e0433697-dirty` |
| környezet | mérőverem (`docker-compose.load.yml`), http://127.0.0.1:4100 |
| gép | Linux 6.8.0-124-generic, 4 mag, 9969 MB memória |
| fokozatonként | 30s felfutás + 3m terhelés |

## A mért kapacitás

**50 egyidejű felhasználó** — ez a legmagasabb fokozat, ami küszöbsértés nélkül végigment.

Ez a fokozat **12.1 kérés/mp** átlagos terhelést jelentett, 
p95 **48 ms** késleltetéssel.

Az első fokozat, ami elbukott: **100 VU**. Amit a küszöb megfogott:

* `yume_failed rate<0.01`

Ugyanekkor a gépen:

* processzor: 21.4 % (terhelés/mag 0.29)
* memória: 28.5 %, swap 0.0 %
* Postgres: 13 / 100 kapcsolat, ebből 3 aktív
* leghosszabb futó lekérdezés: 0.4 s, zárolásra váró: 0
* feladatsor: 1 várakozó

> A futás a 100 VU-s fokozatnál állt le. A magasabb fokozatok nem futottak.


## Fokozatok

| VU | kérés/mp | iteráció | p50 | p90 | p95 | p99 | max | hiba | 429 | 5xx | időtúllépés |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 2.2 | 35 | 3 ms | 9 ms | 31 ms | 118 ms | 295 ms | 0.00 % | 0 | 0 | — |
| 25 | 5.4 | 91 | 3 ms | 10 ms | 33 ms | 134 ms | 563 ms | 0.00 % | 0 | 0 | — |
| 50 | 12.1 | 170 | 3 ms | 20 ms | 48 ms | 175 ms | 602 ms | 0.00 % | 0 | 0 | — |
| 100 | 24.8 | 324 | 2 ms | 17 ms | 48 ms | 198 ms | 594 ms | 8.73 % | 0 | 0 | — |

### Egyidejű felhasználó ≠ kérés/mp

A két szám nem cserélhető fel, és a legtöbb „hány felhasználót bír" kérdés azért kap rossz választ, mert felcserélik őket.

Ebben a mérésben 100 egyidejű felhasználó 24.8 kérés/mp-et jelentett, vagyis fejenként **0.25 kérés/mp** — mert egy felhasználó a kérések között OLVAS. Ez a viselkedés tulajdonsága, nem a kiszolgálóé: türelmetlenebb közönséggel ugyanaz a felhasználószám több kérést jelent.

| fogalom | mit mér | ebben a mérésben |
|---|---|---|
| egyidejű felhasználó (VU) | hányan vannak egyszerre az oldalon | 50 |
| kérés/mp | mennyit dolgozik a kiszolgáló | 12.1 |
| sávszélesség | mennyi adat megy a vezetéken | lásd lent |
| egyidejű WebSocket | hány élő kapcsolat van nyitva | külön mérés (`websocket.js`) |
| videónéző | hány adatfolyam megy egyszerre | **nem ezen a gépen** — a források külsők |

## Lépésenkénti késleltetés (a legmagasabb lefutott fokozaton)

| lépés | med | p95 | p99 | max | hívás |
|---|---:|---:|---:|---:|---:|
| `step_browse` | 5 ms | 132 ms | 143 ms | 150 ms | 196 |
| `step_config` | 1 ms | 2 ms | 4 ms | 12 ms | 386 |
| `step_continue` | 1 ms | 3 ms | 5 ms | 7 ms | 132 |
| `step_details` | 2 ms | 5 ms | 7 ms | 12 ms | 1752 |
| `step_episodes` | 2 ms | 4 ms | 6 ms | 16 ms | 438 |
| `step_favorites` | 1 ms | 5 ms | 6 ms | 6 ms | 74 |
| `step_home` | 2 ms | 3 ms | 5 ms | 8 ms | 542 |
| `step_library` | 2 ms | 5 ms | 6 ms | 7 ms | 140 |
| `step_progress` | 2 ms | 4 ms | 6 ms | 7 ms | 548 |
| `step_schedule` | 4 ms | 5 ms | 6 ms | 6 ms | 36 |
| `step_search` | 44 ms | 229 ms | 251 ms | 304 ms | 283 |
| `step_sources` | 2 ms | 3 ms | 4 ms | 4 ms | 342 |
| `step_suggest` | 15 ms | 112 ms | 322 ms | 594 ms | 849 |

## Erőforrások fokozatonként

| VU | CPU % | terh./mag | RAM % | swap % | háló be | háló ki | PG kapcs. | PG aktív | tps | gyorsítótár-találat | sor |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 32.0 | 0.23 | 28.6 | 0.0 | 86.1 kB/s | 3.66 MB/s | 9/100 | 1 | 14 | 94.87 % | 1 |
| 25 | 33.0 | 0.31 | 26.8 | 0.0 | 75.0 kB/s | 2.68 MB/s | 9/100 | 2 | 23 | 96.79 % | 1 |
| 50 | 41.9 | 0.09 | 28.4 | 0.0 | 191.0 kB/s | 2.53 MB/s | 10/100 | 2 | 43 | 96.73 % | 1 |
| 100 | 21.4 | 0.29 | 28.5 | 0.0 | 81.0 kB/s | 1.50 MB/s | 13/100 | 3 | 73 | 97.97 % | 1 |

Konténerenként (csúcs):

| VU | app CPU % | app RAM % | worker CPU % | postgres CPU % |
|---:|---:|---:|---:|---:|
| 10 | 13.3 | 7.2 | 1.3 | 16.1 |
| 25 | 13.4 | 7.2 | 5.1 | 43.6 |
| 50 | 14.7 | 7.5 | 1.1 | 59.0 |
| 100 | 15.8 | 7.9 | 0.6 | 94.3 |

## Mi fogyott el először

* Egyik mért erőforrás sem ért a küszöbéig. Ahol a késleltetés mégis nőtt, ott az ok nem a gép telítettsége, hanem a kiszolgálás soros pontjai — a lépésenkénti táblázat mutatja, melyik hívás vitte az időt.

## Sávszélesség

A legmagasabb lefutott fokozaton a kimenő forgalom csúcsa **1.50 MB/s**, a bejövőé 81.0 kB/s.

Ez az **alkalmazás** forgalma: JSON-válaszok és a statikus kliens. A videó ebben nincs benne és nem is lesz: a források külső szolgáltatóknál vannak, az adatfolyam nem ezen a gépen megy át. Ha egyszer saját forrás kerül a rendszerbe, a videó sávszélessége külön mérés, külön költséggel.

## Mit NEM mond ez a mérés

* Nem mond semmit a mért fokozatokon túli kapacitásról. A legmagasabb megfelelt fokozat a válasz; ami fölötte van, azt meg kell mérni, nem megbecsülni.
* A mérőverem ugyanazon a gépen fut, mint az éles példány. A futás ideje alatt osztoznak a processzoron, tehát ezek a számok inkább alsó becslések, mint felsők.
* A videó lejátszásának terhelését nem méri — lásd a sávszélesség szakaszt.
* Egyetlen futás nem trend. Két mérés között a build és az adatállomány is változik; a jelentés fejléce épp ezért írja ki mindkettőt.
