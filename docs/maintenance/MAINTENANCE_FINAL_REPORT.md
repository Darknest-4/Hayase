# Karbantartási mód — záró jelentés

> A 39. pont szerinti bontásban. A számok mérésből és a kódból származnak.

## Összefoglaló

**32 új fájl, 11 módosított, 6 000 sor, 5 commit.** A karbantartási alrendszer
él a production példányon, **kikapcsolt állapotban**.

Mellette a három sürgős kérés is kész és élesben: a sebességkorlát 300→1200,
a saját rendszerünk mentessége, és a HTML-oldal JSON helyett.

## Létrehozott fájlok

**Szerver — `apps/api/src/modules/maintenance/`** (8 fájl)

| fájl | mit csinál |
|---|---|
| `state.ts` | hat mód, tizenhárom hatókör, útvonal-illesztés |
| `schedule.ts` | időbélyegből állapot, időzóna, `Retry-After` |
| `policy.ts` | **a központi döntés** — tiszta függvény |
| `cache.ts` | memória, lejárat, `LISTEN/NOTIFY`, utolsó-jó-állapot |
| `repository.ts` | **minden SQL**, és sehol máshol |
| `bypass.ts` | aláírás, lenyomat, visszavonás |
| `middleware.ts` | az egyetlen betartatási pont |
| `routes.ts` | `/v1/status` és `/v1/admin/maintenance` |
| `video-resolver.ts` | felismerés és útvonal-védelem |

**Szerver — egyéb**

- `infrastructure/http/status-page.ts` — közös HTML-oldal (429 és 503)
- `middleware/internal-request.ts` — „belülről jött-e"

**Kliens — `apps/web/src/features/maintenance/`** (4 fájl)

- `core/maintenance-service.js`, `ui/maintenance-page.js`,
  `video/maintenance-player.js`, `admin/maintenance-dashboard.js`

**Stílus**: `apps/web/css/maintenance.css`

**Tesztek** (7 fájl): `maintenance-core`, `maintenance-http`,
`maintenance-video`, `maintenance-failure`, `internal-request`,
`rate-limit-page`, `maintenance-client`, `tests/e2e/maintenance`

**Dokumentáció** (11 lap) — lásd alább.

## Módosított fájlok

| fájl | miért |
|---|---|
| `apps/api/src/app.ts` | a hook bekötése, HTML-hibaoldal, útvonalak |
| `apps/api/src/middleware/security.ts` | belső mentesség, indulási üzenet |
| `apps/api/src/modules/settings/site-settings.ts` | korlátok emelése, ellenőrző env-olvasó |
| `apps/api/src/infrastructure/queue/wake.ts` | több csatorna egy kapcsolaton |
| `apps/web/src/app/router.js` | karbantartási kapu és szalag |
| `apps/web/src/pages/admin.js` | új szakasz; a Kódaudit átsorolása |
| `apps/web/src/shared/api/yume.js` | API-metódusok |
| `apps/web/index.html`, `css-order.test.mjs` | stíluslap regisztrálása |
| `docker-compose.override.yml`, `.env.example` | a korlát alapértéke |
| 3 meglévő teszt | külső forgalom modellezése |

## Adatbázis

**`0059_maintenance.sql`** — két tábla, visszafelé kompatibilis, `IF NOT
EXISTS`. Semmit nem töröl, semmit nem ír át.

- `maintenance_configs` — verziózva; minden módosítás új sor
- `maintenance_bypass_tokens` — csak a lenyomat, 24 órás plafonnal

**`maintenance_events` NEM készült el.** Az `audit_logs` particionált,
indexelt, `before`/`after`/`actor_id`/`ip` mezős — pontosan az, amit a 6. pont
felsorol. Egy második tábla párhuzamos rendszer lett volna, amit a 3. pont
tilt.

## Állapotok

`OFF` · `SCHEDULED` · `ACTIVE` · `DEGRADED` · `READ_ONLY` · `EMERGENCY`

A beállított mód **szándék**; az érvényes mód az ablakból következik. Az ablak
előtt `SCHEDULED`, utána `OFF` — **magától, worker nélkül**.

