# Architektúra-átvizsgálás — 2026-09-15

## A rendszer alakja

```
                    ┌───────────────────────────────┐
böngésző ──────────▶│ app (Fastify)                 │
                    │  · statikus kliens            │
                    │  · REST /v1                   │
                    │  · GraphQL /graphql           │──┐
                    │  · WebSocket /ws              │  │
                    └───────────────────────────────┘  │
                                                       ▼
                    ┌───────────────────────────────┐ ┌──────────────┐
                    │ worker                        │◀│ PostgreSQL   │
                    │  · feladatsor (Postgres)      │ │  katalógus   │
                    │  · metaadat-passzok           │ │  sor         │
                    │  · figyelés percenként        │ │  kereső      │
                    │  · karbantartás óránként      │ │  napló       │
                    └───────────────────────────────┘ └──────────────┘
                                                       ▲
                    ┌───────────────────────────────┐  │
                    │ backup (cron)                 │──┘
                    │  éjszakánként + visszaállítás │
                    └───────────────────────────────┘
```

Négy konténer. Nincs üzenetsor, nincs keresőmotor, nincs gyorsítótár-szolgáltatás
— a sor, a kereső és a gyorsítótár is Postgres. Ez **szándékos**, és a
`docs/redis.md` leírja, mikor nem lesz elég: amikor egy második alkalmazás-példány
megjelenik.

Ez helyes döntés ezen a terhelésen, és nem nyúltam hozzá.

---

## ARCH-01 · A megismételt védelem

| | |
|---|---|
| **súlyosság** | **P2** (biztonsági következménnyel: lásd SEC-01) |
| **állapot** | **javítva** |

A „melyik profil nevében beszél ez a kérés" kérdésre **három** hely adott
választ, karakterre ugyanazzal a tizennégy sorral, egy negyedik pedig nem adott
semmit. A hiányzó negyedik lett az IDOR.

Ez az az ismétlés, ami nem stílushiba: egy védelem, ami négy helyen kell,
előbb-utóbb háromban lesz meg.

`middleware/profile.ts` most az egyetlen hely. A GraphQL kontextusa külön
maradt — ott nincs `request.user`, más a bemenet —, és ezt a fájl ki is mondja.

---

## A rétegződés, ami ki van kényszerítve

A kliens öt rétege — `shared → entities → features → pages → app` — nem
konvenció, hanem teszt: `layering.test.mjs` elbukik, ha egy alsó réteg fölfelé
nyúl, ha egy oldal másik oldalt importál, vagy ha egy fájl nem érhető el a
belépési pontból. Ötvenegy körkörös hivatkozás volt, mielőtt ez megszületett.

A szerver oldalán a modulhatárok konvención alapulnak (`modules/<terület>/`),
és tartják magukat: a SQL a repository fájlokban van, az útvonalak validálnak
és jogosultságot kérnek.

**Nem találtam** körkörös függőséget, isten-modult, vagy olyan üzleti logikát,
ami két helyen él. A legnagyobb fájl az `admin.js` (4 400 sor) — ez egy
huszonhat szekciós felület, és a szekciók függetlenek egymástól; szétvágni
fájlokra átrendezés lenne, nem javítás.

---

## Amit a réteg nem véd

A `resolveProfile` duplikáció megmutatta a mintát: **a szerveroldalon nincs
olyan teszt, ami a megismételt biztonsági ellenőrzést megtalálná.** A kliensnek
van rétegtesztje; a szervernek nincs „ez a fajta ellenőrzés csak egy helyen
létezhet" szabálya.

**Megoldva.** `apps/api/test/single-source-guards.test.ts`, négy szabály, mind
formára:

* az `x-profile-id` fejlécet egyetlen modul olvashatja;
* a „ez a beérkezett azonosító ezé a fióké?" lekérdezés egyetlen helyen él;
* tokent csak a hitelesítési modul ír alá;
* kérésből származó érték nem kerülhet sablonliterállal SQL-be.

Ellenőrizve, hogy fog is: a régi sort visszatéve a második szabály elbukik, és
megnevezi a pontos fájlt.

Az első változatom túl tágra sikerült — minden `FROM user_profiles … user_id`
alakot jelentett, és öt ártatlan helyet talált. Azok a fiók *saját* profilját
keresik ki; ott nincs beérkező azonosító, amit el lehetne hinni.

---

## Holt kód, nem használt függőség

* **Nem használt futásidejű függőség: nincs.** Mind a tizenkettő használatban.
* **Elérhetetlen kliensfájl: nincs.** A `layering.test.mjs` külön vizsgálja.
* **TODO/FIXME/XXX: nulla.**
* **`any` típus: három előfordulás**, mindegyik külső könyvtár határán.
* **`@ts-expect-error`: egy**, magyarázattal.
