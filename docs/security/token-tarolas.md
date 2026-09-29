# Döntés: hol él a bejelentkezés a böngészőben

**Állapot:** elfogadva — 2026-09-28 · **Érinti:** `apps/web/src/shared/api/yume.js`,
`apps/api/src/modules/auth/routes.ts`, `apps/api/src/middleware/auth.ts`

## Röviden

* A **hozzáférési token** marad a `localStorage`-ban (`yume-auth`), rövid élettartammal és
  munkamenethez kötve.
* A **frissítő token** marad `HttpOnly` sütiben (`yume_refresh`). Minden használatkor forog, és a
  kiszolgáló figyeli, ha egy már lecserélt tokent újra felmutatnak.
* Új: a frissítés **a fülek között is egyszerre egy**, a böngésző zárja (Web Locks) alatt fut.
  Egy elbukott frissítés csak a saját régi tokenjét törli. Erre azért volt szükség, mert a
  felülvizsgálat közben mért hiba több fülnél kijelentkeztette a felhasználót.

Az alábbi állítások mind a kódból vagy mérésből származnak. A hivatkozások a 2026-09-28-i
munkafára mutatnak.

## Mi van most

| | Hol | Élettartam | Kódbeli hely |
|---|---|---|---|
| Hozzáférési token (JWT, `sub`, `username`, `sid`) | `localStorage['yume-auth']`, csak `accessToken` + `expiresAt` | 15 perc | `apps/api/src/config.ts:169`, `yume.js:71` (`_saveTokens`) |
| Frissítő token (256 bites véletlen érték; az adatbázisban csak a SHA-256 lenyomata) | süti: `yume_refresh`, `HttpOnly`, `SameSite=Strict`, `Path=/v1/auth`, élesben `Secure` | 30 nap | `config.ts:170`, `auth/routes.ts:128` |
| WebSocket-belépés | egyszer használható jegy, nem a token (az URL naplókba kerülhet) | — | `features/watch-together/watch-together.js:33` |

**A hozzáférési token visszavonható, nem csak lejár.** A token a munkamenetre mutat (`sid`). A
kiszolgáló minden kérésnél ellenőrzi, hogy a fiók `token_version` értéke egyezik-e, és hogy a
munkamenet él-e (`middleware/auth.ts:104`, `tokenIsCurrent`). Kijelentkezéskor a munkamenetből
kiadott token ugyanabban a folyamatban azonnal érvénytelenné válik, a többi példányon legkésőbb a
gyorsítótár idejének leteltével (`PERMISSION_CACHE_TTL_MS`, alapból 30 másodperc). A
„kijelentkezés mindenhonnan” és a jelszócsere a `token_version` növelésével a fiók összes tokenjét
visszavonja.

**Forgatás és újrafelhasználás-figyelés** (`auth/routes.ts:395–445`). A frissítés egyetlen
utasításban kiváltja és visszavonja a munkamenetet (`rotateSession`). Ha egy már lecserélt tokent
a türelmi időn belül mutatnak fel (`REFRESH_REUSE_GRACE_MS`, alapból 30 másodperc), a válasz
`401 refresh_rotated`, mert ez két fül versenyfutása. Ha később, a kiszolgáló a fiók összes
munkamenetét és tokenjét visszavonja, és naplóz: így néz ki egy ellopott frissítő token.

**CSRF nincs, és ez szerkezeti tulajdonság.** Az API kizárólag az `Authorization: Bearer`
fejlécből hitelesít. Egyetlen süti létezik, az is `SameSite=Strict`. Ezt az
`apps/api/test/csrf.test.ts` rögzíti.

**CSP** (`middleware/security.ts:60`): `script-src 'self'` (Turnstile és a Cloudflare-analitika
eredete csak akkor, ha be vannak kapcsolva), `object-src 'none'`, `base-uri 'self'`,
`form-action 'self'`, `frame-ancestors 'none'`. Két tudatos lazítás van. A `connect-src 'self' https:`
azért kell, mert a kliens közvetlenül hívja az AniList, Jikan és ani.zip API-kat, a videóforrások
pedig tetszőleges külső gazdákon vannak. A `style-src 'unsafe-inline'` azért, mert a felület
beágyazott stílusokat állít.

