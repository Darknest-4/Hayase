# Karbantartási mód — tesztelés

**142 teszt** hét készletben, plusz **14 böngészős teszt**.

| készlet | db | mit őriz |
|---|---|---|
| `maintenance-core.test.ts` | 39 | állapotgép, hatókörök, ütemezés, döntés |
| `maintenance-http.test.ts` | 18 | valódi kérések, fejlécek, jegyek |
| `maintenance-video.test.ts` | 20 | felismerés és útvonal-kitörés |
| `maintenance-failure.test.ts` | 13 | adatbázis eltűnik, értesítés elveszik |
| `maintenance-client.test.mjs` | 29 | szolgáltatás, oldal, lejátszó |
| `internal-request.test.ts` | 9 | a belső mentesség nem hamisítható |
| `rate-limit-page.test.ts` | 14 | korlát, mentesség, HTML-oldal |
| `tests/e2e/maintenance.test.mjs` | 14 | böngésző, videó, 8 szélesség |

Futtatás:

```bash
node --experimental-strip-types --test apps/api/test/maintenance-*.test.ts   # szerver
node --test apps/web/test/maintenance-client.test.mjs                        # kliens
npm run test:e2e --workspace @yume/api                                       # böngésző
```

## Miért tiszta függvény a mag

`state.ts`, `schedule.ts` és `policy.ts` egyetlen sora sem nyúl adatbázishoz.
Ez az a rendszer, ahol egy elrontott feltétel azt jelenti, hogy **vagy
mindenki ki van zárva, vagy senki** — és az ilyet nem élesben kell
kipróbálni. A 39 magteszt ezredmásodpercek alatt végigjárja az állapotteret,
beleértve a határeseteket:

- az ablak **pontos kezdete** (benne) és **pontos vége** (kívül);
- óraátállítás éjszakája;
- nyitott ablak (kezdés nélkül, vég nélkül);
- ismeretlen mód és hatókör.

## A hibahelyzetek

A 8. és 32. pont. A kérdés nem az, hogy működik-e, amikor minden rendben:

| helyzet | a válasz |
|---|---|
| hidegindítás, még nem olvastunk | **nyitva** |
| adatbázis eltűnik, nincs ismert állapot | **nyitva** |
| adatbázis eltűnik, van ismert állapot | **azt tartjuk** — a vészhelyzet nem oldódik fel |
| értesítés elveszik | a lejárati idő behozza |
| 25 kérés egyszerre, lejárt gyorsítótár | **egy** lekérdezés megy ki |
| elrontott adatbázissor | biztonságos értékek, nem összeomlás |

A két nyitás és az egy tartás együtt determinisztikus: az állapot sosem
„ugrik" egy hiba miatt, legfeljebb megáll az időben.

## Amit böngésző talált meg, és egységteszt nem foghatott

**A beágyazott szkriptet a saját CSP-nk tiltotta.** Az „Újratöltés" gomb nem
csinált semmit, a visszaszámláló nem mozdult — csendben. A lap kinézett
rendben. Élesben is így volt, amióta a 429-es oldal kiment.

Azóta az oldal szkript nélkül működik, és **két teszt őrzi**, hogy ne
kerüljön vissza „csak ez az egy kis szkript".

## Két saját mérési hiba

- **az ES-modul exportja nem cserélhető ki.** A hibahelyzetek tesztelése
  `mock.method`-dal indult, és `Cannot redefine property`-vel elszállt. Ez nem
  a teszt hibája volt, hanem tervezési jelzés: a gyorsítótár betöltője azóta
  injektálható, egy helyen, kimondva;

- **a böngészős készlet első futása 200-at kapott 503 helyett.** A
  tesztböngésző a hurokcímről jön, és a rendszer azt a saját rendszerünknek
  tekinti. A készlet azóta továbbítófejlécet küld — így külső forgalmat mér,
  nem azt, hogy honnan indul a tesztfuttató. Enélkül zöld lett volna akkor is,
  ha a karbantartás egyáltalán nem működik.

## Amit a tesztek NEM bizonyítanak

Kimondva, mert egy hiányzó sor a listából hamis biztonság:

- **több példány.** A `LISTEN/NOTIFY` terjedését egy folyamaton belül mértük
  (1,24 ms medián). Két külön konténer között nem futott;
- **valódi adatbázis-újraindítás.** A hibahelyzeteket injektált hibával
  mértük, nem egy tényleges `docker restart postgres`-szel;
- **valódi mobil eszköz.** A nyolc szélesség fejetlen Chromiumban ment;
- **hosszú karbantartás.** A leghosszabb mérés percekben mérhető.
