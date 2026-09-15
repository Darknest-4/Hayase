# Tesztelési átvizsgálás — 2026-09-15

## Amit találtam

| réteg | fájl | eset |
|---|---:|---:|
| API (integrációs, valódi adatbázissal) | 57 | 675 |
| kliens (egység, DOM-csonkkal) | 26 | 312 |
| végpontok közti (Playwright, 3 motor) | 4 | 26 |
| **összesen** | **87** | **1 013** |

Mind zöld. Lefuttattam, nem feltételeztem.

Ez a suite nem mennyiségi: több tesztfájl fejlécében ott áll, **melyik hiba
szülte**, és több közülük szándékos elrontással is ellenőrzi magát.

---

## Amit hozzátettem

| fájl | eset | mit köt ki |
|---|---:|---|
| `apps/api/test/idor.test.ts` | 7 | Egy fiók nem cselekedhet másik nevében. |
| `apps/api/test/csrf.test.ts` | 4 | Az API nem fogad el ambiens hitelesítő adatot. |
| `apps/web/test/plain-desc.test.mjs` | 6 | A leírásból szöveg lesz, nem jelölés. |
| `tests/e2e/xss.test.mjs` | 3 | A katalógusszöveg nem fut le — CSP nélkül sem. |

Mindegyiknél ellenőriztem, hogy **fogja is a hibát**: a régi kódot visszatéve
elbukik. Az XSS-tesztnél ez fontos volt — az első változatom a CSP-t mérte, és
a sebezhető kóddal is átment.

---

## Ami hiányzott, és most sem teljes

* **WebSocket.** Nincs tesztfájl rá. A réteg megvan (jegy, korlátok,
  újrahitelesítés), a viselkedése nincs kikötve. A közös nézés az egyetlen
  funkció, ami rajta él.
* **Terheléses és fuzz-vizsgálat.** Nincs, és nem is írtam.
* **Vizuális regresszió.** A reszponzív teszt túlcsordulást és
  érintőfelület-méretet mér, nem kinézetet.

---

## A tesztek egy tulajdonsága, ami ritka

Több suite **magát is ellenőrzi**: a `responsive.test.mjs` elbukik, ha nem
talál szabályokat; az `i18n.test.mjs` elbukik, ha üres a szótár; a
`css-order.test.mjs` elbukik, ha nem ismer fel médialekérdezést. Ez azért van
így, mert ebben a projektben már futott zölden olyan pipeline, ami semmit nem
ellenőrzött.

Ugyanez a szemlélet fogott meg ma **nyolc saját mérési hibát** — lásd
`docs/design/09-ux-audit.md` „álpozitívok" szakaszát, ami mostanra hatra nőtt,
és ehhez az átvizsgáláshoz még kettő jött: a `pg_stat` félreolvasott számlálója
és a CSP-t mérő XSS-teszt.