## A döntés és indoklása

### 1. A hozzáférési token a `localStorage`-ban marad

A „csak memóriában” változat XSS ellen **ebben a felépítésben semmit nem nyer**. A böngésző a
frissítő sütit a saját eredetű kérésekhez csatolja, a frissítő végpont pedig a válasz törzsében
adja vissza az új hozzáférési tokent. Egy befecskendezett szkript ezért memóriabeli tárolás mellett
is kér magának egy friss tokent egyetlen `fetch('/v1/auth/refresh', { method: 'POST', credentials:
'include' })` hívással, és azt ugyanúgy kiviheti, mint a `localStorage`-ból olvasottat. Ezt a
2026-09-28-i mérés is mutatta: a lap saját `fetch` hívása a sütivel 200-at kapott. Az XSS elleni
védelem helye a CSP és az, hogy a DOM elemekből és `textContent`-ből épül, nem a token rejtése.

Amit viszont elvesztenénk:

* **Villanás és várakozás minden betöltéskor.** A `user()` szinkron módon dönti el, mit rajzol a
  keret. Memóriabeli tokennel minden betöltés és minden új fül egy frissítéssel indulna, és addig a
  felület kijelentkezettnek látszana, vagy várna.
* **Fülenként külön forgatás.** Minden új fül forgatná a sütit. Ez pontosan az a verseny, amely a
  lenti mérésben kijelentkeztetett, csak gyakoribb lenne: nem lejáratkor jönne elő, hanem minden
  fülnyitáskor.

### 2. A frissítő token `HttpOnly` sütiben marad

Ennek a nyeresége valódi: a 30 napos hitelesítő adatot szkript nem tudja kiolvasni. Egy XSS csak
addig használhatja a munkamenetet, amíg a lap nyitva van. Magával vinni legfeljebb egy 15 perces,
visszavonható hozzáférési tokent tud.

### 3. Elvetett változatok

* **A hozzáférési token is sütiben** (süti alapú munkamenet az egész API-n). Ettől a pillanattól
  minden állapotváltoztató végpont CSRF-védelmet igényelne, és a `csrf.test.ts` jelezné is. Megváltozna
  a Bearer tokent használó kliensek szerződése is. Nagy és kockázatos átalakítás lenne, és a fenti
  XSS-helyzeten nem változtatna: a lapon futó szkript sütivel is a felhasználó nevében kérne.
* **Köztes kiszolgáló (BFF / token handler).** Egy eredetű SPA-nál ugyanaz a helyzet, mint az előző
  pontnál, egy további kiszolgálóelem árán.

## A felülvizsgálat közben talált hiba és javítása

**Tünet.** Ha több fül egyszerre töltődik be lejárt hozzáférési tokennel (böngésző-újraindítás,
visszaállított munkamenet), mindegyik ugyanazzal a sütivel frissít. A zár nélküli kliens
fülenként csak egyszer próbálkozott újra. A második körben is vesztes fül ezért törölte a
**közös** `localStorage`-ot, azt a tokent is, amelyet egy másik fül épp megkapott. A felület
kijelentkezett, a munkamenet közben élt. A frissítés ráadásul csak 401-re indul, és a kliens nem
tudta, hogy a 401-es kérés még a régi tokennel ment el. Ezért egy fül egy betöltés alatt többször
is forgatott.

**Mérés** valódi Chromiumban, a helyi tesztpéldányon (egy böngészőkörnyezet, közös süti és tár;
a mérő a munkamenet eszköze volt, az állandó párja a lenti E2E-teszt):

| Fülek | Előtte: frissítések | Előtte: tárolt token a végén | Utána: frissítések | Utána: tárolt token |
|---|---|---|---|---|
| 2 | 4 (1× `refresh_rotated`) | megvan | 1 | megvan |
| 4 | 7 (5× `refresh_rotated`) | **üres — kijelentkezett** | 1 | megvan |
| 8 | 17 (11× `refresh_rotated`) | megvan — ebben a futásban; a válaszok sorrendjén múlik | 1 | megvan |
| 12 | — | — | 1 | megvan |

