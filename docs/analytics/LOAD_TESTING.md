# Terhelésmérés

Ez a dokumentum arról szól, hogyan derül ki, hány embert bír el ez a telepítés
— és legalább annyira arról, hogy mit **nem** mond meg egy ilyen mérés.

A korábbi „mérés" lényegében ennyi volt:

```
GET /
```

Ez a statikus kliens kiszolgálását méri. Nem érinti a keresést, a katalógust,
a könyvtárat, az írásokat, a WebSocketet és az adatbázist — vagyis mindazt,
ami valójában elfogy. Egy ilyen szám nem alsó becslés, hanem egy másik
kérdésre adott válasz.

---

## 1. A négy szám, amit nem szabad összekeverni

A „hány felhasználót bír" kérdés legtöbb rossz válasza abból jön, hogy ezeket
felcserélik.

| fogalom | mit mér | mitől függ | mi fogy el tőle |
|---|---|---|---|
| **egyidejű felhasználó (VU)** | hányan vannak egyszerre az oldalon | a közönség mérete | memória, kapcsolatok |
| **kérés/mp (RPS)** | mennyit dolgozik a kiszolgáló | a felhasználók **viselkedése** | processzor, adatbázis |
| **sávszélesség** | mennyi adat megy a vezetéken | a válaszok mérete | hálózat |
| **egyidejű WebSocket** | hány élő kapcsolat van nyitva | mennyi ideig maradnak | memória, fájlleírók |

**1000 egyidejű felhasználó nem 1000 kérés/mp.** Egy ember kér egy oldalt,
aztán olvassa. Ebben a mérésben egy VU nagyjából **0,2 kérés/mp**-et küld —
tehát 1000 VU ≈ 200 kérés/mp. Ha a közönség türelmetlenebb, ugyanaz a
felhasználószám több kérést jelent: ez a viselkedés tulajdonsága, nem a
kiszolgálóé.

Ezért a jelentés mindig **mindkettőt** kiírja, és külön táblázatban mondja ki,
melyik melyik.

A videónézők száma egy ötödik szám, és erre a telepítésre **nem is a miénk**:
a források külső szolgáltatóknál vannak, az adatfolyam nem ezen a gépen megy
át. Lásd a 6. szakaszt.

---

## 2. Miért külön verem, és nem az éles ellen mérünk

Az éles példány ellen mérni három okból rossz:

* egy futás fiókokat regisztrál, haladást ír, kedvenceket rak be — ez az éles
  adatbázisban szemét, amit utána takarítani kell, és a takarítás az a lépés,
  ami egyszer elmarad;
* egy mérés attól mérés, hogy **megismételhető**. Ugyanarról az adatállományról
  indulva az, nem egy olyanról, amit az előző futás már megváltoztatott;
* a mérés alatt az éles oldal használhatatlan lenne, és azt épp azok vennék
  észre, akiknek a méréssel jót akarunk.

Ezért van a `docker-compose.load.yml`: ugyanaz a kép, ugyanazok az
erőforráskorlátok (768 MB app, 512 MB worker), saját adatbázis, saját kötet, a
`127.0.0.1:4100` címen.

Az adatállomány az éles **legfrissebb ellenőrzött mentése**. Nem üres
adatbázis: 32 463 cím, 364 064 epizód. Ez számít — a tervező sorrendje, az
indexválasztás és a gyorsítótár-találati arány mind a táblák méretétől függ, és
egy üres adatbázison mért késleltetés semmit nem mond arról, milyen lesz élesben.

Mellékhatásként ez a mentés-visszaállítás próbája is: ha a vetés nem megy,
akkor az éles mentés sem ér semmit, és jobb most megtudni.

> **Amit ki kell mondani:** a mérőverem ugyanazon a gépen fut, mint az éles. Egy
> nagy futás elveszi a processzort az éles elől is. A mért számok az
> alkalmazásra érvényesek, de a futás alatt az éles oldal lassabb. Ha ez nem
> vállalható, ugyanez a fájl külön gépen is felhúzható.

---

## 3. A sebességkorlát, és miért nem kapcsoljuk ki