A `EMERGENCY` nem ütemezhető és nem jár le: egy magától feloldódó vészlezárás
pont az a meglepetés, amit nem akarunk.

## Hatókörök

Tizenhárom: `global`, `web`, `api`, `authentication`, `registration`,
`player`, `catalog`, `search`, `watch-history`, `watch-party`, `comments`,
`profiles`, `admin`.

Előtaglista, teljes szegmensre illesztve. Ami nincs felsorolva, arra **csak a
`global` hat** — egy ismeretlen új végpont maradjon elérhető.

## Mentesség

Kétrétegű: **HMAC-aláírás** (adatbázis nélkül kiszűri a szemetet) +
**lenyomat a táblában** (ez adja a visszavonhatóságot). A jegy sehol nincs
eltárolva nyersen, és sosem kerül az URL-be.

Öt út vezet be: belső rendszer, helyreállítási útvonal, jegy, személyzeti
szerep (vészhelyzetben **nem**), kiürítési idő.

## Gyorsítótár

Kérésenként **nulla** adatbázis-lekérdezés. Három dolog tartja frissen:
`NOTIFY` (1,24 ms medián), 30 mp-es lejárat, indulási beolvasás. Egyszerre
csak egy beolvasás fut.

**Adatbázis-hiba esetén**: ismert állapottal azt tartjuk (a vészhelyzet nem
oldódik fel); ismert állapot nélkül nyitva maradunk.

## LISTEN/NOTIFY

A meglévő hallgatót általánosítottam **több csatornára egy kapcsolaton** — nem
nyitottam másodikat. A feliratkozás maga elindítja a hallgatót, ha még nem áll
(az API folyamatban nem fut a feladatsor). Újracsatlakozás után minden
regisztrált csatornára újra kimegy a `LISTEN`.

Elveszett értesítés esetén a lejárati idő helyreállít.

## Videó

Automatikus felismerés az `assets/videos`-ból, beállítás nélkül. Útvonal-védelem
**feloldott útvonal összehasonlításával**, nem mintaillesztéssel. Hiányzó
videó vagy könyvtár nem hiba.

## Lejátszó

Külön az anime-lejátszótól: nincs forrásfelderítés, epizódrendszer, előzmény,
közös nézés. Saját YUME felület, két módban (néma háttér / vezérelt előtér).
Mozgásmentes módban a háttérvideó **nincs ott**.

## Biztonsági változások

- a frontend nem biztonsági határ — a betartatás egy szerveroldali hook;
- a belső mentesség a TCP-kapcsolat túlsó végén alapul, **nem hamisítható**;
- az admin nem zárhatja ki magát (három egymástól független garancia);
- vészhelyzetben a puszta admin szerep nem elég;
- a válasz nem tartalmaz belső részletet (tesztelve);
- **a státuszoldalon nincs szkript** — a saját CSP-nk tiltotta, és ezt böngésző
  találta meg.

## Tesztek

**142 egységteszt** hét készletben + **14 böngészős teszt**.

| készlet | db |
|---|---|
| mag (állapot, ütemezés, döntés) | 39 |
| HTTP | 18 |
| videó | 20 |
| hibahelyzetek | 13 |
| kliens | 29 |
| belső kérés | 9 |
| sebességkorlát és oldal | 14 |
| böngésző (8 szélesség) | 14 |

Teljes futás: **994 szerveroldali**, **599 webes** teszt.

## Teljesítmény

| mit | érték |
|---|---|
| gyorsítótár olvasása | **62 ns** (p99 172 ns) |
| teljes döntés, kikapcsolt | **165 ns** (p99 414 ns) |
| teljes döntés, `ACTIVE` | 302 ns (p99 730 ns) |
| gyorsítótár-találat | **100,00%** (100 000 hívás) |
| `NOTIFY` terjedés | medián **1,24 ms**, legrosszabb 13,39 ms |
| adatbázis-lekérdezés kérésenként | **0** |

## Hibahelyzetek — mért eredmények

