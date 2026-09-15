# Terhelésmérés — 20260915T212447Z

| | |
|---|---|
| mérés azonosítója | `20260915T212447Z` |
| dátum | 2026-09-15T21:24:47Z |
| forgatókönyv | `tests/load/main.js` |
| build | `e0433697-dirty` |
| környezet | mérőverem (`docker-compose.load.yml`), http://127.0.0.1:4100 |
| gép | Linux 6.8.0-124-generic, 4 mag, 9969 MB memória |
| fokozatonként | 10s felfutás + 45s terhelés |

## A mért kapacitás

**25 egyidejű felhasználó** — ez a legmagasabb fokozat, ami küszöbsértés nélkül végigment.

Ez a fokozat **5.3 kérés/mp** átlagos terhelést jelentett, 
p95 **42 ms** késleltetéssel.

Minden lefutott fokozat megfelelt. A felső határ tehát **nem ismert** — a mérés 25 VU-nál ért véget, nem a kiszolgáló bírásánál.


## Fokozatok

| VU | kérés/mp | iteráció | p50 | p90 | p95 | p99 | max | hiba | 429 | 5xx | időtúllépés |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 2.7 | 13 | 3 ms | 24 ms | 54 ms | 387 ms | 653 ms | 0.00 % | 0 | 0 | — |
| 25 | 5.3 | 22 | 3 ms | 11 ms | 42 ms | 133 ms | 586 ms | 0.00 % | 0 | 0 | — |

### Egyidejű felhasználó ≠ kérés/mp

A két szám nem cserélhető fel, és a legtöbb „hány felhasználót bír" kérdés azért kap rossz választ, mert felcserélik őket.

Ebben a mérésben 25 egyidejű felhasználó 5.3 kérés/mp-et jelentett, vagyis fejenként **0.21 kérés/mp** — mert egy felhasználó a kérések között OLVAS. Ez a viselkedés tulajdonsága, nem a kiszolgálóé: türelmetlenebb közönséggel ugyanaz a felhasználószám több kérést jelent.

| fogalom | mit mér | ebben a mérésben |
|---|---|---|
| egyidejű felhasználó (VU) | hányan vannak egyszerre az oldalon | 25 |
| kérés/mp | mennyit dolgozik a kiszolgáló | 5.3 |
| sávszélesség | mennyi adat megy a vezetéken | lásd lent |
| egyidejű WebSocket | hány élő kapcsolat van nyitva | külön mérés (`websocket.js`) |
| videónéző | hány adatfolyam megy egyszerre | **nem ezen a gépen** — a források külsők |

## Lépésenkénti késleltetés (a legmagasabb lefutott fokozaton)

| lépés | med | p95 | p99 | max | hívás |
|---|---:|---:|---:|---:|---:|
| `step_browse` | 4 ms | 123 ms | 133 ms | 134 ms | — |
| `step_config` | 2 ms | 3 ms | 11 ms | 15 ms | — |
| `step_continue` | 3 ms | 5 ms | 7 ms | 7 ms | — |
| `step_details` | 3 ms | 7 ms | 11 ms | 11 ms | — |
| `step_episodes` | 2 ms | 5 ms | 9 ms | 12 ms | — |
| `step_favorites` | 3 ms | 3 ms | 3 ms | 3 ms | — |
| `step_home` | 2 ms | 3 ms | 5 ms | 7 ms | — |
| `step_library` | 4 ms | 4 ms | 5 ms | 5 ms | — |
| `step_progress` | 4 ms | 5 ms | 8 ms | 11 ms | — |
| `step_schedule` | 4 ms | 4 ms | 4 ms | 4 ms | — |
| `step_search` | 47 ms | 122 ms | 200 ms | 220 ms | — |
| `step_sources` | 3 ms | 3 ms | 4 ms | 4 ms | — |
| `step_suggest` | 19 ms | 189 ms | 456 ms | 586 ms | — |

## Erőforrások fokozatonként

| VU | CPU % | terh./mag | RAM % | swap % | háló be | háló ki | PG kapcs. | PG aktív | tps | gyorsítótár-találat | sor |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 9.8 | 0.11 | 25.8 | 0.0 | 0.1 MB/s | 0.2 MB/s | —/— | — | — | — | — |
| 25 | 16.2 | 0.04 | 25.8 | 0.0 | 0.0 MB/s | 0.0 MB/s | —/— | — | — | — | — |

Konténerenként (csúcs):

| VU | app CPU % | app RAM % | worker CPU % | postgres CPU % |
|---:|---:|---:|---:|---:|
| 10 | 13.4 | 7.0 | 3.1 | 17.2 |
| 25 | 2.5 | 6.8 | 0.7 | 13.2 |

## Mi fogyott el először

* Egyik mért erőforrás sem ért a küszöbéig. Ahol a késleltetés mégis nőtt, ott az ok nem a gép telítettsége, hanem a kiszolgálás soros pontjai — a lépésenkénti táblázat mutatja, melyik hívás vitte az időt.

## Sávszélesség

A legmagasabb lefutott fokozaton a kimenő forgalom csúcsa **0.0 MB/s**, a bejövőé 0.0 MB/s.

Ez az **alkalmazás** forgalma: JSON-válaszok és a statikus kliens. A videó ebben nincs benne és nem is lesz: a források külső szolgáltatóknál vannak, az adatfolyam nem ezen a gépen megy át. Ha egyszer saját forrás kerül a rendszerbe, a videó sávszélessége külön mérés, külön költséggel.

## Mit NEM mond ez a mérés

* Nem mond semmit a mért fokozatokon túli kapacitásról. A legmagasabb megfelelt fokozat a válasz; ami fölötte van, azt meg kell mérni, nem megbecsülni.
* A mérőverem ugyanazon a gépen fut, mint az éles példány. A futás ideje alatt osztoznak a processzoron, tehát ezek a számok inkább alsó becslések, mint felsők.
* A videó lejátszásának terhelését nem méri — lásd a sávszélesség szakaszt.
* Egyetlen futás nem trend. Két mérés között a build és az adatállomány is változik; a jelentés fejléce épp ezért írja ki mindkettőt.