A Yume IP alapján korlátoz. Egy terhelésmérés viszont definíció szerint
egyetlen címről érkező sok kérés — tehát korlát mellett **nem a terméket méri,
hanem a korlátot**. Ez a mérés leggyakoribb hamis eredménye: „500 VU-nál
összeesik", pedig 300 kérés/perc után minden válasz 429 volt.

A rossz megoldás az, hogy a mérés idejére feljebb tolják a korlátot
mindenkinek. Az egy éles biztonsági beállítás átírása egy mérés kedvéért, és
utána ott marad.

Ehelyett egy kimondottan erre engedélyezett forrás van
(`apps/api/src/middleware/load-test.ts`). **Három feltétel, és mindhárom kell:**

1. `LOAD_TEST_KEY` be van állítva, legalább 32 karakter. Enélkül a mentesség
   **nem létezik** — ez az alapállapot, és éles telepítésen ez marad. Rövid
   kulcsot az indulás visszautasít.
2. A kérés hozza a kulcsot az `x-yume-load-test` fejlécben. Az összehasonlítás
   időfüggetlen.
3. A kérés forrása szerepel a `LOAD_TEST_IPS` listán (alapból csak a hurokcím).
   Pontos címek, nem tartomány: egy biztonsági kivételnél a szűkebb a helyes
   alapértelmezés, és egy mérés forrása mindig ismert.

A kulcs önmagában tehát nem elég, és a cím önmagában sem.

A mentesség **csak a sebességkorlátot** érinti. A hitelesítés, a jogosultságok
és a csak olvasható mód ugyanúgy érvényes — erre külön teszt van
(`apps/api/test/load-test-gate.test.ts`).

Az éles `app` konténer környezetében a kulcs **nincs benne** (nézd meg:
`docker compose config app | grep LOAD_TEST` — üres). Csak a `load-app` kapja.

Ha mégis be van állítva valahol, a Biztonság képernyő kiírja: a
`load-test-exemption` ellenőrzés figyelmeztetésre vált, és megmondja, melyik
címek mentesülnek. Egy bekapcsolva felejtett kivétel csendben rossz — semmi nem
hibázik tőle, csak egy cím korlát nélkül jár.

A futtató minden mérés előtt ellenőrzi, hogy a kivétel **tényleg él**: a
korlátozó a mentesített kérésre nem ír `x-ratelimit-*` fejlécet, és a szkript
pontosan ezt nézi. Ha a fejléc ott van a kulccsal is, a mérés el sem indul.

---

## 4. A forgatókönyvek

### `tests/load/main.js` — a vegyes forgalom

Hét látogatótípus, valódi arányokkal. Átlagos felhasználó nem létezik: van,
aki két perc alatt tíz címet nyit meg és egyikbe sem néz bele, és van, aki egy
címet választ és negyven percig nem kér semmit.

| profil | arány | mit csinál |
|---|---:|---|
| névtelen látogató | 40 % | főoldal → böngészés → részletek → forrásfeloldás |
| bejelentkezett néző | 20 % | folytatás → részletek → könyvtárba tesz → néz (haladásírás) |
| sokat néző | 8 % | két epizód egymás után, kedvencbe tesz |
| keresgélő | 15 % | négy keresés javaslatokkal, fele megnyitva |
| vegyes | 12 % | nézelődik, keres, néz egy keveset, menetrend |
| csak olvasó | 5 % | saját oldalai, írás nélkül |
| WebSocket | külön | `tests/load/websocket.js` |

A folyamat végigmegy az igazi úton:

```
főoldal → keresés → találatok → részletek → epizódlista
       → forrásfeloldás → haladásírás → könyvtár → kedvencek
```

Két dolog, ami szándékosan van így:

* **gondolkodási idő.** Nélküle ugyanaz a VU-szám négyszer annyi kérést küld,
  és az eredmény a felhasználószámról mond valótlant. A `THINK` szorzóval
  állítható, de aki lecsökkenti, az nem „több felhasználót" mér, hanem
  türelmetlenebbet.
* **a haladásírás fél percenként megy, nem másodpercenként.** A lejátszó is
  így küld. Egy másodpercenkénti ping olyan írási terhelést mérne, ami a
  termékben nem létezik.

