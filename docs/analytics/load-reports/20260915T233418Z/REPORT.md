# Terhelésmérés — 20260915T233418Z

| | |
|---|---|
| mérés azonosítója | `20260915T233418Z` |
| dátum | 2026-09-15T23:34:18Z |
| forgatókönyv | `tests/load/playback.js` |
| build | `e0433697-dirty` |
| környezet | mérőverem (`docker-compose.load.yml`), http://127.0.0.1:4100 |
| gép | Linux 6.8.0-124-generic, 4 mag, 9969 MB memória |
| fokozatonként | 20s felfutás + 2m terhelés |

## A mért kapacitás

**250 egyidejű felhasználó** — ez a legmagasabb fokozat, ami küszöbsértés nélkül végigment.

Ez a fokozat **23.7 kérés/mp** átlagos terhelést jelentett, 
p95 **1.17 s** késleltetéssel.

Minden lefutott fokozat megfelelt. A felső határ tehát **nem ismert** — a mérés 250 VU-nál ért véget, nem a kiszolgáló bírásánál.


## Fokozatok

| VU | kérés/mp | iteráció | p50 | p90 | p95 | p99 | max | hiba | 429 | 5xx | időtúllépés |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 9.5 | 100 | 2 ms | 4 ms | 351 ms | 364 ms | 387 ms | 0.00 % | 0 | 0 | — |
| 250 | 23.7 | 250 | 3 ms | 6 ms | 1.17 s | 4.20 s | 4.75 s | 0.00 % | 0 | 0 | — |

### Egyidejű felhasználó ≠ kérés/mp

A két szám nem cserélhető fel, és a legtöbb „hány felhasználót bír" kérdés azért kap rossz választ, mert felcserélik őket.

Ebben a mérésben 250 egyidejű felhasználó 23.7 kérés/mp-et jelentett, vagyis fejenként **0.09 kérés/mp** — mert egy felhasználó a kérések között OLVAS. Ez a viselkedés tulajdonsága, nem a kiszolgálóé: türelmetlenebb közönséggel ugyanaz a felhasználószám több kérést jelent.

| fogalom | mit mér | ebben a mérésben |
|---|---|---|
| egyidejű felhasználó (VU) | hányan vannak egyszerre az oldalon | 250 |
| kérés/mp | mennyit dolgozik a kiszolgáló | 23.7 |
| sávszélesség | mennyi adat megy a vezetéken | lásd lent |
| egyidejű WebSocket | hány élő kapcsolat van nyitva | külön mérés (`websocket.js`) |
| videónéző | hány adatfolyam megy egyszerre | **nem ezen a gépen** — a források külsők |

## Lépésenkénti késleltetés (a legmagasabb lefutott fokozaton)

| lépés | med | p95 | p99 | max | hívás |
|---|---:|---:|---:|---:|---:|
| `play_progress_ms` | 3 ms | 6 ms | 11 ms | 24 ms | 1405 |
| `play_skips_ms` | 1 ms | 4 ms | 5 ms | 14 ms | 500 |
| `play_source_resolve_ms` | 2 ms | 6 ms | 9 ms | 16 ms | 500 |
| `play_startup_ms` | 7 ms | 18 ms | 34 ms | 2.91 s | 1000 |
| `play_subtitles_ms` | 1 ms | 4 ms | 6 ms | 11 ms | 500 |

## Erőforrások fokozatonként

| VU | CPU % | terh./mag | RAM % | swap % | háló be | háló ki | PG kapcs. | PG aktív | tps | gyorsítótár-találat | sor |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 51.0 | 0.42 | 33.3 | 0.0 | 41.0 kB/s | 27.7 kB/s | 9/100 | 2 | 87 | 97.86 % | 1 |
| 250 | 99.9 | 0.43 | 36.5 | 0.0 | 41.7 kB/s | 20.7 kB/s | 13/100 | 1 | 219 | 97.94 % | 1 |

Konténerenként (csúcs):

| VU | app CPU % | app RAM % | worker CPU % | postgres CPU % |
|---:|---:|---:|---:|---:|
| 100 | 189.9 | 32.2 | 0.9 | 7.2 |
| 250 | 385.1 | 69.3 | 1.4 | 7.9 |

## Mi fogyott el először

* **processzor** — 99.9 %-on állt a gép a 250 VU-s fokozaton.

## Sávszélesség

A legmagasabb lefutott fokozaton a kimenő forgalom csúcsa **20.7 kB/s**, a bejövőé 41.7 kB/s.

Ez az **alkalmazás** forgalma: JSON-válaszok és a statikus kliens. A videó ebben nincs benne és nem is lesz: a források külső szolgáltatóknál vannak, az adatfolyam nem ezen a gépen megy át. Ha egyszer saját forrás kerül a rendszerbe, a videó sávszélessége külön mérés, külön költséggel.

## Mit NEM mond ez a mérés

* Nem mond semmit a mért fokozatokon túli kapacitásról. A legmagasabb megfelelt fokozat a válasz; ami fölötte van, azt meg kell mérni, nem megbecsülni.
* A mérőverem ugyanazon a gépen fut, mint az éles példány. A futás ideje alatt osztoznak a processzoron, tehát ezek a számok inkább alsó becslések, mint felsők.
* A videó lejátszásának terhelését nem méri — lásd a sávszélesség szakaszt.
* Egyetlen futás nem trend. Két mérés között a build és az adatállomány is változik; a jelentés fejléce épp ezért írja ki mindkettőt.
