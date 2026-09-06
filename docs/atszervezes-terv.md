# Yume átszervezés — terv és nyitott kérdések

A 24 pontos brief alapján. Ez **terv, nem kód**: a végén vannak kérdések, amikre
a válasz nélkül rossz irányba indulnék.

Minden állítás alatt ott a fájl és a sor, ahol ellenőriztem. Semmit nem írtam le
emlékezetből.

---

## 0. Egy feloldhatatlan ellentmondás — ez az első kérdés

**Az 1. pont (kiegészítők törlése) és a 6. pont (URL nélküli epizód ne legyen
kattintható) együtt azt jelenti, hogy egyetlen epizód sem lesz kattintható.**

Ma a videóforrás pontosan két helyről jöhet:

| Forrás | Hol | Megjegyzés |
|---|---|---|
| Kiegészítők | `web/js/stream-engine.js:295–320` | `host.call(ext.slug, 'single', query)` |
| Kézzel bemásolt URL | `web/js/pages/watch.js:416` | a néző beírja a lejátszóba |

Nincs harmadik. A `video_sources` és `source_mirrors` tábla létezik, de **egyetlen
route sem szolgálja ki** — ellenőrizve, üres a találat.

Tehát ha a kiegészítők eltűnnek, a Yume katalógus + közösség lesz, lejátszás
nélkül. Ez lehet szándékos döntés, de nem hiszem, hogy erre gondoltál, amikor a
6. pontot írtad. **Kérdés a végén (K1).**

---

## 1. Ami már kész — ezért ne fizess érte kétszer

A brief több pontja már megvan, részben az elmúlt napok munkájából:

| Brief pont | Állapot | Hol |
|---|---|---|
| 2. AniList ne kiegészítőként | **Kész.** Első osztályú szerver-worker, sosem volt kiegészítő | `server/src/workers/anilist.ts` |
| 3. Batch sync, queue, retry, rate limit | **Nagyrészt kész.** Soronkénti savepoint, 429-kezelés, folytathatóság | `workers/anilist.ts`, `anilist-deep.ts` |
| 4. Relations import | **Kész**, de nincs évad-/watch-order-nézet | `workers/anilist-deep.ts` |
| 5. Karakterek, stáb, szinkronhangok | **Kész** (import + API + kliens) | `anilist-deep.ts`, `routes/anime.ts` |
| 17. Külső ID-k indexelve | **Kész**, AniList + MAL + AniDB + TVDB | `anime_mappings`, 0002 |
| 19. Fordítás adatmodellje | **Kész**, `anime_translations` + `episode_translations` | 0023-as migráció |

Ami a 2–5. pontból **hiányzik**: a MAL mint második forrás, a `last_synced_at` /
`sync_status` mezők, az admin sync-felület, az évad-/watch-order-nézet, és hogy a
25 000 címre le is fusson a mély import (ez órákig tart, és a te VPS-eden kell).

---

## 2. Megerősített hibák — ezeket megtaláltam, mind valós

### 2.1 A header-bug oka: a kapu nyitva bukik

`web/js/app.js:94–112`, a `_gateCheck()`:

```js
const flag = cfg.flags['page.' + route]
if (!flag) return { ok: true }        // ← nincs flag → mindenki bemehet
```

Ha a `feature_flags` táblában **nincs `page.admin` sor**, akkor minden
bejelentkezett felhasználó látja az Admin menüpontot. Nem role-string alapján
hardcode-olt (azt jól sejtetted, hogy baj van, de az ok más): **hiányzó
konfiguráció esetén megengedő az alapértelmezés.**

Ugyanez két sorral feljebb:

```js
if (!cfg) return { ok: true }         // ← backend elérhetetlen → minden megy
```

Ez ugyanaz a hiba nagyban: ha az API nem válaszol, a kliens mindent kinyit.

**Javítás:** a kapu alapértelmezése legyen tiltó minden `admin*` route-ra, és a
kliens a *tényleges* jogosultságlistából döntsön (`this.perms`), ne flag
meglétéből.

### 2.2 403 a 404 helyett

`server/src/plugins/auth.ts:217` — a `requirePermission` 403-at ad. A 9. pont
404-et kér, hogy a panel létezése se derüljön ki.

**Fontos részlet:** ezt nem szabad mindenhol 404-re cserélni. A 403 a helyes
válasz ott, ahol az erőforrás létezése amúgy sem titok (pl. saját profil
szerkesztése). Csak az admin-felület route-jain kell 404, ahol maga a *létezés* az
információ. Ezt kapcsolóval oldom meg a `requirePermission`-ben, nem globális
cserével.

### 2.3 Az epizód mindig kattintható

`web/js/pages/anime.js:644` és `:138` — feltétel nélkül navigál a
`#/watch/...`-ra. Nincs URL-ellenőrzés sem itt, sem a route-ban.

**Javítás:** az epizód-rekord kapjon egy `has_source` jelzést a szerverről, a
kártya legyen letiltva enélkül, és a `#/watch` route is utasítsa vissza — a 6.
pont külön kéri, hogy a route kézi hívásával se lehessen megkerülni.

