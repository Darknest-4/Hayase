# UX/UI átvizsgálás — 2026-09-15

Ez a terület **nem most kapott először átvizsgálást**. A `docs/design/`
tizenkét dokumentuma egy korábbi, tizenegy fázisú auditot rögzít (536
észrevétel → 0), és az ott született tesztek azóta is futnak. Ez a fájl azt
írja le, mi **ezen felül** derült ki.

---

## Ami már ki van kényszerítve

| teszt | mit mér |
|---|---|
| `tests/e2e/responsive.test.mjs` | Kilenc szélesség (360–1920), tizenkét útvonal: nincs vízszintes görgetés, nincs 22 pixelnél kisebb érintőfelület, egyik lap sem dob hibát. |
| `tests/e2e/cross-browser.test.mjs` | Chromium, WebKit, Firefox — köztük az, hogy az oldal **görög**, amit korábban egyetlen teszt sem állított. |
| `tests/e2e/hungarian.test.mjs` | Tizenhárom képernyő: nincs olyan angol szöveg, aminek van magyar fordítása. |
| `apps/web/test/css-order.test.mjs` | A reszponzív blokk a fájl végén van, és nem hivatkozik nem létező tokenre. |

---

## Amit ebben a körben találtam

### UX-01 · A kiadás fejléce szétesett hosszabb szövegnél

**P3 · javítva.** A `.release-titles` `auto` bázissal a leghosszabb sora szerint
kért helyet, tehát egy kétmondatos összefoglaló kitolta az állapotjelzőt a sor
végéről. `flex: 1 1 12rem` + `min-width: 0`.

Ez az a hibafajta, ami csak valódi tartalommal derül ki: a napló rövid
összefoglalókkal jól nézett ki.

### UX-02 · A lejátszó zsákutcái

**P1 · javítva** (külön körben). Hat út vezetett egy lejátszóoldalra, ami
azonnal visszadobott, mert nincs forrás. Mind lezárva, és a gombok is ezt
mondják.

---

## Amit megnéztem, és rendben volt

* **Fókusz és billentyűzet.** A modálisok csapdázzák a fókuszt, Escape zár, a
  fókusz visszakerül oda, ahonnan jött. Ugrólink a tartalomra.
* **Érintőfelületek.** 44 px a mobil vezérlőkön, ahol a WCAG 24-et kér.
* **Üres állapotok.** Mind megmondja a következő lépést, nem csak az ürességet.
* **Mozgás.** Egy időtartam, egy görbe; a „csak mert lehet" animáció ki van
  tiltva a dokumentált design-szabályokban.

---

## Amit nem vizsgáltam

* **Képernyőolvasóval végigolvasás.** A szemantika és az `aria-label`-ek
  ellenőrizve, de valódi felolvasóval nem teszteltem.
* **320 px.** A reszponzív teszt 360-nál kezd; ez alatt nem mértem.
* **Tájolás.** Fekvő módot nem vizsgáltam külön.
