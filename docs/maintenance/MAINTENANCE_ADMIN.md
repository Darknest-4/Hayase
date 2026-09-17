# Karbantartási mód — üzemeltetőknek

**Admin → Üzemeltetés → Karbantartás.** `security.manage` jogosultság kell
hozzá.

## A képernyő sorrendje

Aki ezt megnyitja, két helyzet egyikében van, és a sorrend ezt követi:

1. **Jelenlegi állapot** — mi megy, meddig, mi a gyorsítótár kora. Aki
   incidens közben néz ide, ezt akarja először.
2. **Beállítás** — a szerkesztő.
3. **Előnézet** — mi *történne*. Nem aktivál semmit.
4. **Mentességi jegyek** — kiadás és visszavonás.
5. **Változástörténet** — ki mit kapcsolt be, mikor.
6. **Karbantartási videó** — mi van az `assets/videos`-ban.

## A hat mód

| mód | mit csinál |
|---|---|
| **Kikapcsolva** | minden működik |
| **Ütemezve** | a látogatók visszaszámlálót látnak, de minden működik |
| **Teljes** | a hatókörbe eső kérések 503-at kapnak; az üzemeltetők bemehetnek |
| **Részleges** | csak a megadott terület áll le |
| **Csak olvasható** | böngészni lehet, módosítani nem |
| **Vészhelyzet** | azonnali teljes lezárás — **itt a sima admin szerep NEM enged be** |

A vészhelyzet mentése előtt a felület megerősítést kér, és megmondja, mivel
lehet kijönni.

## Egy tipikus karbantartás

### 1. Előbb nézd meg, mi történne

Állítsd be a módot és a hatókört, majd **Előnézet**. Nyolc jellemző hívóra
megmutatja, ki menne be és ki nem:

```
látogató, katalógus      kizárva
látogató, lejátszó       kizárva
admin, katalógus         bemehet    (személyzeti szerep)
admin, karbantartás      bemehet    (helyreállítási útvonal)
egészségjelző            bemehet    (mindig nyitott útvonal)
worker (belső)           bemehet    (a saját rendszerünkből érkezett)
```

Ha ez nem az, amit akarsz, itt derül ki — nem élesben.

### 2. Adj ki magadnak egy jegyet, ha vészhelyzetet tervezel

Vészhelyzetben a szerep nem elég. **Mentességi jegyek → Új jegy**, és másold
ki azonnal: a jegy csak akkor látható.

### 3. Kapcsold be

**Bekapcsolva** pipa + **Mentés**. A saját példány azonnal frissül, a többi
másodperceken belül (mérve: 1,24 ms medián), legrosszabb esetben 30
másodpercen belül.

### 4. Kapcsold ki

Mód = **Kikapcsolva**, vagy vedd ki a **Bekapcsolva** pipát. Ha megadtál
befejezést, **magától is véget ér** — worker nélkül is.

## Ütemezett karbantartás

Add meg a **Kezdést** és a **Befejezést**. A megadott időpontokat a böngésződ
helyi ideje szerint írod be; a rendszer abszolút pillanatként tárolja, tehát
az óraátállítás nem tud elrontani semmit.

Az ablak előtt a látogatók visszaszámlálót látnak, de **minden működik**. Az
ablak után magától vége.

## Kiürítés

„A bent lévők maradhatnak" + **kiürítési idő**. Ilyenkor:

```
karbantartás bekapcsol
        ↓
új munkamenet már nem jön be
        ↓
a bent lévők kapnak még N másodpercet
        ↓
teljes karbantartás
```

Hasznos telepítés vagy adatbázis-áttérés előtt. A türelmi idő a **karbantartás
kezdetétől** számol, nem a munkamenetétől — és a karbantartás UTÁN indult
munkamenet nem számít „meglévőnek", különben a kiürítés sosem érne véget.

## Karbantartási videó

Másolj be egy `maintenance.mp4`-et az `apps/web/assets/videos` könyvtárba.
Nincs mit beállítani: a rendszer megtalálja. Ha nincs videó, az oldal
ugyanúgy teljes.

A képernyő alján látod, mit talált, és melyiket tekinti karbantartásra
szántnak.

## Amit érdemes tudni

- **a mentés mindig új verzió**; a régiek megmaradnak, és a történetben
  látszanak;
- **minden módosítás auditálva van** (`audit_logs`, `subject_type =
  'maintenance'`);
- **a gyorsítótár kora** a képernyőn látszik — egy „miért nem lépett életbe"
  kérdésre ez az első válasz;
- **a jegy visszavonása azonnal hat.**
