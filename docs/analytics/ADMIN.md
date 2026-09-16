# A kimutatások a panelen

## Hol van

`Adminfelület → Betekintés → Látogatottság`

Jogosultság: `analytics.view`. A fiókszintű nézethez `analytics.accounts`, az
exporthoz `analytics.export` kell — mindhárom külön, mert három különböző
dologról szólnak.

## Az időtartomány

A fejlécben áll, és **minden fülre érvényes**: ma, tegnap, 7, 30, 90 nap, egy
év. Ez azért fontos, mert a leggyakoribb félreolvasás az, amikor a bal oldali
szám hét napra, a jobb oldali harmincra vonatkozik, és senki nem veszi észre.

## Öt fül

### Látogatók

A legfelső sáv élő: hányan vannak most itt, ebből hányan bejelentkezve, hány
oldalletöltés volt az elmúlt öt percben, és mennyi az API válaszideje.

A négy nagy szám mindegyike mellett ott áll az **előző, azonos hosszú
időszakhoz** mért változás. Egy „1 234 látogató" önmagában nem mond semmit; az
mond valamit, hogy ez több vagy kevesebb, mint egy héttel korábban. Ahol nincs
mihez mérni (friss telepítés), ott „nincs mihez mérni" áll, nem 0%.

> **Az egyedi látogató naponta értendő.** Ugyanaz az ember két napon két
> látogató, mert a látogatói kulcs naponta cserélődik — ez adatvédelmi
> döntés, lásd [PRIVACY.md](PRIVACY.md). Ezért a panel „napi átlag
> látogatót" ír, nem „összes egyedit": az utóbbi hamis lenne.

### Címek

Melyik anime megy jól: megtekintés, egyedi néző, epizódindítás, befejezés,
**befejezési arány** és összes nézett idő. A befejezési arány a két szám
hányadosa — befejezésekből önmagában nem számolható, ezért kellett az
indításokat is rögzíteni.

### Keresés

Két lista. Az első a leggyakoribb kifejezések. A második az, **amire nem volt
találat** — és ez a hasznosabb: minden sor egy hiányzó cím vagy egy rossz
írásmód, amire van kereslet.

### Eszközök

Eszközosztály, böngésző, operációs rendszer, honnan jönnek, hol lépnek be.
Kategóriák, nem ujjlenyomatok.

### Teljesítmény

A mérőszámok p50/p95/p99 szerint, és a leglassabb végpontok. Ugyanabból a
`performance_metrics` táblából, amit az API amúgy is ír.

## Egy fiók tevékenysége

`Felhasználók → (egy fiók megnyitása) → Tevékenység és eszközök`

A szakasz csak akkor jelenik meg, ha az adott fióknak van `analytics.accounts`
jogosultsága — enélkül egyszerűen nincs ott. Egy „nincs jogod" doboz nem
információ, csak hely.

Amit mutat: a fiók eseményei hivatkozási számmal (`LOGIN_000182`), az eszközei,
a munkamenetei, és mennyit nézett.

**IP nincs benne.** Az a Biztonság képernyőé, mert ott más a kérdés.

## Export

`analytics.export` jogosultsággal, CSV vagy JSON:

```
GET /v1/admin/analytics/export?dataset=daily&format=csv&range=30d
```

Négy adatállomány: `daily`, `breakdown`, `anime`, `searches`. Mind
**összesítő** — nyers eseménysor, fióktevékenység, biztonsági napló és IP nem
exportálható, jogosultsággal sem: egy export fájl elhagyja a rendszert, és
onnantól semmilyen jogosultság nem véd rajta.

A CSV pontosvesszővel tagol és BOM-mal kezdődik, mert az export legelső dolga
az, hogy valaki megnyitja Excelben.

**Minden export naplózódik** (`analytics.export` az auditban): ki, mit, mikor,
milyen tartományra, hány sort.

## Mikor lesz adat

* az **élő** nézet azonnal;
* a **napi összesítők** óránként frissülnek, és éjfél után egyszer
  véglegesítődnek a tegnapi napra.

Tehát egy frissen bekapcsolt mérés első óráján a „Címek" fül még üres lehet,
miközben a „Látogatók" fül élő sávja már mutat valamit. Ez nem hiba.

## Ami nincs

* **Nincs valós idejű címstatisztika.** A „legnézettebb most" az utolsó 24 óra
  nyers oldalletöltéseiből jön, a többi összesítőből.
* **Nincs napokon átívelő látogatókövetés.** Szándékosan — lásd
  [PRIVACY.md](PRIVACY.md).
* **Nincs pufferelési/minőségi statisztika a lejátszásról.** Ezen a példányon
  nulla videóforrás van; amíg nincs mit lejátszani, nincs mit mérni.