| helyzet | eredmény |
|---|---|
| hidegindítás | nyitva |
| adatbázis eltűnik, nincs ismert állapot | nyitva |
| adatbázis eltűnik, van ismert állapot | **megtartva** — a vészhelyzet nem oldódik fel |
| értesítés elveszik | a lejárat behozza |
| 25 egyidejű kérés hideg gyorsítótáron | **1** lekérdezés |
| elrontott adatbázissor | biztonságos értékek |
| alkalmazás újraindul | indulási beolvasás, majd figyelés |

## Dokumentáció

11 lap a `docs/maintenance/` alatt: audit, architektúra, beállítás, admin,
API, videó, biztonság, tesztelés, teljesítmény, forgatókönyvek, hibakeresés.

## A tizenegy ellenőrző kérdés

| kérdés | válasz |
|---|---|
| Működik, ha az adatbázis eltűnik? | **Igen** — az utolsó ismert jó állapot marad; ismert állapot nélkül nyitva |
| Működik újraindítás után? | **Igen** — indulási beolvasás, majd `LISTEN` |
| Helyreáll elveszett `NOTIFY` után? | **Igen** — 30 mp-es lejárat |
| Az adminok bejutnak? | **Igen** — helyreállítási útvonalak, mind a négy módban tesztelve |
| Megkerülhető illetéktelenül? | **Nem** — a belső mentesség a socket-címen alapul; a jegy aláírt és visszavonható |
| Működik az `assets/videos` felismerés? | **Igen** — 20 teszt, böngészőben is ellenőrizve |
| Működik a saját lejátszó? | **Igen** — egységtesztekkel; élő gesztusos használat nem mérve |
| Működik mobilon? | **Igen** — 320–1920 képpont, nyolc szélesség, semmi nem lóg ki |
| Működik a mozgásmentes mód? | **Igen** — böngészőben mérve: `display: none` |
| A 503-at helyesen adja vissza az API? | **Igen** — kód, fejlécek, JSON-alak és HTML-oldal tesztelve |
| Az ütemezés be- és kikapcsol? | **Igen** — magától, worker nélkül |

## Ismert korlátok

Kimondva, mert egy hiányzó sor hamis biztonság:

- **egy példányon mérve.** A `NOTIFY` terjedése egy folyamaton belül mért; két
  külön konténer között nem futott;
- **injektált adatbázis-hiba**, nem valódi `docker restart postgres`;
- **a `bypass_policy` mező ott van, de üres.** A szabályzat ma kódban van; a
  mező a bővíthetőségért létezik;
- **a `web` hatókör a szerveroldalon semmit nem fog meg** — az a kliens
  felületéről szól, és a szerver végpontokat zár, nem képernyőket;
- **a karbantartási lejátszó gesztusos használata** valódi eszközön nem
  próbálva;
- **az `m3u8` felismerve, de nem lejátszva**: a karbantartás-lejátszó natív
  HLS-t vár, és nincs ilyen próbaanyag;
- **a `founder-library` teszt párhuzamos futásnál ingadozik.** Egyedül 3/3
  zöld; a munkámtól független, előtte is így volt.

## Visszaállítás

**A karbantartás kikapcsolása** (nem igényel telepítést):

```sql
INSERT INTO maintenance_configs (mode, scope, enabled, title, public_message)
VALUES ('OFF', 'global', false, 'Karbantartás', '');
SELECT pg_notify('yume_maintenance_changed', 'manual');
```

**Az egész alrendszer visszavonása**: `git revert` az öt commitra. A táblák
maradhatnak — üresen semmit nem csinálnak, és a `0059` `IF NOT EXISTS`-szel
újra alkalmazható.

**A sebességkorlát visszaállítása** a régire:

```
RATE_LIMIT_MAX=300  a .env-ben, majd docker compose up -d app
```

**A belső mentesség kikapcsolása**:

```
RATE_LIMIT_TRUST_INTERNAL=false
```

Az alrendszer **kikapcsolva ment ki**: a bekapcsolásához egy tudatos
adminművelet kell.
