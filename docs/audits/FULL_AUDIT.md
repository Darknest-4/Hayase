# Teljes átvizsgálás — 2026-09-15

Ez a dokumentum azt rögzíti, **mit néztem meg**, **mit találtam**, **mit
javítottam**, és **mi maradt**. A többi fájl ebben a mappában ugyanezt bontja
témákra.

Egy dolgot előre: ez a kódbázis nem elhanyagolt. 54 meglévő tesztfájl, szigorú
TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`),
tizenkét futásidejű függőség, nulla TODO/FIXME, éjszakánként visszaállítással
ellenőrzött mentés. Az átvizsgálás ennek megfelelően nem „mi van elrontva",
hanem „hol vékony a jég".

---

## Mit néztem meg

| terület | fájl | sor |
|---|---:|---:|
| `apps/api/src` | 84 | 19 481 |
| `apps/web/src` | 49 | 18 672 |
| `database/` (49 migráció) | 49 | 4 191 |
| `packages/` | 9 | 796 |
| `tests/`, `apps/*/test` | 60+ | ~5 000 |
| `docs/` | 89 | 63 718 |
| `.github/` | 5 | 404 |
| **követett fájl összesen** | **410** | **76 188** |

Konkrétan végigolvasva vagy lefuttatva: a belépési pontok (`app.ts`,
`workers/index.ts`, `index.ts`), a hitelesítés és a jogosultságkezelés, mind a
26 modul útvonaltáblája, a GraphQL- és WebSocket-réteg, a sorkezelő, a
migrációs futó, a mentés és a visszaállítás, a Dockerfile és a compose, a CI
munkafolyamatai, a kliens teljes `src/` fája, valamint a `docs/` minden
alkönyvtára.

**Amit nem néztem meg soronként:** a `docs/screenshots/` 57 képét (bináris), a
`node_modules`-t, és a `packages/design-tokens/` generált kimenetét (a
forrásából származik, amit igen).

---

## Mit találtam

Súlyosság szerint. A részletek a tematikus fájlokban.

### P0 — nincs

Nem találtam olyan hibát, ami éles kihasználható jogosultság-emelést,
adatvesztést vagy kódfuttatást enged.

### P1

| ID | terület | mi |
|---|---|---|
| **SEC-01** | IDOR | A hírek elvetése idegen profil nevében írt sort. **Javítva.** |
| **PERF-01** | adatbázis | A főoldal hat teljes tábla-olvasást indított betöltésenként. **Javítva.** |
| **OPS-01** | mentés | A mentések csak ezen a gépen élnek. **Nyitva — döntést igényel.** |

### P2

| ID | terület | mi |
|---|---|---|
| **SEC-02** | XSS | `innerHTML` nyelő a katalógusszövegen. Élesben a CSP fogta meg. **Javítva.** |
| **SEC-03** | konfiguráció | A Redis definíciója minden interfészre publikált volna. **Javítva.** |
| **SEC-04** | CSRF | A modell helyes, de nem volt teszt, ami tartsa. **Javítva.** |
| **ARCH-01** | ismétlés | A profil-feloldó három helyen létezett, egy negyediken hiányzott. **Javítva.** |

### P3

| ID | terület | mi |
|---|---|---|
| **DOC-01** | dokumentáció | A „mi van kész" leltár még késznek sorolta a bővítményboltot és a profilválasztót. **Javítva** — és a lelet súlyát lejjebb vettem, lásd alább. |

---

## Mit javítottam

Hét commit, mindegyik külön:

```
security: fix IDOR in the announcement dismissal, and put the check in one place
security: parse catalogue descriptions inertly, not with innerHTML
security: pin the CSRF model, and stop Redis publishing to the world
perf: index the three orderings the home page actually asks for
```

Új tesztek: `idor.test.ts` (7 eset), `csrf.test.ts` (4), `plain-desc.test.mjs`
(6), `tests/e2e/xss.test.mjs` (3 motor).

Mindegyik javításnál ellenőriztem, hogy a hozzá írt teszt **meg is fogja** a
hibát: a régi kódot visszatéve elbukik, az újjal átmegy. Ezt az IDOR-nál és az
XSS-nél is elvégeztem.

---

## Mi maradt

* **OPS-01** — a mentés nem megy el a gépről. Ez a példány tulajdonosának
  döntése (hová, milyen költséggel); a `BACKUP_SYNC_CMD` már létezik hozzá.
* ~~DOC-01~~ — javítva, és **túlbecsültem**: a dokumentáció maga jelzi a
  bővítményplatform törlését (`0031_remove_extension_platform`) és a saját
  elavultságát is. Egy valódi ellentmondás volt benne — a „mi van kész" leltár
  késznek sorolta a boltot és a profilválasztót —, az javítva.
* **Nulla videóforrás.** Nem hiba, hanem tény: a lejátszás minden útja le van
  zárva, amíg nincs forrás.
* **A jogosultság-katalógus 327 „tervezett" sora** angolul van. Nem létező
  modulokhoz tartoznak.

---

## Amit szándékosan **nem** csináltam

* Nem vezettem be Redist, üzenetsort, keresőmotort, konténer-vezérlőt. A
  meglévő architektúra — Postgres mint adatbázis, sor és kereső — elég erre a
  terhelésre, és a `docs/redis.md` már leírja, mikor nem lesz az.
* Nem írtam át működő rendszert stílus miatt.
* Nem tettem indexet oda, ahol nem mértem.
* Nem adtam hozzá funkciót.
