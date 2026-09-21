# Karbantartási mód — teljesítmény

Minden szám ezen a gépen mért. A 29. pont zárómondata: *„Ne csak azt írd, hogy
gyors. MÉRD."*

## A kérési út

| mit | átlag | p95 | p99 |
|---|---|---|---|
| gyorsítótár olvasása (kikapcsolt) | **62 ns** | 85 ns | 172 ns |
| teljes döntés (kikapcsolt) | **165 ns** | 234 ns | 414 ns |
| teljes döntés (`ACTIVE`) | 302 ns | 358 ns | 730 ns |
| teljes döntés (hatókörön kívül) | 398 ns | 548 ns | 751 ns |

A **második sor** a lényeg: ez fut a forgalom 99,9%-án. 165 nanoszekundum egy
olyan kérési úton, ahol a hálózat maga ezredmásodpercekben mér — a
karbantartás ellenőrzése gyakorlatilag ingyen van.

## Gyorsítótár

| mit | érték |
|---|---|
| találati arány | **100,00%** (100 000 hívás) |
| lejárati idő | 30 000 ms |
| `NOTIFY` terjedés, medián | **1,24 ms** |
| `NOTIFY` terjedés, legrosszabb | 13,39 ms |
| megérkezett | 20/20 |

A találati arány azért száz százalék, mert a gyakori út **szinkron**: ha a
gyorsítótár friss, egy mezőolvasás; ha lejárt, a frissítés a háttérben indul,
és a mostani kérés még a régi értékkel megy tovább.

Ez tudatos csere: egy karbantartás fél másodperces késése senkinek nem fáj,
egy adatbázis-lekérdezés a kérési úton viszont mindenkinek.

## Adatbázis-lekérdezés kérésenként

**Nulla** — ez a 7. pont követelménye, és betartva.

Egyetlen kivétel: ha a kérésen **tényleg van** mentességi jegy. Akkor egy
lekérdezés fut a visszavonás ellenőrzésére. Ezt is megelőzi egy ingyenes
HMAC-ellenőrzés, ami a szemetet adatbázis nélkül kiszűri.

## Amit a 30 másodperces lejárat jelent

A bekapcsoló példány **azonnal** tudja. A többi az értesítésből — mérve 1,24
ms. Ha az értesítés elveszik, legfeljebb 30 másodperc.

Ez a szám tudatos: elég rövid, hogy egy karbantartás bekapcsolása ne késsen
érezhetően, és elég hosszú, hogy a lekérdezés ne számítson terhelésnek
(2 lekérdezés/perc/példány).

## Mit nem mértünk

- **több példányt.** A terjedés egy folyamaton belül mért;
- **valódi terhelés alatt.** A mérés üresjáratban futott;
- **valódi adatbázis-kiesést**, csak injektált hibát.
