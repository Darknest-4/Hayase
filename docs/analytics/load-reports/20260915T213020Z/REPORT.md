# Terhelésmérés — 20260915T213020Z

| | |
|---|---|
| mérés azonosítója | `20260915T213020Z` |
| dátum | 2026-09-15T21:30:20Z |
| forgatókönyv | `tests/load/main.js` |
| build | `e0433697-dirty` |
| környezet | mérőverem (`docker-compose.load.yml`), http://127.0.0.1:4100 |
| gép | Linux 6.8.0-124-generic, 4 mag, 9969 MB memória |
| fokozatonként | 30s felfutás + 3m terhelés |

## A mért kapacitás

**10 egyidejű felhasználó** — ez a legmagasabb fokozat, ami küszöbsértés nélkül végigment.

Ez a fokozat **2.0 kérés/mp** átlagos terhelést jelentett, 
p95 **48 ms** késleltetéssel.

Az első fokozat, ami elbukott: **25 VU**. Amit a küszöb megfogott:

* `yume_failed rate<0.01`

Ugyanekkor a gépen:

* processzor: 35.1 % (terhelés/mag 0.17)
* memória: 28.4 %, swap 0.0 %
* Postgres: 9 / 100 kapcsolat, ebből 2 aktív
* leghosszabb futó lekérdezés: 0.2 s, zárolásra váró: 0
* feladatsor: 1 várakozó

> A futás a 25 VU-s fokozatnál állt le. A magasabb fokozatok nem futottak.


## Fokozatok

| VU | kérés/mp | iteráció | p50 | p90 | p95 | p99 | max | hiba | 429 | 5xx | időtúllépés |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 2.0 | 33 | 3 ms | 12 ms | 48 ms | 125 ms | 245 ms | 0.00 % | 0 | 0 | — |
| 25 | 5.3 | 83 | 3 ms | 10 ms | 30 ms | 112 ms | 610 ms | 10.51 % | 0 | 0 | — |

### Egyidejű felhasználó ≠ kérés/mp

A két szám nem cserélhető fel, és a legtöbb „hány felhasználót bír" kérdés azért kap rossz választ, mert felcserélik őket.

Ebben a mérésben 25 egyidejű felhasználó 5.3 kérés/mp-et jelentett, vagyis fejenként **0.21 kérés/mp** — mert egy felhasználó a kérések között OLVAS. Ez a viselkedés tulajdonsága, nem a kiszolgálóé: türelmetlenebb közönséggel ugyanaz a felhasználószám több kérést jelent.

| fogalom | mit mér | ebben a mérésben |
|---|---|---|
| egyidejű felhasználó (VU) | hányan vannak egyszerre az oldalon | 10 |
| kérés/mp | mennyit dolgozik a kiszolgáló | 2.0 |
| sávszélesség | mennyi adat megy a vezetéken | lásd lent |
| egyidejű WebSocket | hány élő kapcsolat van nyitva | külön mérés (`websocket.js`) |
| videónéző | hány adatfolyam megy egyszerre | **nem ezen a gépen** — a források külsők |

## Lépésenkénti késleltetés (a legmagasabb lefutott fokozaton)

| lépés | med | p95 | p99 | max | hívás |
|---|---:|---:|---:|---:|---:|
| `step_browse` | 5 ms | 11 ms | 81 ms | 174 ms | 58 |
| `step_config` | 2 ms | 3 ms | 5 ms | 14 ms | 98 |
| `step_continue` | 3 ms | 5 ms | 6 ms | 6 ms | 32 |
| `step_details` | 3 ms | 6 ms | 10 ms | 19 ms | 452 |
| `step_episodes` | 2 ms | 5 ms | 14 ms | 29 ms | 113 |
| `step_favorites` | 1 ms | 3 ms | 3 ms | 3 ms | 16 |
| `step_home` | 2 ms | 3 ms | 5 ms | 6 ms | 152 |
| `step_library` | 1 ms | 7 ms | 12 ms | 15 ms | 36 |
| `step_progress` | 2 ms | 4 ms | 5 ms | 6 ms | 132 |
| `step_schedule` | 4 ms | 5 ms | 6 ms | 6 ms | 9 |
| `step_search` | 44 ms | 201 ms | 233 ms | 236 ms | 43 |
| `step_sources` | 2 ms | 4 ms | 4 ms | 5 ms | 91 |
| `step_suggest` | 17 ms | 110 ms | 278 ms | 610 ms | 129 |

## Erőforrások fokozatonként

| VU | CPU % | terh./mag | RAM % | swap % | háló be | háló ki | PG kapcs. | PG aktív | tps | gyorsítótár-találat | sor |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 31.7 | 0.11 | 25.9 | 0.0 | 80.6 kB/s | 3.21 MB/s | 8/100 | 2 | 15 | 94.46 % | 1 |
| 25 | 35.1 | 0.17 | 28.4 | 0.0 | 83.1 kB/s | 4.65 MB/s | 9/100 | 2 | 28 | 96.32 % | 1 |

Konténerenként (csúcs):

| VU | app CPU % | app RAM % | worker CPU % | postgres CPU % |
|---:|---:|---:|---:|---:|
| 10 | 14.1 | 8.7 | 0.9 | 26.6 |
| 25 | 18.1 | 7.3 | 1.2 | 63.7 |

## Mi fogyott el először

* Egyik mért erőforrás sem ért a küszöbéig. Ahol a késleltetés mégis nőtt, ott az ok nem a gép telítettsége, hanem a kiszolgálás soros pontjai — a lépésenkénti táblázat mutatja, melyik hívás vitte az időt.

## Sávszélesség

A legmagasabb lefutott fokozaton a kimenő forgalom csúcsa **4.65 MB/s**, a bejövőé 83.1 kB/s.

Ez az **alkalmazás** forgalma: JSON-válaszok és a statikus kliens. A videó ebben nincs benne és nem is lesz: a források külső szolgáltatóknál vannak, az adatfolyam nem ezen a gépen megy át. Ha egyszer saját forrás kerül a rendszerbe, a videó sávszélessége külön mérés, külön költséggel.

## Mit NEM mond ez a mérés

* Nem mond semmit a mért fokozatokon túli kapacitásról. A legmagasabb megfelelt fokozat a válasz; ami fölötte van, azt meg kell mérni, nem megbecsülni.
* A mérőverem ugyanazon a gépen fut, mint az éles példány. A futás ideje alatt osztoznak a processzoron, tehát ezek a számok inkább alsó becslések, mint felsők.
* A videó lejátszásának terhelését nem méri — lásd a sávszélesség szakaszt.
* Egyetlen futás nem trend. Két mérés között a build és az adatállomány is változik; a jelentés fejléce épp ezért írja ki mindkettőt.