A részletoldal **hat** hívás (részletek, epizódok, kapcsolatok, szereplők,
ajánlások), mert a kliens tényleg ennyit küld. Aki ezt egy hívásnak méri, a
részletoldal terhelésének a hatodát méri.

### `tests/load/playback.js` — a lejátszás

Külön, és szándékosan **nem tölt le videót**. Lásd a 6. szakaszt.

### `tests/load/websocket.js` — a socketek

Külön, mert egy HTTP-kérés megszületik és meghal, egy socket **él**. A
HTTP-terhelést a kérés/mp írja le, a socketeket az egyidejű kapcsolatok száma,
és a kettő teljesen más erőforrást fogyaszt. Együtt mérve elfedik egymást.

Mér: a jegy megszerzését (ez sima HTTP, és adatbázisba ír), a kézfogást, a
ping–pong körbefordulást, és hány kapcsolatot dob el a kiszolgáló magától. A
kiszolgáló a felcsatlakozás **után** ellenőrzi a jegyet, tehát az `open` még
nem siker — a `hello` üzenet az.

---

## 5. Fokozatok, és mikor mondhatjuk ki a kapacitást

```
10 → 25 → 50 → 100 → 250 → 500 → 750 → 1000 VU
```

Minden fokozat **külön futás**. Egy hosszú, folyamatosan növekvő felfutásból
nem derül ki, melyik szinten fordult meg valami: a percentilisek a teljes
futásra mosódnak össze, és a 250 VU-s baj a 100 VU-s számokat is elrontja.

A küszöbök (`tests/load/lib/config.js`) döntenek, nem a szemünk:

| küszöb | érték | miért ez |
|---|---|---|
| `http_req_duration` p95 | < 1000 ms | 1 s fölött már látszik a várakozás |
| `http_req_duration` p99 | < 2500 ms | a leglassabb századrésznek is használhatónak kell lennie |
| hibaarány | < 1 % | e fölött a felhasználó is találkozik vele |
| 429 | **0** | egyetlen darab is azt jelenti, hogy a korlátot mérjük |
| 5xx | **0** | terhelés alatt sem hibázhat a kiszolgáló |
| keresés p95 | < 1200 ms | a legdrágább művelet, külön figyelve |

**A mért kapacitás a legmagasabb fokozat, ami küszöbsértés nélkül végigment.**
Ami e fölött van, azt meg kell mérni, nem megbecsülni. A jelentés ezért soha
nem ír olyan számot, amit nem mértünk — és ha minden fokozat megfelelt, azt
mondja ki, hogy a felső határ **nem ismert**, nem azt, hogy „legalább ennyi".

A futás megáll az első elbukott fokozatnál (`--keep-going` felülírja): az az
első fokozat a válasz, ami utána jön, az már csak azt méri, milyen egy
túlterhelt kiszolgáló.

---

## 6. A lejátszás mérése — alkalmazás ≠ sávszélesség

A leggyakoribb hiba ebben a mérésben az, hogy ezer VU elkezd letölteni egy
videót, és az eredmény a hálózat sávszélessége lesz, nem az alkalmazásé. Ez két
különböző szám, két különböző költséggel és két különböző megoldással:

| | mit jelent | mi a szűk keresztmetszet |
|---|---|---|
| **alkalmazás-kapacitás** | hány néző **indítását** bírja el a kiszolgáló: forrásfeloldás, epizódadat, feliratok, fejezetek, haladásírás | processzor, adatbázis |
| **videó-sávszélesség** | hány néző **adatfolyamát** bírja el a vezeték | hálózat |

A `playback.js` az elsőt méri. A másodikat innen nem lehet megmérni, és úgy
tenni, mintha lehetne, rosszabb, mint nem mérni.

> **Ezen a példányon jelenleg nulla videóforrás van.** A forrásfeloldás tehát
> üres listát ad: a *lekérdezés* költsége valódi és mérhető, a *szolgáltatói*
> válaszidő viszont nem létezik, mert nincs szolgáltató. A szkript ezt
> észreveszi és kiírja a jelentésbe, nem pótolja kitalált számmal. Amint lesz
> forrás, ezt a mérést meg kell ismételni.

---

