# 07 — Reszponzív viselkedés

## A görgetési architektúra — ezt előbb értsd meg

**A dokumentum sosem görög.**

```css
.app-shell { height: 100vh; height: 100dvh; overflow: clip; }
.page      { flex-grow: 1; overflow-y: auto; scroll-behavior: smooth; }
```

A görgető a `.page`. Két következménye van, és mindkettőn elcsúsztam már:

1. `window.scrollTo` semmit nem csinál és semmit nem mér. Egy teszt, ami ezt
   hívja, sikert jelent miközben nem nézett meg semmit.
2. A `scroll-behavior: smooth` miatt a `scrollTop` beállítása **animál** —
   néhány képkocka múlva visszaolvasva minden motor azt mondja, nem mozdult.

A `100dvh` a `100vh` után áll: a `dvh` a mobil címsáv mozgását követi, a `vh`
nem. A régebbi böngésző a `vh`-t kapja, az újabb felülírja.

## Breakpointok

Hat, mind `max-width`:

```
560px  ×7    telefon: a szűrőpanel becsukódik, a sűrű sorok egy oszlopba állnak
640px  ×3
720px  ×9    a fő váltás: az oldalsáv lebegő alsó sávvá alakul
820px  ×7    az admin rail fiókká; érintőméretek emelése
900px  ×2
1000px ×1    a kétoszlopos adatlap és a lejátszó egy oszlopba
```

1000px fölött nincs külön szabály: 1280, 1440, 1920 és 3440 ugyanazt kapja, a
`--content-max: 90rem` (1440px) korláttal. Ez tudatos — a tartalom nem lesz
jobb attól, ha szélesebb.

## Navigáció

**≥720px:** 3,5rem-es ikonsáv balra, tooltipekkel.

**<720px:** lebegő pill az alsó szélen, minden oldaltól `--space-3` behúzással,
`--radius-lg` lekerekítéssel, `--shadow-3` árnyékkal. Négy címkézett fül + egy
„Több" lap. Az aktív elem **kitöltött pill**, nem színváltás: sötét sávon a
puszta szín gyenge jel.

A pill tetején chevron, ami **elrejti a címkéket, de nem a célpontokat** — a
sor megtartja a magasságát, tehát ugyanoda célzó hüvelykujj ugyanoda talál. A
választás megjegyződik.

A kezdőképernyőn **nincs alsó sáv**: saját fejléce van, és kijelentkezve a pill
öt olyan helyre mutatna, ahová úgysem lehet eljutni.

## Biztonságos területek

```css
bottom: calc(var(--space-3) + env(safe-area-inset-bottom, 0px));
```

A lebegő pill és a mobil lapok is számolnak a gesztussávval.

## Célpontméretek

24px a padló mindenhol (WCAG 2.5.8), 44px a ≤820px-es sávban, ahol hüvelykujj
használja. Az egyetlen kivétel a `.footer-credits` három linkje: azok egy futó
mondat közben állnak, ahol a szabvány kivételt ad, és egy 44px-es doboz
széttörné a sort.

## Táblázatok telefonon

A `.table-stack` 720px alatt **kártyákra esik szét**: minden sor egy kártya,
minden cella a saját címkéjét a `data-label`-ből veszi. Egy táblázat, ami
megtartja az alakját telefonon, csak oldalra húzogatva olvasható.

## Mérési állapot

19 útvonal × 19 viewport (320×568-tól 3440×1440-ig) = 361 oldalnézet, plusz
19 útvonal × 3 viewport három motorban. **Nulla vízszintes túlcsordulás, nulla
nem görgethető oldal.**
