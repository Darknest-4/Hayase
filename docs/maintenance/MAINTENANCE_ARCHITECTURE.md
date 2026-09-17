# Karbantartási mód — architektúra

**13 modul, 2 511 sor.** A rétegek úgy vannak elválasztva, hogy a nehéz
kérdések DOM és adatbázis nélkül eldönthetők legyenek.

```
                    PostgreSQL
                         │
              maintenance_configs (verziózva)
                         │
                    repository.ts          ← minden SQL itt, és sehol máshol
                         │
                     cache.ts              ← memória + lejárat + LISTEN/NOTIFY
                         │
   ┌─────────────────────┼─────────────────────┐
   │                     │                     │
state.ts            schedule.ts            policy.ts     ← tiszta függvények
(mi létezik)      (mikor érvényes)       (mi történjen)
   │                     │                     │
   └─────────────────────┼─────────────────────┘
                         │
                  middleware.ts            ← az EGYETLEN betartatási pont
                         │
                    minden kérés
```

## A mag: három tiszta modul

`state.ts`, `schedule.ts` és `policy.ts` **egyetlen sora sem nyúl
adatbázishoz, HTTP-hez vagy órához magától**. Kapnak adatot, adnak választ.

Ez nem elvi tisztaság. Ez az a rendszer, ahol egy elrontott feltétel azt
jelenti, hogy **vagy mindenki ki van zárva, vagy senki** — és az ilyet nem
élesben kell kipróbálni. A 39 magteszt ezredmásodpercek alatt végigjárja az
állapotteret.

### `state.ts` — mi létezik

Hat mód és tizenhárom hatókör. A hatókör-illesztés **előtaglista**, nem
reguláris kifejezés: egy mintakészlet, amit karbantartani kell, előbb-utóbb
félreillik; egy előtaglista elolvasható.

Ami nincs felsorolva, arra **csak a `global` hat**. Egy ismeretlen új végpont
maradjon elérhető, amíg valaki ki nem mondja, melyik területhez tartozik.

### `schedule.ts` — mikor érvényes

A beállított mód egy **szándék**; ez a modul mondja meg, hogy az a szándék
most érvényes-e. Az ablak előtt `SCHEDULED`, benne a beállított mód, utána
`OFF` — **magától, worker nélkül**.

Ez a legfontosabb tulajdonság az egész ütemezésben: egy leállt háttérfeladat
nem jelentheti azt, hogy az oldal karbantartásban ragad.

**A nyári időszámítást nem kezeljük — kizárjuk.** A `starts_at` és az
`ends_at` abszolút időpillanat (`timestamptz`), az `timezone` mező kizárólag
megjelenítésre való. Két pillanat összehasonlítását nem érdekli az
óraátállítás, és a „hajnali kettőkor, azon az éjszakán, amikor a hajnali kettő
kétszer van meg" kérdés fel sem merül.

### `policy.ts` — mi történjen

Egy tiszta függvény: `(beállítás, idő, kérés) → döntés`. A sorrend maga a
szabályzat:

| # | szabály | miért |
|---|---|---|
| 1 | ki van kapcsolva → mehet | |
| 2 | mindig nyitott útvonal → mehet | enélkül nem lehetne KIJÖNNI |
| 3 | a saját rendszerünk → mehet | a worker nem látogató |
| 4 | helyreállítási útvonal → mehet | az admin ne zárhassa ki magát |
| 5 | érvényes mentességi jegy → mehet | |
| 6 | személyzet → mehet, **kivéve vészhelyzetben** | annak oka lehet egy feltört fiók |
| 7 | nem erre a hatókörre szól → mehet | |
| 8 | kiürítési idő, meglévő munkamenet → mehet | |
| 9 | különben a mód dönt | |

## A gyorsítótár

**Kérésenként nulla adatbázis-lekérdezés.** A karbantartás ellenőrzése minden
HTTP-kérésen lefut; egy lekérdezés ott azt jelentené, hogy a karbantartási
rendszer maga a legnagyobb terhelés az adatbázison — pont akkor, amikor az
adatbázissal lehet a baj.

Három dolog tartja frissen, és mind a három kell:

1. **LISTEN/NOTIFY** — azonnali (mérve: 1,24 ms medián), de elveszhet;
2. **30 másodperces lejárat** — lassabb, de nem veszhet el;
3. **indulási beolvasás** — mert egy friss folyamat semmit nem tud.

Egyszerre csak **egy** beolvasás fut: ha huszonöt kérés egyszerre veszi észre,
hogy lejárt a gyorsítótár, akkor is egy lekérdezés megy ki.

### A LISTEN/NOTIFY nem kapott saját kapcsolatot

A `infrastructure/queue/wake.ts` már tartott egy újracsatlakozó hallgatót a
`yume_jobs` csatornára. A karbantartás egy **második csatornát** kapott
ugyanazon a kapcsolaton, nem egy második kapcsolatot — egy hosszan élő
kapcsolat nem ingyen van, és amiről elfelejtünk gondoskodni, az csendben
elnémul.

A feliratkozás maga elindítja a hallgatót, ha még nem áll: az API
folyamatban nem fut a feladatsor, és a gyorsítótárat pont ott kell
érvényteleníteni, ahol a kérések érkeznek.

## A betartatás egyetlen pontja

`middleware.ts`, egy `onRequest` hook. **A frontend soha nem biztonsági
határ**: a kliens megjelenítheti a karbantartási oldalt, de ami ténylegesen
megvéd, az ez.

A hook a sebességkorlát és a kockázati réteg **után** fut (azok olcsóbbak), a
hitelesítés **előtt** (a döntéshez elég a szerep, ha már megvan).

Adatbázishoz csak akkor nyúl, ha a kérésen **tényleg van** mentességi jegy — és
előtte még egy ingyenes HMAC-ellenőrzés kiszűri a szemetet.

Kivételt sosem dob: egy elhasalt karbantartás-ellenőrzés nem lehet kiesés.

## Amit szándékosan NEM építettünk meg

**`maintenance_events` tábla.** A 6. pont kéri, de az `audit_logs`
particionált, indexelt, `before`/`after`/`actor_id`/`ip` mezős — pontosan az,
amit az a pont felsorol —, és ma is ezt használja a biztonsági beállítások
minden módosítása. Egy második, majdnem ugyanolyan tábla párhuzamos rendszer
lenne, amit a 3. pont tilt.

**A régi csak-olvasható kapcsoló beolvasztása.** A `site_settings.read_only`
megmarad, változatlan viselkedéssel. Nem azért, mert nem lehetne beolvasztani,
hanem mert egy meglévő telepítés viselkedése nem változhat meg csendben: aki
ma be van kapcsolva, annak holnap is pontosan ugyanaz történjen. A kettő
együtt hat, és a szigorúbb nyer.

## Kliensoldal

```
features/maintenance/
  core/maintenance-service.js    ← a /v1/status figyelése
  ui/maintenance-page.js         ← a teljes oldal, visszaszámlálóval
  video/maintenance-player.js    ← a saját lejátszó
  admin/maintenance-dashboard.js ← az üzemeltetői felület
```

A kliens **megjelenít, nem véd**. Akinek üzemeltetői jogosultsága van, az
szalagot lát, nem teljes oldalt — egy adminnak, aki épp a karbantartást
kapcsolja ki, a legrosszabb dolog egy karbantartási oldal.