## 7. Mit látunk a gépről a mérés alatt

A k6 megmondja, mit látott a **kliens**: késleltetést, hibaarányt, átbocsátást.
Arról egy szót sem mond, hogy **miért** lett lassabb. E nélkül a mérés csak
annyit tud: „100 VU-nál rossz lett". Amit tudni akarunk, az az, hogy **mi** lett
rossz.

A `scripts/load/sample.mjs` öt másodpercenként mintát vesz — nem új gyűjtő,
hanem ugyanaz, amit az alkalmazás monitor-workere percenként rögzít
(`infrastructure/observability/host-metrics.ts`), csak sűrűbben kérdezve: egy
hatperces futásnak hat pontból nincs alakja.

Mit rögzít:

* **gép:** processzor, terhelés/mag, memória, swap, lemez, hálózat be/ki
* **konténerenként:** CPU %, memória %, hálózat, folyamatszám (app, worker, postgres)
* **Postgres:** kapcsolatok / `max_connections`, aktív lekérdezések, zárolásra
  várók, a leghosszabb futó lekérdezés, tranzakció/mp, gyorsítótár-találati arány
* **feladatsor:** várakozó és halott feladatok — ugyanazzal a két definícióval,
  amit a monitor worker használ

A jelentés `Mi fogyott el először` szakasza ezekből a csúcsokból mondja meg, mi
volt a szűk keresztmetszet: processzor, memória, swap, adatbázis-kapcsolatok,
zárolás vagy a feladatsor. Ha egyik sem ért a küszöbéig, azt is kimondja —
olyankor az ok nem a gép telítettsége, hanem a kiszolgálás soros pontjai, és a
lépésenkénti táblázat mutatja, melyik hívás vitte az időt.

---

## 8. Hogyan futtasd

```bash
# 0. egyszeri: kulcs a mentességhez
echo "LOAD_TEST_KEY=$(openssl rand -base64 32)" >> .env

# 1. a verem
docker compose -f docker-compose.yml -f docker-compose.load.yml --profile load up -d --build

# 2. adatállomány az éles legfrissebb ellenőrzött mentéséből
scripts/load/seed-db.sh

# 3. fiókok és azonosítók a méréshez
POSTGRES_PASSWORD=... LOAD_TEST_KEY=... node scripts/load/seed-users.mjs --users 250

# 4. a mérés
scripts/load/run.sh                                  # mind a nyolc fokozat
scripts/load/run.sh --stages 50,100 --duration 5m    # csak kettő, hosszabban
scripts/load/run.sh --scenario websocket --stages 250,500
scripts/load/run.sh --scenario playback --stages 100

# 5. a verem leállítása (a kötet megmarad a következő méréshez)
docker compose -f docker-compose.yml -f docker-compose.load.yml --profile load down
```

A jelentés ide kerül: `docs/analytics/load-reports/<azonosító>/REPORT.md`,
mellette fokozatonként a k6 nyers összegzése (`stage-N.summary.json`) és az
erőforrás-minták (`stage-N.samples.ndjson`) — hogy a jelentés bármelyik száma
visszakereshető legyen.

### Amikor a mérésnek vége

```bash
# a kulcs kivétele: amíg benne van, a Biztonság képernyő figyelmeztet
sed -i '/^LOAD_TEST_KEY=/d' .env
docker compose -f docker-compose.yml -f docker-compose.load.yml --profile load down -v
```

---

## 9. Mit tartalmaz egy jelentés

Minden futás jelentése kiírja: a mérés azonosítóját, dátumát, a környezetet, a
buildet (git hash, és hogy volt-e nem commitolt változás), a gépet, a
fokozatokat, a VU-számot, a hosszt, a kérés/mp-et, a p50/p90/p95/p99/max
késleltetést, a hibaarányt, az állapotkódok eloszlását, a 429-ek és
időtúllépések számát, a processzort, a memóriát, az adatbázis terhelését, a
feladatsort, a hálózatot — és lépésenként is ugyanezt.

A záró következtetés kizárólag a mért adatokból készül. A jelentés végén külön
szakasz mondja el, mit **nem** mér — mert egy mérés határai nélkül a számok
messzebbre visznek, mint ameddig érnek.
