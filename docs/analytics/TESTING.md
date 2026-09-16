# A tesztek és az adatbázis

## A probléma, amiből ez indult

A tesztek az **éles** adatbázison futottak. Nem szándékosan: nincs külön
adatbázis, a `DATABASE_URL`-t kézzel állítja az ember, és a kézenfekvő érték az
éles. Mérve, mielőtt ez megváltozott:

| | |
|---|---:|
| fiókok az éles adatbázisban | 36 |
| ebből tesztmaradék | **31** |
| `example.invalid` webhook | 2 |
| nyitott hibacsoport tesztfutásból | 1 (50 esemény) |

A 31 fiók nem ártatlan: a felhasználószámot, a napi aktív grafikont és a
statisztikákat is ők vitték. A hibanapló 500-asai percre a tesztfutásokra
estek, a két webhook pedig „hostname does not resolve" hibacsoportot termelt.

## Ahogy most van

```bash
# 1. tesztadatbázis az éles legfrissebb ELLENŐRZÖTT mentéséből
scripts/database/test-db.sh

# 2. a tesztek oda mennek
export DATABASE_URL='postgres://yume:***@127.0.0.1:15432/yume_test'
npm test --workspace @yume/api
```

**Miért mentésből, és nem üres sémából:** a suite-ok fele valódi katalógusadatot
kér — nyilvános cím, epizód, jogosultságkatalógus. Üres adatbázison nem az
derülne ki, hogy jók-e, hanem hogy nincs mit mérniük. Mellékhatásként ez a
mentés-visszaállítás próbája is: ha a vetés nem megy, az éles mentés sem ér
semmit.

## A védőkorlát

Minden `test` és `test:*` parancs egy előellenőrzésen megy át
(`apps/api/test/guard.mjs`). Ha a `DATABASE_URL` nem `_test`-re végződő
adatbázisra mutat, a futás **el sem indul**:

```
[teszt] MEGÁLL: a DATABASE_URL a(z) "yume" adatbázisra mutat.
```

Egy figyelmeztetés, amit el lehet görgetni, pontosan annyit érne, mint a
korábbi állapot. Kikapcsolható, de csak kimondva:

```bash
YUME_ALLOW_PROD_TESTS=1 npm test
```

A korlátot magát is teszt őrzi (`no-prod-tests.test.ts`): minden tesztparancs
átmegy rajta, az előellenőrzés a futtatás **előtt** van (utána már beírt
harminc fiókot), és mindegyik elnyomja a kimenő webhookokat.

## A kapcsolatkészlet

A futtató fájlonként külön folyamatot indít, magonként egyet. Négy magon négy
folyamat, mindegyik húszas készlettel, plusz az éles app és a worker: **120
kapcsolat egy százas korlátra**.

A tünet nem „elfogytak a kapcsolatok" volt, hanem egy 500-as a keresésen,
tizenöt másodperc után — vagyis a kapcsolatfelvétel ötmásodperces határideje,
háromszor. Ezért indul minden tesztparancs `DB_POOL_MAX=5`-tel.

## Ami ezután is megosztott

A tesztadatbázis ugyanazon a Postgres-példányon él, mint az éles. Ez azt
jelenti, hogy egy nagy tesztfutás **processzort és kapcsolatot** még mindig
oszt az élessel — adatot viszont nem. A következő lépés, ha ez zavaróvá válik,
egy külön Postgres-konténer a teszteknek; a `DATABASE_URL` az egyetlen dolog,
amit át kellene állítani.

## Amit a tesztek egymásról tudnak

A suite-ok **párhuzamosan** futnak, közös adatbázison. Ez néhány helyen
látszik, és a tesztek ezt tudják magukról:

* a számlálásra épülő állítások („pontosan eggyel több") törékenyek — a
  `switched-off` és az `analytics` suite ezért a saját sorát keresi, nem
  számol;
* a `founder-library` suite a katalógus sorait számolja, és egy párhuzamos
  suite beszúrása megbuktatja. Egyedül futtatva megbízható; teljes futásban
  ritkán elhasal. Ez ismert, és nem a termék hibája.
