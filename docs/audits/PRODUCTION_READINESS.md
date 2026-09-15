# Éles üzemre való készenlét — 2026-09-15

## Pontszámok

| terület | pont | miért |
|---|---:|---|
| Architektúra | **9**/10 | Tiszta rétegek, teszttel kikényszerítve. Egy ismétlés volt, az okozta az IDOR-t. |
| Biztonság | **9**/10 | Egy valódi IDOR, egy hiányzó védelmi réteg — mindkettő javítva, és a kiváltó okra szabály került. A sebességkorlátok futásidőben állíthatók. A kockázati motor hiányzik, de nincs mit kalibrálni rajta. |
| Adatbázis | **8**/10 | Erős séma, particionálás, kulcsos lapozás. A böngészés indexei hiányoztak; pótolva. |
| Backend | **9**/10 | Szigorú típusok, paraméteres lekérdezések, nulla TODO. |
| Frontend | **9**/10 | Keretrendszer nélkül, rétegteszttel, fordítási lépés nélkül. |
| UX/UI | **8**/10 | Kilenc szélesség, három motor, magyar felület végig. A lejátszás üres, mert nincs forrás. |
| Teljesítmény | **8**/10 | A mért szűk keresztmetszet megszűnt. Terheléses mérés nincs. |
| Tesztelés | **9**/10 | 1 046 eset, öntesztelő suite-ok, és szabályok arra, hogy egy védelem ne másolódjon szét. |
| DevOps | **8**/10 | Négy konténer, nem root, egészségjelzés, erőforráskorlát. A Redis portja latens hiba volt. |
| Megfigyelhetőség | **8**/10 | Kérésazonosító, strukturált napló, percenkénti mérőszámok, hibacsoportosítás. |
| Dokumentáció | **8**/10 | 63 718 sor, és nagyrészt igaz. A bővítményplatform maradványai elavultak. |
| SEO | **8**/10 | Címek, leírások, sitemap, strukturált adat; saját tesztfájllal. |
| Akadálymentesség | **8**/10 | Teljes audit futott (536 → 0), billentyűzet és fókusz rendben. |
| Megbízhatóság | **8**/10 | Ellenőrzött mentés, panelről kezelhető és visszaállítható — de csak egy gépen. Ez a legnagyobb vállalt kockázat. |

**Összesített: 8,5 / 10**

---

## Blokkolók (P0)

Nincs.

---

## Magas prioritás (P1)

Nincs.

*Mindhárom korábbi P1 lezárva: az IDOR, a böngészés indexei, és — tulajdonosi
döntéssel — az `OPS-01`.*

**`OPS-01` — a mentések nem hagyják el a gépet.** A tulajdonos döntése:
offsite másolat egyelőre nem kell. Ez **elfogadott kockázat**, nem megoldott
probléma, és a különbség számít: egy lemezhiba ezen a gépen egyszerre viszi az
adatbázist és mind a tizennyolc mentését. A mechanizmus a helyén marad
(`BACKUP_SYNC_CMD`), és a panel ki is írja a mentések fölé, hogy a másolatok
itt élnek — hogy a döntés látható maradjon, ne felejtődjön el.

Amit a döntés helyett kaptunk, az a kezelhetőség: a mentés ki- és
bekapcsolható, kézzel indítható, ellenőrizhető és visszaállítható a panelről,
`backup.manage` jogosultsággal. Eddig mindegyikhez SSH kellett.

---

## Közepes (P2)

*Mindhárom korábbi P2 lezárva: a dokumentáció ellentmondása javítva, a
WebSocket-réteg tesztet kapott, és a megismételt biztonsági ellenőrzésre
szabály került.*

1. A mentés offsite másolata — lásd a P1-et. A döntés megszületett (nem kell),
   így ez már nem nyitott kérdés, hanem vállalt kockázat. Ha egyszer mégis kell:
   a `BACKUP_SYNC_CMD` egyetlen sor a `.env`-ben, kód nem változik.

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
