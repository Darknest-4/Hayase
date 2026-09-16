# Terhelésmérés — 20260915T233055Z

| | |
|---|---|
| mérés azonosítója | `20260915T233055Z` |
| dátum | 2026-09-15T23:30:55Z |
| forgatókönyv | `tests/load/websocket.js` |
| build | `e0433697-dirty` |
| környezet | mérőverem (`docker-compose.load.yml`), http://127.0.0.1:4100 |
| gép | Linux 6.8.0-124-generic, 4 mag, 9969 MB memória |
| fokozatonként | 20s felfutás + 2m terhelés |

## A mért kapacitás

**Nincs megfelelt fokozat.** Már a legkisebb terhelés is átlépte valamelyik küszöböt — a részletek lent.

Az első fokozat, ami elbukott: **250 VU**. Amit a küszöb megfogott:

* `ws_healthy rate>0.99`

Ugyanekkor a gépen:

* processzor: 99.8 % (terhelés/mag 0.36)
* memória: 36.1 %, swap 0.0 %
* Postgres: 14 / 100 kapcsolat, ebből 1 aktív
* leghosszabb futó lekérdezés: 0.0 s, zárolásra váró: 0
* feladatsor: 1 várakozó

> A futás a 250 VU-s fokozatnál állt le. A magasabb fokozatok nem futottak.


## Fokozatok

| VU | kérés/mp | iteráció | p50 | p90 | p95 | p99 | max | hiba | 429 | 5xx | időtúllépés |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 250 | 8.6 | 519 | 3 ms | 2.07 s | 3.24 s | 5.00 s | 8.15 s | 2.57 % | — | 11 | — |

### Egyidejű felhasználó ≠ kérés/mp

A két szám nem cserélhető fel, és a legtöbb „hány felhasználót bír" kérdés azért kap rossz választ, mert felcserélik őket.

Ebben a mérésben 250 egyidejű felhasználó 8.6 kérés/mp-et jelentett, vagyis fejenként **0.03 kérés/mp** — mert egy felhasználó a kérések között OLVAS. Ez a viselkedés tulajdonsága, nem a kiszolgálóé: türelmetlenebb közönséggel ugyanaz a felhasználószám több kérést jelent.

| fogalom | mit mér | ebben a mérésben |
|---|---|---|
| egyidejű felhasználó (VU) | hányan vannak egyszerre az oldalon | — |
| kérés/mp | mennyit dolgozik a kiszolgáló | — |
| sávszélesség | mennyi adat megy a vezetéken | lásd lent |
| egyidejű WebSocket | hány élő kapcsolat van nyitva | külön mérés (`websocket.js`) |
| videónéző | hány adatfolyam megy egyszerre | **nem ezen a gépen** — a források külsők |

## Lépésenkénti késleltetés (a legmagasabb lefutott fokozaton)

| lépés | med | p95 | p99 | max | hívás |
|---|---:|---:|---:|---:|---:|
| `ws_connecting` | 1 ms | 3 ms | 4 ms | 10 ms | 720 |
| `ws_handshake_ms` | 1 ms | 3 ms | 4 ms | 10 ms | 720 |
| `ws_pong_ms` | 1 ms | 1 ms | 3 ms | 17 ms | 3214 |
| `ws_session_duration` | 60.00 s | 60.00 s | 60.01 s | 60.01 s | 500 |
| `ws_ticket_ms` | 3 ms | 7 ms | 5.00 s | 5.01 s | 739 |

## Erőforrások fokozatonként

| VU | CPU % | terh./mag | RAM % | swap % | háló be | háló ki | PG kapcs. | PG aktív | tps | gyorsítótár-találat | sor |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 250 | 99.8 | 0.36 | 36.1 | 0.0 | 37.0 kB/s | 65.4 kB/s | 14/100 | 1 | 112 | 99.76 % | 1 |

Konténerenként (csúcs):

| VU | app CPU % | app RAM % | worker CPU % | postgres CPU % |
|---:|---:|---:|---:|---:|
| 250 | 379.9 | 62.7 | 0.6 | 7.1 |

## Mi fogyott el először

* **processzor** — 99.8 %-on állt a gép a 250 VU-s fokozaton.

## Sávszélesség

A legmagasabb lefutott fokozaton a kimenő forgalom csúcsa **65.4 kB/s**, a bejövőé 37.0 kB/s.

Ez az **alkalmazás** forgalma: JSON-válaszok és a statikus kliens. A videó ebben nincs benne és nem is lesz: a források külső szolgáltatóknál vannak, az adatfolyam nem ezen a gépen megy át. Ha egyszer saját forrás kerül a rendszerbe, a videó sávszélessége külön mérés, külön költséggel.

## Mit NEM mond ez a mérés

* Nem mond semmit a mért fokozatokon túli kapacitásról. A legmagasabb megfelelt fokozat a válasz; ami fölötte van, azt meg kell mérni, nem megbecsülni.
* A mérőverem ugyanazon a gépen fut, mint az éles példány. A futás ideje alatt osztoznak a processzoron, tehát ezek a számok inkább alsó becslések, mint felsők.
* A videó lejátszásának terhelését nem méri — lásd a sávszélesség szakaszt.
* Egyetlen futás nem trend. Két mérés között a build és az adatállomány is változik; a jelentés fejléce épp ezért írja ki mindkettőt.
