# Adatbázis-átvizsgálás — 2026-09-15

PostgreSQL 16, 49 migráció, ~150 tábla. Minden állítás mögött `EXPLAIN
(ANALYZE)` áll, nem becslés.

---

## PERF-01 · A böngészés végigolvasta a katalógust harminc sorért

| | |
|---|---|
| **súlyosság** | **P1** |
| **hely** | `anime` tábla, `browse()` a `catalogue/anime-repository.ts`-ben |
| **állapot** | **javítva** — `0049_browse_sort_indexes.sql` |

A főoldal tíz sort kér egyszerre, ugyanannak a lekérdezésnek tíz változatát:
szűrés publikusra, rendezés egy oszlop szerint, `LIMIT 30`. Négy sor
népszerűség, öt felkapottság, egy pontszám szerint.

Mérve, index nélkül:

```
ORDER BY popularity      Parallel Seq Scan 30 756 sor + teljes rendezés
ORDER BY trending        Seq Scan 32 462 sor · 30,8 ms
ORDER BY average_score   Seq Scan 32 462 sor · 31,5 ms
```

A meglévő `anime_browse_idx (status, season_year DESC, popularity DESC)` ezt
nem tudja kiszolgálni: `status`-szal kezdődik, tehát csak akkor használható, ha
a kérés állapotra is szűr. A főoldal négy sora nem szűr.

Egy főoldal-betöltés így **hat teljes tábla-olvasás** volt.

Utána, mind a háromra: `Index Scan · 0,09 ms`. Ár: 3,9 MB index.

A `start_date` és a `canonical_title` szándékosan **nem** kapott indexet: a
keresőben választható rendezések, de a főoldal nem kéri őket, és egy index,
amit senki nem használ, írási költség fedezet nélkül.

---

## Amit a számlálók mondtak, és amit a tervek

A `pg_stat_user_tables` szerint a `system_metrics` volt a legdrágább tábla:
34 464 szekvenciális olvasás, átlag 80 593 sor — összesen 2,8 milliárd sor.

`EXPLAIN`-nel megnézve **mindkét** lekérdezése indexet használ:

```
DISTINCT ON (metric) … WHERE created_at > now() - '10 min'   Bitmap Index Scan · 0,3 ms
óránkénti összegzés  … WHERE created_at >= date_trunc(…)     Bitmap Index Scan · 1,0 ms
```

A számláló a tábla **teljes életére** összegez, beleértve azt az időszakot,
amikor száz sor volt benne, és a szekvenciális olvasás volt a helyes terv.

Nem lelet volt, hanem egy rosszul olvasott szám. Leírom, mert a következő
átvizsgálás ugyanezt a számot fogja látni.

---

## Amit megnéztem, és rendben volt

| terület | megállapítás |
|---|---|
| **Idegen kulcsok** | Minden kapcsolat deklarált, a törlési viselkedés kiírva. A `users` törlése szándékosan puha: a moderációs előzményt nem viszi magával. |
| **Particionálás** | Négy időalapú particionált tábla (`audit_logs`, `system_metrics`, `security_logs` naplói), a karbantartó feladat előre létrehozza a következő partíciót. A `partitions.test.ts` azt ellenőrzi, hogy egy frissen migrált adatbázis **ma** írható. |
| **Egyediség** | Fiókonként egy profil adatbázis-szinten kikényszerítve (0035). A `single-profile.test.ts` őrzi. |
| **Kulcsos lapozás** | A könyvtár és a katalógus is `(sort_value, id)` páron lapoz, nem OFFSET-tel. Egy oldal ugyanannyiba kerül az ötvenediknél is. |
| **Tranzakciók** | A kiadás és a sorai egy tranzakcióban; a vészkapcsoló és a naplóbejegyzése egyben; a metaadat-futás sorszintű állapottal. |
| **Versenyhelyzetek** | A feladatsor `FOR UPDATE SKIP LOCKED`-kal claimel. Az „egyszerre egy futás" részleges egyedi indexszel, nem ellenőrzés-majd-beszúrás mintával. |
| **Kódolás** | A telepítés `C` rendezéssel fut — a `db-encoding.ts` ezt indításkor jelenti, és a `hungarian-text.test.ts` rögzíti, mit jelent ez a magyar szövegre. Ismert, dokumentált, nem meglepetés. |
| **Mentés** | Éjszakánként, `pg_dump -Fc`, és **minden futás visszaállítja** egy ideiglenes adatbázisba, majd sorokat számol. Ellenőriztem a naplóban: „verified: 46 migrations, 363 permissions, 14 users". |

---

## OPS-01 · A mentések csak ezen a gépen élnek

| | |
|---|---|
| **súlyosság** | **P1** |
| **állapot** | **nyitva** — döntést igényel |

A mentés maga naplózza: *„BACKUP_SYNC_CMD is not set, so backups live only on
this machine."* Tizennégy mentés van a lemezen, mindegyik ellenőrizve — és
mindegyik ugyanazon a lemezen, mint az adatbázis.

Egy lemezhiba egyszerre viszi az adatbázist és a mentéseit.

A mechanizmus kész (`BACKUP_SYNC_CMD`), a döntés nem az enyém: hová, milyen
költséggel, milyen megőrzéssel. Ezt a példány tulajdonosának kell eldöntenie.
