# Teljesítmény-átvizsgálás — 2026-09-15

Mérés, nem tipp. Ahol nincs szám, ott nem mértem, és azt kiírom.

---

## Amit mértem és javítottam

**A főoldal adatbázis-ideje.** Lásd `DATABASE_AUDIT.md` → PERF-01.

```
előtte   6 × Seq Scan (32 462 sor) ≈ 185 ms adatbázisidő betöltésenként
utána    6 × Index Scan            ≈ 0,5 ms
```

---

## Kliens

| mérés | érték |
|---|---|
| kliens forrás | 18 672 sor, 49 ES-modul |
| CSS | 4 fájl, ~5 000 sor |
| fordítási lépés | **nincs** — a böngésző natív modulokat kap |
| külső JS-könyvtár | HLS.js a lejátszóhoz; más nincs |

Nincs csomagoló, nincs hidratálás, nincs keretrendszer. Ez a kliens legnagyobb
teljesítménybeli döntése, és jó döntés: nincs mit kettévágni, mert nincs
egyetlen nagy csomag.

**Amit nem mértem:** Lighthouse-futás, elrendezési elmozdulás (CLS), hosszú
feladatok. A reszponzív és a böngészőközi teszt fut (kilenc szélesség, három
motor), de az teljességet mér, nem sebességet.

---

## Szerver

A kérési idők a naplóban látszanak (`responseTime`), és a figyelő percenként
rögzíti a kiszolgáló mérőszámait. A forró utak — katalógus, keresés, könyvtár
— kulcsos lapozással mennek, nem OFFSET-tel.

**Amit nem mértem:** terheléses vizsgálatot nem futtattam. A mostani forgalom
(14 fiók) mellett ennek nem lenne információtartalma.

---

## Amit szándékosan nem optimalizáltam

* **A keresés elgépelés-tűrése.** Egy korábbi kör már kimérte és megoldotta:
  a trigram-keresés csak akkor fut, ha a pontos illeszkedés kevés sort ad
  (`search-performance.test.ts` őrzi).
* **Képek.** A borítók külső CDN-ről jönnek, `loading="lazy"`-vel.
* **Gyorsítótár.** A beállítások és a jogosultságok memóriában, 30 másodperces
  élettartammal, íráskor érvénytelenítve. Ennél többet nem indokol a forgalom.
