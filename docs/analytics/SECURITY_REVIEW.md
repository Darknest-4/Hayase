# A látogatottsági rendszer biztonsági átvizsgálása

Ez a dokumentum végigmegy a kért osztályokon, és mindegyiknél megmondja, hogy
**hol** van a védelem a kódban, vagy hogy **miért nem alkalmazható**. Ahol nincs
védelem, azt is kimondja.

## A központi gondolat

Egy látogatottsági rendszer támadási felülete szokatlan: a legnagyobb veszély
nem az adatlopás, hanem az, hogy **a számok hazudnak**. Egy kimutatás, amit
bárki felfújhat, rosszabb, mint amilyen nincs — mert döntést hoznak rá.

Ezért a fő szabály: **amit a kiszolgáló maga is tud, azt nem kérdezzük a
klienstől.**

## Osztályonként

### IDOR (idegen erőforrás elérése azonosító átírásával)

A `/v1/admin/analytics/accounts/:userId` bármely fiókot megmutatja — de ez
**adminisztratív** végpont, jogosultsághoz kötve (`analytics.accounts`), nem
felhasználói. Nincs olyan végpont ezen a felületen, ami a hívó saját
erőforrását adná vissza azonosító alapján, tehát nincs mit elrontani.

A `x-profile-id` fejlécet használó felületek a meglévő `requireProfile`
őrszemen mennek át (`middleware/profile.ts`), amit egy korábbi kör IDOR-ja
után írtunk, és amit `idor.test.ts` őriz.

### Hozzáférés-vezérlés

Minden olvasó végpont `fastify.requirePermission(...)` mögött van. Három
jogosultság, szándékosan külön:

| | |
|---|---|
| `analytics.view` | látogatottság, címek, keresés, teljesítmény |
| `analytics.accounts` | **egy fiók** tevékenysége — rejtett (404, nem 403) |
| `analytics.export` | adatkivitel — rejtett |

Teszt: `analytics.test.ts` → „the reports need the permission", „one account's
activity is hidden behind its own permission".

### Jogosultság-emelés

A modul nem ad és nem vesz el jogosultságot, nem ír a `users`, `roles` vagy
`role_permissions` táblákba. Egyetlen írása a felhasználók felé a
`account_events` sor, ami napló.

### SQL-injekció

Minden lekérdezés paraméteres. Két hely, ahol szöveg kerül a lekérdezés
közelébe, és mindkettő zárt halmaz:

* a `dimension` szűrő — **bind paraméterként** megy, nem összefűzve;
* az export `dataset` neve — egy rögzített `Record`-ból választ, és a séma
  `enum`-ja engedi csak a négy nevet.

A tartomány (`from`, `to`) `date` formátumú séma után `::date` castot kap.

### XSS

Az új felület minden szövege `U.el(..., { text })`-en megy, ami
`textContent`-et állít. `innerHTML` és `html:` nincs benne — ellenőrizve.
A tartalom amúgy is szám és belső kulcs, nem felhasználói szöveg; a két
kivétel (keresőkifejezés, hivatkozó gazdagép) is `text`-ként megy ki.

Az oldal CSP-je `script-src 'self'`, `unsafe-inline` nélkül — ez az, ami egy
korábbi körben ténylegesen megfogta az XSS-t.

### CSRF

Nem alkalmazható: az API kizárólag `Authorization: Bearer` fejlécet fogad,
sütivel hitelesített végpont nincs. Az egyetlen süti a `yume_refresh`
(httpOnly, Secure, SameSite=Strict), és csak a `/v1/auth` alatt él. A
`csrf.test.ts` ezt kiköti.

A `POST /v1/analytics/view` hitelesítés nélkül is hívható, tehát CSRF-fel sem
lehet vele többet elérni, mint közvetlenül.

### SSRF

A modul nem hív kifelé semmit.

### Naplóinjekció

A `route` a kiszolgálón normalizálódik (`normaliseRoute`), 200 karakterre
vágva, és **adatbázismezőbe** kerül, nem naplósorba. A fiókesemények
metaadatát a `sanitise()` szűri: a sztringek 500 karakterre vágva, a tömbök 20
elemre.

### Érzékeny adat szivárgása

* a látogatottsági táblákban **nincs IP** — a kulcs napi sóval hashelt;
* az `/accounts/:userId` válasz **nem tartalmaz IP-t** — teszt őrzi;
* a `sanitise()` kiveszi a jelszót, tokent, sütit, jegyet, API-kulcsot és
  `Authorization` fejlécet, akárhogy is került bele — teszt őrzi;
