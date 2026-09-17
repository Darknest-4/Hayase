# Karbantartási mód — videó és lejátszó

## Nincs mit beállítani

Másolj egy videót az `apps/web/assets/videos` könyvtárba. A rendszer
megtalálja.

```
1. a kifejezetten karbantartásra szánt név nyer:
   maintenance · maintenance-loop · maintenance-background · karbantartas
2. ha nincs ilyen, a névsor elsője
3. ha nincs videó → az oldal ugyanúgy teljes
```

A videó **dísz, nem tartalom**. Egy friss telepítésen nincs is
`assets/videos`, és a karbantartási oldal attól még mindent elmond, amit kell.

Támogatott: `.mp4`, `.webm`, `.m3u8`.

## Két megjelenési mód

**Háttér** — némán, ismételve, vezérlők nélkül, a szöveg mögött elsötétítve.
A felolvasó elől elrejtve (`aria-hidden`), és a Tab sorrendjéből kivéve. Ez a
díszlet.

**Előtér** — a karbantartási kártyában, saját YUME vezérlőkkel. Ezt a néző
indítja.

**A kettő közül egy.** Két példány ugyanabból a fájlból kétszeres letöltés, és
a 18. pont kifejezetten tiltja.

## A lejátszó

Külön az anime-lejátszótól, és ez szándékos. Ide **nem kell**
forrásfelderítés, epizódrendszer, előzmény, közös nézés, forrásváltás — egy
fájl megy egy helyről. Ami **kell**, az a saját felület: egy csupasz
`<video controls>` idegen test lenne a lapon.

Amit tud: lejátszás/szünet, némítás, hangerő, tekerés, idő, teljes képernyő,
kép a képben (**csak ahol a böngésző tudja** — egy tétlen gomb rosszabb, mint
egy hiányzó), töltési és hibaállapot.

A videó hibája **nem viszi magával az oldalt**: a vezérlők eltűnnek, egy
mondat megmondja, hogy nem játszható le, és a mondanivaló marad.

## Automatikus indítás

**Nem kerüljük meg a böngésző szabályát.** A háttérvideó némán, `playsinline`
módon indul — ez az egyetlen alak, amit gesztus nélkül elindítanak. Ha mégsem
indul el, a poszter marad ott, és az oldal ugyanúgy teljes.

## Mozgásmentes mód

`prefers-reduced-motion: reduce` esetén a **háttérvideó egyáltalán nem
jelenik meg**. Nem halványabb, nem lassabb: nincs.

Egy hurokban futó mozgókép pont az, amitől valakinek rosszul lehet — és egy
karbantartási oldalon a néző amúgy is vár. Az előtérben maradhat, mert azt ő
indítja el.

Böngészőben mérve: `display: none`.

## Biztonság

A felismerő egy könyvtárat olvas, és a kiválasztott név egy URL-be kerül —
tehát pontosan az a felület, ahol egy `../../` végigmehetne a rendszeren.

```
isSafeName(name):
  ✗ tartalmaz / vagy \  vagy nullbájtot
  ✗ ponttal kezdődik (rejtett fájl)
  ✗ 255 karakternél hosszabb
  ✗ nem .mp4 / .webm / .m3u8
  ✗ a FELOLDOTT útvonala nem a videókönyvtárban van
```

Az utolsó a lényeg. A `../../secret.mp4` nem azért bukik el, mert kiszűrtük a
„..”-ot, hanem mert a feloldott útvonal máshol van. Egy mintaillesztés
megkerülhető; egy útvonal-összehasonlítás nem. Szimbolikus link, kódolt
karakter, platformfüggő elválasztó: mind ugyanezen a ponton akad fenn.

Az admin felületen megadott név **ugyanezen a kapun** megy át — az sem
megbízható bemenet. Egy nem létező név esetén `null` jön vissza: csendben
másik videót adni rosszabb, mint semmit, mert az admin azt hinné, az ő fájlja
megy.

20 teszt, köztük nullbájt, abszolút út, könyvtárnak álcázott név, hiányzó
könyvtár és ékezetes fájlnév.