> Megjegyzés: ennek a jelzésnek csak akkor van értelme, ha van szerveroldali
> forrás-nyilvántartás. Ma nincs (lásd 0. szakasz) — ezért függ ez is a K1-től.

---

## 3. Fázisok

Egy PR-ban ez átnézhetetlen lenne. Öt kör, mindegyik önmagában is értelmes és
külön mergelhető.

### 1. kör — Hazug felület (≈ fél nap)
A legfontosabb, mert ma **félrevezeti a felhasználót**.

- kapu-alapértelmezés tiltóra, header-bug (`app.js`)
- 404 az admin route-okon (`plugins/auth.ts`, opcionális kapcsolóval)
- URL nélküli epizód: letiltott állapot + route-védelem
- a nem működő beállítások **kivezetése vagy bekötése** — a 11. pont szerint
  ami nem csinál semmit, az ne maradjon bent

### 2. kör — Admin panel (≈ 1–1,5 nap)
- külön layout: saját sidebar, nincs normál header/footer/mobil nav
- összecsukható sidebar a brief szerinti csoportosítással
- reszponzív: mobilon drawer
- admin-specifikus táblák, amik telefonon is kezelhetők

### 3. kör — Kiegészítők lebontása + témarendszer (≈ 1,5–2 nap)
**Ez a kör a K1 válaszától függ.**

- ~3559 sor platformkód, 8 kiegészítő-csomag, 9 adatbázistábla
- migráció: a táblák **eldobás előtt** függőség-ellenőrzéssel
- a témarendszer a **meglévő `web/css/tokens.css`-re** épüljön: az egész UI már
  abból építkezik, tehát egy tokenkészlet-csere tényleg mindent átfest — és nem
  lehet vele eltörni az oldalt
- 2 alternatív téma (Crimson, Midnight)

### 4. kör — Metadata sync felület (≈ 1 nap)
- `last_synced_at`, `sync_status`, `sync_error` oszlopok
- admin: Sync Anime / Sync All, haladás, hibalista, újrapróbálás
- a meglévő `jobs` sorra épül, nem új infrastruktúra
- MAL mint második forrás (Jikan API)

### 5. kör — Évadok, watch order, minőségi kör (≈ 1 nap)
- franchise-nézet: évadok, filmek, speciálok, előző/következő
- webhook-payload bővítése, audit-események
- reszponzív végigjárás valódi böngészőben (a Playwright-teszt már megvan hozzá)

---

## 4. Amit másképp javaslok, mint a brief

**A téma ne engedjen szabad CSS-t.** A 20. pont „ne primitív CSS textarea" —
egyetértek, de a másik irányban is: a szabad CSS a témát írási joggá teszi az
egész felületen. Egy rossz téma használhatatlanná teszi az oldalt, és XSS-felületet
nyit. Tokenkészlet + komponens-szintű kapcsolók: erős, de nem tud eltörni semmit.

**A webhook-payloadból hagyjuk ki az e-mailt és a nyers IP-t.** A 12. pont maga is
feltételhez köti. Javaslat: e-mail soha, IP maszkolva (`203.0.x.x`). Egy webhook
URL bearer-hitelesítő; aki megszerzi, mindent lát, amit valaha küldtünk rá.

**A „Sync All" ne legyen egy gomb, ami elindít 25 000 külső hívást.** Legyen
kötegelt, megszakítható, és mutassa, hány óra van hátra. AniList rate limitje
90/perc — a teljes mély import **órákban** mérhető.

---

## 5. Amit nem tudok itt leellenőrizni

A `graphql.anilist.co` és az `api.jikan.moe` (MAL) **blokkolt** ebből a
környezetből (szervezeti szabály). A sync-kódot meg tudom írni és rögzített
válaszokkal tesztelni, de **élesben nem tudom kipróbálni** — azt a te VPS-eden
kell, ahonnan elérhetők.

---

## 6. Kérdések

**K1 — Lejátszás.** A 0. szakasz miatt: a kiegészítők törlése után mi legyen a
videóforrás? (a) beépített, szerveroldali forrás-provider réteg; (b) egyelőre
nincs lejátszás, csak katalógus; (c) a sandbox marad *csak* forrásoknak, minden
más kiegészítő megy.

**K2 — Külső API.** Korábban azt kérted, ne kérje le AniListről, ha nincs meg
nálunk. A 2.4 pont viszont pont ezt engedné. Melyik? (a) kérés közben soha, csak
háttér-sync; (b) ismeretlen címnél egyszer lekéri és elmenti; (c) csak admin
indíthatja kézzel.

**K3 — Sorrend.** Az öt kör közül mivel kezdjem? Én az 1. kört javaslom: ma a
felület olyat állít, ami nem igaz, és ez a legolcsóbban javítható kár.

**K4 — Meglévő kiegészítők.** A `jellyfin`, `plex`, `opensubtitles`, `aniskip`
csomagok valódi funkciót adnak. Ezek beépített funkcióvá alakuljanak, vagy
elvesszenek a kiegészítőkkel együtt?
