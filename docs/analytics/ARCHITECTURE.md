# A látogatottsági rendszer felépítése

## Az egy mondat, amiből minden más következik

**A panel soha nem olvas nyers eseménytáblát.**

Egy „hány látogató volt 90 napja" kérdés nyersen több millió sor, és a panel
minden frissítésnél újra kifizetné. Napi összesítőből ugyanez 90 sor. Ez a
különbség dönti el, hogy a látogatottság mérése elfér-e ugyanazon a
Postgresen, vagy külön adatbázist kezd követelni.

Egyetlen kivétel van, és az szándékos: az élő nézet (`/realtime`) az utolsó öt
percet kérdezi nyersen. Ott a tábla kicsi, mert az ablak kicsi.

## Az út, amit egy esemény bejár

```
böngésző                    API                      worker              panel
   │                         │                         │                   │
   │  POST /v1/analytics/view│                         │                   │
   ├────────────────────────►│                         │                   │
   │        204 (azonnal)    │                         │                   │
   │◄────────────────────────┤                         │                   │
   │                    memóriapuffer                  │                   │
   │                         │ 5 mp vagy 500 esemény   │                   │
   │                         ├──► analytics_sessions   │                   │
   │                         └──► page_views           │                   │
   │                                                   │                   │
   │                                        óránként   │                   │
   │                                   analytics_daily ◄──┤                │
   │                               analytics_breakdown ◄──┤                │
   │                                anime_stats_daily ◄───┤                │
   │                              episode_stats_daily ◄───┘                │
   │                                                                       │
   │                                    GET /v1/admin/analytics/visitors   │
   │                                   (az összesítőkből) ─────────────────►
```

## Miért nem ír a kérés az adatbázisba

Egy látogatottsági rendszer legkönnyebb elrontása az, hogy minden
oldalletöltés egy adatbázis-írás a kérésben. Kétszáz kérés/mp-nél az kétszáz
plusz tranzakció másodpercenként, és a látogatottság MÉRÉSÉBŐL a lassulás OKA
lesz.

Ezért a `collector.ts` memóriában gyűjt, és kötegben ír ki: öt másodpercenként
vagy ötszáz eseményenként, amelyik előbb betelik. Egy összeomlásnál elveszik
pár másodpercnyi statisztika. Ez a helyes csere — egy kimutatás pontatlansága
nem baj, egy lassú oldal az.

## Mit mondhat a kliens, és mit nem

A kliens **pontosan egy dolgot** mond: melyik oldalra lépett. Minden más a
kiszolgálóé:

| adat | honnan |
|---|---|
| ki a látogató | napi sóval képzett hash a címből és a böngészőazonosítóból |
| melyik munkamenet | **számított**: ugyanaz a látogatókulcs, 30 percnél rövidebb szünetekkel |
| eszköz, böngésző, oprendszer | a `user-agent` fejlécből, hat kategóriába |
| mikor | a kiszolgáló órája |
| ország | csak ha egy fordított proxy megmondta; egyébként üres |

Aminek nincs helye a kliens törzsében, azt a séma utasítja vissza
(`additionalProperties: false`), nem a kezelő. Egy `visitorKey`, `sessionKey`,
`at` vagy `count` mező itt 400-at kap.

**Nézési események nem innen jönnek.** Az indítás, a haladás és a befejezés a
lejátszó haladásírásából születik (`PATCH /v1/me/progress/:id`), aminek van
adatbázisbeli következménye: a felhasználó SAJÁT haladását írja át. Egy
esemény, ami csak a statisztikát mozdítja, ingyen hamisítható; ez nem.

## Miért nincs süti

Nincs kliensoldali azonosító. A munkamenet számított: a napi látogatókulcs plus
a harmincperces időablak sorszáma. Három következménye van, és mind
szándékos:

* a kliens nem tudja megválasztani, melyik munkamenethez tartozik — se
  felfújni, se összemosni nem tudja őket;
* nem kell hozzá hozzájárulási sáv, mert nem tárolunk semmit a böngészőben;
* a napi só miatt a munkamenetek napokon át nem fűzhetők össze.

Az utolsónak ára van: a **visszatérő látogató** csak a bejelentkezetteknél
pontos. A kimutatás ezt ki is mondja a képernyőn, ahelyett hogy egy örök
azonosítóval pontosabbnak látszana annál, amit egy anime-katalógusnak tudnia
kell.

## A táblák

Ami **már megvolt**, és amit ezért nem írtunk újra:

| tábla | állapot a munka előtt |
|---|---|
| `page_views` | particionált, **üres** — a tábla megvolt, az író hiányzott |
| `search_stats` | particionált, 14 807 sor — ír és működik |
| `performance_metrics` | particionált, 19 282 sor — ír és működik |
| `security_logs` | 6 371 sor — ír és működik |
| `watch_history` | particionált, **üres**… a befejezésekre írt csak |
| `devices` | **üres** — az író hiányzott |
| `audit_logs` | particionált, 2 400 sor — ír és működik |

Ami **új** (0051):

| tábla | mire |
|---|---|
| `analytics_sessions` | egy látogatás (nem egy bejelentkezés) |
| `analytics_daily` | egy sor naponta — minden tartományos jelentés forrása |
| `analytics_breakdown` | eszköz/böngésző/oprendszer/nyelv/hivatkozó/belépő oldal naponta |
| `anime_stats_daily` | címenkénti napi teljesítmény |
| `episode_stats_daily` | epizódonkénti indítás/befejezés — a lemorzsolódáshoz |
| `account_events` | sorszámozott fióktevékenység (`LOGIN_000182`) |
| `analytics_salt` | a napi só; két napnál régebbi sorok törlődnek |

Új adatbázis **nincs**, és nem is kell: a Postgres particionálása, a részleges
indexek és a napi összesítők együtt bőven elviszik ezt a terhelést. Lásd
`docs/redis.md` arról, mikor lenne ez másképp.

## Idempotencia

Minden összesítő `INSERT ... ON CONFLICT DO UPDATE SET` a **frissen számolt**
értékre, nem hozzáadás. Ennek a következménye:

* egy félbeszakadt futás megismételhető;
* egy kétszer lefutott nap nem duplázza a számokat.

Ez az a hiba, amit összesítőknél a leggyakrabban elkövetnek, és utólag nem
lehet szétválogatni. Teszt őrzi (`analytics.test.ts`: „running the rollup twice
gives the same numbers, not double").

## Ami a kérés útjából ki van véve

| munka | hol fut |
|---|---|
| oldalletöltés rögzítése | memóriapuffer, 5 mp-enként kiírva |
| napi összesítés | `analytics` sor a feladatsorban, óránként |
| megőrzés / anonimizálás | ugyanaz a sor, naponta egyszer |
| fiókesemény írása | a kérésben, de hibája csak naplózódik — soha nem rontja el a műveletet |
