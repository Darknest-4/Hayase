# Karbantartási mód — biztonság

## A frontend nem biztonsági határ

A kliens megjelenítheti a karbantartási oldalt, de ami ténylegesen megvéd, az
a szerveroldali hook. **Nincs olyan út**, amin a kliens állapotának
átírásával egy írás sikeressé válna: a döntés minden kérésnél újra megszületik
a szerveren.

## A mentességi jegy

**Két réteg, és mindkettő kell.**

| réteg | mit ad | mit nem |
|---|---|---|
| HMAC-aláírás | adatbázis nélkül kiszűri a szemetet | nem visszavonható |
| lenyomat a táblában | **visszavonhatóság** | drágább |

A sorrend számít: előbb az ingyenes aláírás-ellenőrzés, csak utána az
adatbázis. Egy találomra beírt jegy így nem terheli a lekérdezéseket.

Az összehasonlítás `timingSafeEqual` — az összehasonlítás ideje is
információ: egy naiv `===` elárulná, hány karakter egyezett.

**A jegy sehol nincs eltárolva nyersen**, és nem is kerül az auditnaplóba: az
auditnak az kell, hogy **ki** adott ki jegyet és **mire** — nem az, hogy mi
volt az.

**Örök jegy nem létezik**, és ezt az adatbázis is betartatja (24 óra a
plafon).

### Az egyetlen hely, ahol a hiba ZÁRÁS felé dönt

Ha a jegy ellenőrzése közben az adatbázis elérhetetlen, a jegy **nem
érvényes**. Máshol mindenhol nyitunk hiba esetén; itt nem, és szándékosan: a
visszavonhatóság csak akkor jelent bármit, ha a visszavonás állapotát meg
tudjuk nézni. Egy „nem érem el az adatbázist, tehát elfogadom" szabály mellett
egy kiszivárgott jegyet nem lehetne kizárni.

Az adminok így sem esnek kívül: a helyreállítási útvonalak jegy nélkül is
nyitva vannak.

## Az admin nem zárhatja ki magát

A 13. pont. Három dolog együtt garantálja:

1. **a helyreállítási útvonalak mindig nyitva**
   (`/v1/admin/maintenance`, `/v1/auth/login`, `/v1/auth/refresh`);
2. **a bejelentkezés vészhelyzetben is működik** — egy kijelentkezett admin
   különben sosem tudna visszajönni;
3. **a kikapcsolás ugyanazon a végponton megy**, ami mindig elérhető.

Teszt őrzi mind a négy módban, hogy a kikapcsolás elérhető marad.

## Vészhelyzetben a szerep önmagában kevés

`EMERGENCY` alatt a puszta admin szerep **nem** nyitja ki az egész oldalt. A
vészhelyzet oka lehet épp egy feltört admin fiók — ott a helyreállítási
útvonal és a jegy a két út.

Ez a legfontosabb különbség az `ACTIVE` és az `EMERGENCY` között, és a
felület figyelmeztet is rá mentés előtt.

## A saját rendszerünk

A worker, a bot és a háttérfeladatok karbantartás alatt is futnak — különben
pont azt a migrációt nem lehetne végigvinni, amiért a karbantartás van, és a
26. pont megfigyelése is elnémulna.

A felismerés a **TCP-kapcsolat túlsó végét** nézi, nem fejlécet, és a
proxyfejlécek **jelenléte kizárja** a mentességet:

```
belső  =  a kapcsolat túlsó vége hurok- vagy magáncím
       ÉS nincs rajta X-Forwarded-For / X-Real-IP / Forwarded / …
```

Kívülről nem hamisítható: egy külső kérés mindig a Caddyn át jön, az mindig
rátesz továbbítófejlécet, és az alkalmazás portja **nincs kipublikálva** a
gazdagépre.

**Aki más fordított proxyt tesz elé**, annak tudnia kell: ha az a proxy nem
állít továbbítófejlécet és hurok- vagy magáncímről ér az apphoz, akkor az
egész internet „belülről" érkezőnek látszana. Erre való a
`RATE_LIMIT_TRUST_INTERNAL=false`.

## Ami nem kerül a válaszba

Az 5. pont listája, betartva és tesztelve:

- adatbázis-információ;
- belső gépnév;
- hívásverem;
- titok;
- infrastruktúra-részlet;
- admin-információ.

A döntés `reason` mezője a **naplóba** megy, nem a válaszba — és arra is van
teszt, hogy ne tartalmazzon belső részletet.

## A státuszoldalon nincs szkript

Ezt böngésző találta meg, nem átolvasás:

```
Executing inline script violates the following Content Security Policy
directive 'script-src 'self''
```

A saját szabályzatunk tiltja a beágyazott szkriptet — helyesen. Az oldal
azóta hivatkozással és `meta refresh`-sel működik, tehát letiltott JavaScript
mellett is, bármilyen szabályzat alatt. Két teszt őrzi, hogy ne kerüljön
vissza „csak ez az egy kis szkript".

## A videófelismerő

Egy könyvtárat olvas, és a kiválasztott név egy URL-be kerül — tehát pontosan
az a felület, ahol egy `../../` végigmehetne a rendszeren. Három szabály:

1. **egyetlen könyvtárból** dolgozunk, és a **feloldott** útvonalnak bele kell
   esnie;
2. csak ismert kiterjesztések (`.mp4`, `.webm`, `.m3u8`);
3. a név maga is szűrt: se elválasztó, se rejtett fájl, se nullbájt, se 255
   karakternél hosszabb.

A `../../secret.mp4` nem azért bukik el, mert kiszűrtük a „..”-ot, hanem mert
a **feloldott útvonal nem a videókönyvtárban van**. Egy mintaillesztés
megkerülhető; egy útvonal-összehasonlítás nem.

Az admin felületen megadott név is **ugyanezen a kapun** megy át: az sem
megbízható bemenet.