A munkamenet minden esetben élt: a sütivel indított próbafrissítés 200-at adott.

**Javítás** (`apps/web/src/shared/api/yume.js`):

1. `_exclusive` (`yume.js:274`): a frissítés a `navigator.locks` `yume-auth-refresh` zárja alatt
   fut. Aki a zárra várt, előbb megnézi, kicserélte-e már más a tokent, amellyel ő elbukott. Ha
   igen, azt használja, és nem forgat újra.
2. A kérés 401-es ágában (`yume.js:140`) csak akkor indul frissítés, ha még az a token van tárolva,
   amellyel a kérés elment. Ha közben kicserélődött, a kérés az újjal ismétlődik meg.
3. Egy elbukott frissítés csak akkor jelentkeztet ki, ha még a saját, elbukott tokenje van
   tárolva. Egy másik fül frissen kapott tokenjét nem törli.

Web Locks nélküli böngészőben (régebbi böngésző, nem biztonságos környezet) a régi út marad: a
kiszolgáló türelmi ideje és az egyszeri újrapróbálás. A 3. pont miatt ott sem törli egy vesztes
fül egy másik fül friss tokenjét. Mérve, a zárat letiltva: 4 fülnél 5, 8 fülnél 14 frissítés, és
a tárolt token mindhárom futásban megmaradt.

**Tesztek:** `apps/web/test/auth-refresh-tabs.test.mjs`, négy eset: négy fül egy frissítéssel;
zár nélkül a vesztes nem jelentkeztet ki; a késve visszaérkező 401 nem forgat újra; a kiszolgáló
valódi elutasítása továbbra is kijelentkeztet. A régi kódon a négyből három elbukik; ezt a
javítás visszafordításával ellenőriztük. Böngészőben: `tests/e2e/session-refresh.test.mjs`, öt
egyszerre betöltődő fül egyetlen frissítéssel, élő tokennel a végén.

## Ami nyitva marad

* **`connect-src https:` — marad, szándékosan.** Egy XSS bármely HTTPS gazdára kiviheti a 15
  perces tokent. Szűkíteni azonban nem lehet: a lejátszó a HLS-listákat és -szeleteket
  `fetch`-csel tölti a szolgáltatók CDN-jeiről, és az `http-feed` adapterrel az admin tetszőleges
  forrást vehet fel. Egy zárt lista ezeket csendben elvágná, és a néző csak annyit látna, hogy
  „nem sikerült lejátszani". Az XSS ellen a lenti Trusted Types véd — az nem a kivitelt, hanem a
  befecskendezést zárja.
* **Trusted Types — 2026-09-28 óta kikényszerítve.** A CSP `require-trusted-types-for 'script'`
  és `trusted-types yume yume-inert` irányelve mellett a Chromium-alapú böngészők megtagadnak
  minden nyers `innerHTML`-t, `DOMParser`-elemzést és `script.src`-t. A kliens minden nyelője
  egyetlen modulon (`apps/web/src/shared/lib/trusted.js`) megy át; ezt a
  `apps/web/test/trusted-sinks.test.mjs` őrzi. Kipróbálva kikényszerítve: 57 nézet belépés nélkül,
  felhasználóként és adminként, a Player 2.0 vezérlőivel és menüjével, és a Turnstile a
  Cloudflare valódi szkriptjével (teszt-kulcsokkal) egy teljes regisztrációig — egyetlen sértés
  nélkül. Visszalépés telepítés nélkül: `CSP_TRUSTED_TYPES=report` (vagy `off`) és újraindítás.
* **Felülvizsgálandó**, ha a kliens külső szkriptet kap, ha a CSP-jelentések szkript-sértést
  mutatnak, vagy ha az API bármilyen okból süti alapú hitelesítést vezet be.