* a sikertelen belépés **nem tárolja a begépelt azonosítót** — teszt őrzi;
* az export csak összesítőket enged ki, nyers eseménysort és fióktevékenységet
  nem.

### A gyűjtő végpont visszaélésszerű használata

`POST /v1/analytics/view` nyilvános. Négy korlát:

1. **írási sebességkorlát** (`WRITE_LIMIT`), IP szerint;
2. **séma** — `additionalProperties: false`, minden mező hosszkorláttal;
3. **duplikátumszűrés** — ugyanaz a látogató + útvonal + entitás 10 mp-en
   belül egy letöltés;
4. **memóriakorlát** — a duplikátumszűrő emlékezete 20 000 kulcsnál ürül, hogy
   egy nyilvános végpontról ne lehessen korlátlanul növeszteni.

Amit egy támadó így elérhet: a saját címéről érkező oldalletöltések száma. Egy
munkamenet keletkezik rá. A számokat ezzel nem tudja jelentősen torzítani, és
a robotokat a rendszer külön jelöli (`is_bot`), a kimutatásból pedig kihagyja.

### Eseményhamisítás

A kliens **egy** dolgot mondhat: melyik oldalra lépett. Ki ő, mikor volt,
milyen eszközről, melyik munkamenet — mind a kiszolgálóé. Teszt: „a client
cannot declare who it is or when it was" (öt hamisítási kísérlet, mind 400).

A **nézési** események egyáltalán nem a klienstől jönnek: a haladásírásból
születnek, aminek van adatbázisbeli következménye (a felhasználó saját
haladása). Egy esemény, ami csak a statisztikát mozdítja, ingyen hamisítható;
ez nem.

### Visszajátszás és duplikált esemény

* oldalletöltés: 10 másodperces duplikátumablak;
* nézés: egy epizód egy menete **hat órán belül egy sor**, akárhányszor tölt be
  a lap;
* befejezés: csak egyszer jár XP-vel, és csak ha a pozíció hihető (≥ 60 mp
  vagy a hossz fele).

### Sebességkorlát megkerülése

Ez a munka **kinyitott** egy kaput: a terhelésmérő kivétel. Három feltételhez
kötött, és bármelyik hiánya megfogja:

1. `LOAD_TEST_KEY` beállítva (≥ 32 karakter; rövidebbtől az app el sem indul);
2. a kérés hozza a kulcsot (időfüggetlen összehasonlítás);
3. a forráscím a `LOAD_TEST_IPS` listán van (pontos címek, nem tartomány).

Alapállapotban **nem létezik**. Az éles `app` konténer környezetében a kulcs
nincs benne. Ha mégis be van állítva valahol, a Biztonság képernyő
figyelmeztet (`load-test-exemption` ellenőrzés), és az app indulásakor is
naplóz.

A mentesség **csak** a sebességkorlátot érinti: hitelesítést nem ad, és a
kulccsal sem lehet olyan helyre bemenni, ahova enélkül sem — külön teszt.

Teszt: `load-test-gate.test.ts`, 10 eset.

### Fiók-felderítés

A belépés válasza és ideje nem változott (a nem létező fiók továbbra is egy
csali-hash ellen fut, hogy az idő egyforma legyen). A sikertelen belépés
eseménye nem tárolja a begépelt azonosítót.

Egy maradék, kimondva: a `PASSWORD_RESET_REQUEST` esemény csak **létező**
fióknál keletkezik, tehát egy adatbázisírásnyi időkülönbség elvben mérhető. Ez
a különbség a változtatás előtt is megvolt (`supersedeResets` ugyanabban az
ágban ír), és a válasz mindkét esetben azonos. Nem tekintjük új
kitettségnek, de nem is hallgatjuk el.

## Amit ez az átvizsgálás NEM fed le

* Nem futott automatizált biztonsági szkenner az új végpontokon.
* A `security_logs` megőrzésére továbbra sincs automatikus határidő — lásd
  [DATA_RETENTION.md](DATA_RETENTION.md). Ez nyitott kérdés, nem megoldott.
* A terhelésmérő kivétel biztonsága a `LOAD_TEST_IPS` helyességén múlik. Ha
  valaki oda egy megosztott hálózat átjárócímét írja be, a kivétel mindenkire
  vonatkozik, aki mögötte van. A dokumentáció ezt kimondja; a kód ezt nem tudja
  megakadályozni.
