# Player 2.0 — áttérés

A régi és az új lejátszó **egyszerre él**. Ez nem átmeneti kényelmetlenség,
hanem a terv: egy visszafordíthatatlan csere azt jelentené, hogy az első
meglepetésnél nincs hova visszalépni.

## Hol a váltó

`apps/web/src/pages/watch.js`, a `mountPlayer` legelső sora:

```js
if (flagDeclared('feature.player2') && featureOn('player2')) {
  return this.mountPlayer2(box, media, episode, total, src)
}
```

Kikapcsolva a lap **pontosan úgy viselkedik, ahogy eddig** — a régi
`mountPlayer` fut végig, változatlanul.

## Miért két kérdés egy helyett

Mert a `featureOn` egy **nem létező** kapcsolóra **igazat** ad vissza. Egy új
gombnál ez helyes; egy teljes lejátszócserénél azt jelentené, hogy a hiányzó
sor mellett az új lejátszó indul el mindenkinél. Részletek a
[kapcsolóknál](PLAYER_2_FEATURE_FLAGS.md).

## A bevezetés lépései

### 1. Telepítés (a kapcsoló még ki van kapcsolva)

```bash
git pull
docker compose up -d --build app
docker compose exec app npm run migrate      # a 0058-as felveszi a kapcsolót
```

Ellenőrzés — a kapcsoló létezik és ki van kapcsolva:

```bash
curl -s https://yumee.duckdns.org/v1/config | grep -o '"feature.player2":[^}]*}'
```

Ezen a ponton **semmi nem változott** a nézők számára.

### 2. Csak az üzemeltetőnek

```sql
UPDATE feature_flags
   SET enabled = true, access = 'permission', required_permission = 'admin.settings.manage'
 WHERE key = 'feature.player2';
```

Nézz meg vele egy részt. Amit érdemes végigpróbálni:

- elindul-e a kép, és **eltűnik-e a betöltőképernyő** (ez az a hiba, amit a
  böngészős teszt talált — a logó ott maradt, a videó ment alatta);
- a tekerősáv fogása, elengedése, billentyűzetről a nyilak;
- teljes képernyő be és ki — **Escape-pel is**, nem csak a gombbal;
- telefonon: a vezérlők nem lógnak ki, a gombok eltalálhatók;
- részváltás: a haladás mentődik-e.

### 3. Mindenkinek

```sql
UPDATE feature_flags SET enabled = true, access = 'public', required_permission = NULL
 WHERE key = 'feature.player2';
```

### Visszakapcsolás

```sql
UPDATE feature_flags SET enabled = false WHERE key = 'feature.player2';
```

Azonnal hat: a kliens nem cache-eli a kapcsolót a lap élettartamán túl. **Nem
kell telepíteni, nem kell újraindítani semmit.**

## Mi változik a nézőnek

| | régi | új |
|---|---|---|
| betöltőképernyő | logó + színfutás | ugyanaz, **plusz a fázis szövege** |
| tekerés | húzás közben tekert | **elengedéskor**, előnézeti idővel |
| billentyűk | néhány | 16 parancs, súgóval |
| beviteli mezőben gépelés | a betű parancs is volt | **nem parancs** |
| érintés | koppintás | koppintás, dupla koppintás, csúsztatás, hosszú nyomás |
| felirat | `<track>`, ha VTT | `.srt` is, **átalakítva** |
| minőség | nincs választó | menü, **csak a tényleg elérhető** felbontásokkal |
| hibaüzenet | angol fejlesztői mondat | magyar, kóddal és **Újra gombbal** |
| közös nézés | logikai némítás, 250 ms | **számláló**, plusz elsodródás-kezelés |

## Mi NEM változik

- a forrásfeloldás **adatforrásai** ugyanazok (`registeredSources`, kézi URL);
- a haladásmentés ugyanoda ír (`WatchTime`, `LibrarySync`);
- a közös nézés **protokollja** változatlan — a szerver oldalán egy sor sem
  módosult;
- a régi lejátszó kódja **érintetlen**.

## Amit tudni kell, mielőtt bekapcsolod

Ezek nem hibák, hanem **nem bizonyított területek** — ma nincs mivel
kipróbálni őket:

- **felirat**: a `subtitle_tracks` tábla üres. A betöltő és az elemző kész és
  tesztelt, de éles adaton nem futott;
- **hangsáv**: az `audio_tracks` tábla üres;
- **intró/outró átugrás**: a `skip_segments` tábla üres;
- **HLS/DASH**: a katalógusban ma nincs ilyen forrás.

Amint az első ilyen sor bekerül, ezeket **meg kell nézni élesben** — a
tesztjeik az elvet igazolják, nem a működést.

## Mikor lehet a régit törölni

Nem most. Javaslat: miután az új lejátszó **egy hónapig** ment mindenkinek
hibabejelentés nélkül, és a fenti négy terület mindegyike kapott éles adatot.
Addig a `mountPlayer` régi ága a visszaút, és annak működnie kell.
