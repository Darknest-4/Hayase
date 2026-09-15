# Terhelésmérés — 20260915T232416Z

| | |
|---|---|
| mérés azonosítója | `20260915T232416Z` |
| dátum | 2026-09-15T23:24:16Z |
| forgatókönyv | `tests/load/websocket.js` |
| build | `e0433697-dirty` |
| környezet | mérőverem (`docker-compose.load.yml`), http://127.0.0.1:4100 |
| gép | Linux 6.8.0-124-generic, 4 mag, 9969 MB memória |
| fokozatonként | 20s felfutás + 90s terhelés |

## A mért kapacitás

**100 egyidejű felhasználó** — ez a legmagasabb fokozat, ami küszöbsértés nélkül végigment.

Ez a fokozat **10.7 kérés/mp** átlagos terhelést jelentett, 
p95 **356 ms** késleltetéssel.

Az első fokozat, ami elbukott: **250 VU**. Amit a küszöb megfogott:

* `ws_healthy rate>0.99`

Ugyanekkor a gépen:

* processzor: 99.9 % (terhelés/mag 0.45)
* memória: 36.8 %, swap 0.0 %
* Postgres: 14 / 100 kapcsolat, ebből 2 aktív
* leghosszabb futó lekérdezés: 0.0 s, zárolásra váró: 0
* feladatsor: 1 várakozó

> A futás a 250 VU-s fokozatnál állt le. A magasabb fokozatok nem futottak.


## Fokozatok

| VU | kérés/mp | iteráció | p50 | p90 | p95 | p99 | max | hiba | 429 | 5xx | időtúllépés |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 10.7 | 1124 | 2 ms | 4 ms | 356 ms | 371 ms | 424 ms | 0.00 % | — | — | — |
| 250 | 26.3 | 2748 | 2 ms | 7 ms | 1.67 s | 4.02 s | 6.19 s | 0.07 % | — | 1 | — |

### Egyidejű felhasználó ≠ kérés/mp

A két szám nem cserélhető fel, és a legtöbb „hány felhasználót bír" kérdés azért kap rossz választ, mert felcserélik őket.

Ebben a mérésben 250 egyidejű felhasználó 26.3 kérés/mp-et jelentett, vagyis fejenként **0.11 kérés/mp** — mert egy felhasználó a kérések között OLVAS. Ez a viselkedés tulajdonsága, nem a kiszolgálóé: türelmetlenebb közönséggel ugyanaz a felhasználószám több kérést jelent.

| fogalom | mit mér | ebben a mérésben |
|---|---|---|
| egyidejű felhasználó (VU) | hányan vannak egyszerre az oldalon | 100 |
| kérés/mp | mennyit dolgozik a kiszolgáló | 10.7 |
| sávszélesség | mennyi adat megy a vezetéken | lásd lent |
| egyidejű WebSocket | hány élő kapcsolat van nyitva | külön mérés (`websocket.js`) |
| videónéző | hány adatfolyam megy egyszerre | **nem ezen a gépen** — a források külsők |

## Lépésenkénti késleltetés (a legmagasabb lefutott fokozaton)

| lépés | med | p95 | p99 | max | hívás |
|---|---:|---:|---:|---:|---:|
| `ws_connecting` | 1 ms | 2 ms | 5 ms | 14 ms | 2746 |
| `ws_handshake_ms` | 1 ms | 2 ms | 5 ms | 15 ms | 2746 |
| `ws_pong_ms` | 0 ms | 0 ms | 0 ms | 0 ms | 0 |
| `ws_session_duration` | 10.00 s | 10.00 s | 10.01 s | 10.02 s | 2746 |
| `ws_ticket_ms` | 2 ms | 5 ms | 11 ms | 5.00 s | 2748 |

## Erőforrások fokozatonként

| VU | CPU % | terh./mag | RAM % | swap % | háló be | háló ki | PG kapcs. | PG aktív | tps | gyorsítótár-találat | sor |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 52.5 | 0.14 | 32.5 | 0.0 | 52.7 kB/s | 282.6 kB/s | 9/100 | 2 | 50 | 97.02 % | 1 |
| 250 | 99.9 | 0.45 | 36.8 | 0.0 | 41.4 kB/s | 282.1 kB/s | 14/100 | 2 | 126 | 99.40 % | 1 |

Konténerenként (csúcs):

| VU | app CPU % | app RAM % | worker CPU % | postgres CPU % |
|---:|---:|---:|---:|---:|
| 100 | 182.8 | 32.2 | 0.3 | 4.8 |
| 250 | 379.9 | 75.0 | 0.6 | 8.9 |

## Mi fogyott el először

* **processzor** — 99.9 %-on állt a gép a 250 VU-s fokozaton.

## Sávszélesség

A legmagasabb lefutott fokozaton a kimenő forgalom csúcsa **282.1 kB/s**, a bejövőé 41.4 kB/s.

Ez az **alkalmazás** forgalma: JSON-válaszok és a statikus kliens. A videó ebben nincs benne és nem is lesz: a források külső szolgáltatóknál vannak, az adatfolyam nem ezen a gépen megy át. Ha egyszer saját forrás kerül a rendszerbe, a videó sávszélessége külön mérés, külön költséggel.

## Mit NEM mond ez a mérés

* Nem mond semmit a mért fokozatokon túli kapacitásról. A legmagasabb megfelelt fokozat a válasz; ami fölötte van, azt meg kell mérni, nem megbecsülni.
* A mérőverem ugyanazon a gépen fut, mint az éles példány. A futás ideje alatt osztoznak a processzoron, tehát ezek a számok inkább alsó becslések, mint felsők.
* A videó lejátszásának terhelését nem méri — lásd a sávszélesség szakaszt.
* Egyetlen futás nem trend. Két mérés között a build és az adatállomány is változik; a jelentés fejléce épp ezért írja ki mindkettőt.
