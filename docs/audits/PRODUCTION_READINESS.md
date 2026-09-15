# Éles üzemre való készenlét — 2026-09-15

## Pontszámok

| terület | pont | miért |
|---|---:|---|
| Architektúra | **9**/10 | Tiszta rétegek, teszttel kikényszerítve. Egy ismétlés volt, az okozta az IDOR-t. |
| Biztonság | **8**/10 | Egy valódi IDOR, egy hiányzó védelmi réteg — mindkettő javítva. A kockázati motor hiányzik, de nincs mit kalibrálni rajta. |
| Adatbázis | **8**/10 | Erős séma, particionálás, kulcsos lapozás. A böngészés indexei hiányoztak; pótolva. |
| Backend | **9**/10 | Szigorú típusok, paraméteres lekérdezések, nulla TODO. |
| Frontend | **9**/10 | Keretrendszer nélkül, rétegteszttel, fordítási lépés nélkül. |
| UX/UI | **8**/10 | Kilenc szélesség, három motor, magyar felület végig. A lejátszás üres, mert nincs forrás. |
| Teljesítmény | **8**/10 | A mért szűk keresztmetszet megszűnt. Terheléses mérés nincs. |
| Tesztelés | **9**/10 | 1 013 eset, öntesztelő suite-ok. WebSocket nincs lefedve. |
| DevOps | **8**/10 | Négy konténer, nem root, egészségjelzés, erőforráskorlát. A Redis portja latens hiba volt. |
| Megfigyelhetőség | **8**/10 | Kérésazonosító, strukturált napló, percenkénti mérőszámok, hibacsoportosítás. |
| Dokumentáció | **8**/10 | 63 718 sor, és nagyrészt igaz. A bővítményplatform maradványai elavultak. |
| SEO | **8**/10 | Címek, leírások, sitemap, strukturált adat; saját tesztfájllal. |
| Akadálymentesség | **8**/10 | Teljes audit futott (536 → 0), billentyűzet és fókusz rendben. |
| Megbízhatóság | **7**/10 | Ellenőrzött mentés, de csak egy gépen. Ez a legnagyobb nyitott kockázat. |

**Összesített: 8,2 / 10**

---

## Blokkolók (P0)

Nincs.

---

## Magas prioritás (P1)

1. **A mentések nem hagyják el a gépet.** (`OPS-01`) A mechanizmus kész
   (`BACKUP_SYNC_CMD`), a döntés a tulajdonosé: hová, milyen megőrzéssel.
   Ez ma az egyetlen olyan kockázat, ami adatvesztéshez vezethet.

*A másik két P1 — az IDOR és a böngészés indexei — javítva.*

---

## Közepes (P2)

1. A dokumentáció bővítményekre hivatkozó részei elavultak (a platform a
   0.6.0-ban kikerült).
2. A WebSocket-rétegnek nincs tesztje.
3. Nincs szabály, ami megakadályozná, hogy egy biztonsági ellenőrzés újra
   több helyre másolódjon.

---

## Alacsony (P3)

1. A jogosultság-katalógus 327 „tervezett" sora angol.
2. A kereső „legújabb" és „cím" rendezésének nincs indexe (nincs forró úton).

---

## Amit az éles üzem ma jelent

```
app        egészséges
worker     egészséges
postgres   egészséges · 10 napja fut
backup     14 mentés, mind visszaállítással ellenőrizve
oldal      200
```

Katalógus: 32 390 cím, 364 064 publikált epizód, 99 698 epizódcím, 7 019 logó,
9 644 háttérkép. Videóforrás: **nulla** — és minden út, ami lejátszóhoz
vezetne, le van zárva, amíg ez így van.
