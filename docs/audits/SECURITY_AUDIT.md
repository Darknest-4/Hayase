# Biztonsági átvizsgálás — 2026-09-15

Minden lelet mérésből származik, nem olvasásból. Ahol azt írom, hogy valami
lefut vagy nem fut le, ott lefuttattam.

---

## SEC-01 · IDOR a hírek elvetésében

| | |
|---|---|
| **kategória** | tárgyszintű hozzáférés (IDOR) |
| **súlyosság** | **P1** |
| **hely** | `apps/api/src/modules/announcements/routes.ts` |
| **állapot** | **javítva** — `51c8dc4b` |

**A hiba.** A `POST /v1/announcements/:id/dismiss` az `X-Profile-Id` fejlécből
vette a profilt, és annak a nevében szúrt be sort az
`announcement_dismissals` táblába. Tulajdonosi ellenőrzés nélkül. A `GET`
ugyanígy: a fejlécben megnevezett profil elvetési állapotát adta vissza.

**Miért számít.** A jogosultságrendszer ezt nem fogja meg, és ez a lényeg: a
hívónak *van* joga hírt elvetni. Csak nem azét. Egy bejelentkezett látogató,
aki ismer egy profilazonosítót, írni tudott más sorába és olvasni tudta más
állapotát.

**A tárgy jelentéktelen** — egy „ezt már olvastam" jelzés. A hiba fajtája nem.

**Ami észrevehetetlenné tette.** A helyes, tulajdonost ellenőrző feloldó
*létezett*. Háromszor: a könyvtárban, a beállításokban és a GraphQL
kontextusában — karakterre ugyanaz a tizennégy sor. A hírek útvonalán nem.
Egy megismételt védelem az a védelem, amiből egy példány hiányozni fog.

**A javítás.** `apps/api/src/middleware/profile.ts` az egyetlen hely, ami
megválaszolja, hogy „melyik profil nevében beszél ez a kérés". A szerződés nem
lazult:

```
nincs fejléc      400
idegen profil     403 — elutasítás, nem néma kiszolgálás
saját profil      a művelet
```

Az első kísérletem fellazította (a fejlécet figyelmen kívül hagyva a hívó saját
profilját szolgáltam ki), és két meglévő teszt megfogta. Igazuk volt: a néma
kiszolgálás azért rosszabb, mert a hívó azt hiszi, arról a profilról kapott
választ, amit kért.

**Teszt.** `apps/api/test/idor.test.ts`, hét eset. Ellenőrizve, hogy fog is: a
régi sort visszatéve a negyedik eset elbukik, a többi nem.

---

## SEC-02 · `innerHTML` nyelő a katalógusszövegen

| | |
|---|---|
| **kategória** | XSS (védelmi mélység) |
| **súlyosság** | **P2** |
| **hely** | `apps/web/src/shared/lib/dom.js` — `U.plainDesc` |
| **állapot** | **javítva** — `77516988` |

**A hiba.** A leírásból úgy lett szöveg, hogy egy leváló `div`-be került
`innerHTML`-lel, aztán `textContent`-tel kiolvasva. A „leváló" nem véd:
megmértem mindhárom motorban, hogy egy leváló elembe illesztett
`<img src=x onerror=…>` **lefut** — Chromiumban, WebKitben és Firefoxban
egyaránt —, mert a kép betöltése az elem létrejöttéhez kötődik, nem a
dokumentumhoz.

A leírás nem a miénk: importból jön, és az adminfelületen szerkeszthető.
Ugyanez a függvény rajzolja a főoldali kiemelést, az adatlapot és a
gyorsnézetet.

**Amit nem állítok.** Ez a telepítés **nem volt kihasználható** rajta
keresztül. A CSP megfogta: `script-src 'self'`, `unsafe-inline` nélkül. Le is
mértem: a CSP-fejléc érvényben a régi, sebezhető változattal is átment az új
teszt.

Tehát nem kihasználható hiba volt, hanem egy hiányzó réteg: egyetlen
félregépelt direktíva választotta el egy katalógusmezőt a kódfuttatástól.

**A javítás.** `DOMParser` inert dokumentumot ad — nincs böngészési kontextusa,
nem tölt be képet, nem futtat semmit.

**Teszt.** `tests/e2e/xss.test.mjs` mindhárom motoron, **a CSP-fejléc
eltávolításával**: a kérdés nem az, hogy két réteg közül megvéd-e az egyik,
hanem hogy a kliensoldali tisztítás önmagában megáll-e. Ellenőrizve: a régi
nyelővel mind a három motor elbukik.

---

## SEC-03 · A Redis minden interfészre publikált volna

| | |
|---|---|
| **kategória** | konfiguráció |
| **súlyosság** | **P2** (latens) |
| **hely** | `docker-compose.yml` |
| **állapot** | **javítva** — `519fee09` |

A szolgáltatás `profiles: ['infra']` mögött alszik és nem fut, de a definíciója
`ports: ['6379:6379']` volt. Egy `docker compose --profile infra up` elég lett
volna ahhoz, hogy egy jelszó nélküli Redis a nyílt interneten hallgasson.
Loopbackra kötve.

---

## SEC-04 · A CSRF-modell helyes volt, de semmi nem tartotta

| | |
|---|---|
| **kategória** | CSRF |
| **súlyosság** | **P2** (megelőzés) |
| **állapot** | **javítva** — `519fee09` |

Az API kizárólag `Authorization: Bearer` fejlécből hitelesít, és egy idegen
oldalról indított kérés nem tud fejlécet küldeni a látogató nevében. Ambiens
hitelesítő adat nincs, tehát CSRF sincs — ez szerkezeti tulajdonság.

Egyetlen süti létezik (`yume_refresh`): httpOnly, éles módban secure,
`SameSite=Strict`, és egyetlen végpont olvassa.

Nem volt rá teszt. Ha valaki egyszer süti-alapú hitelesítést vezet be —
kényelemből, egy mobilkliens kedvéért —, a CSRF ugyanabban a pillanatban
megjelenik minden állapotváltoztató végponton, és semmi nem szól.
`apps/api/test/csrf.test.ts` most ez a valami.

---

## Amit megnéztem, és rendben volt

Ezeket is le kell írni, különben az átvizsgálás csak a rosszat méri.

| terület | mit találtam |
|---|---|
| **SQL-injekció** | Minden lekérdezés paraméteres. A rendezési oszlop és irány zárt listából jön (`SORTS`), nem a bemenetből. Az `adversarial.test.ts` külön vizsgálja. |
| **SSRF** | Saját őr (`infrastructure/http/ssrf.ts`), saját tesztfájllal. DNS-feloldás, privát tartományok, átirányítási láncok. A webhook-kézbesítés minden alkalommal újra ellenőriz, mert a DNS változhat. |
| **Jelszókezelés** | Argon2id, a munkamenet tokenverzióhoz kötve, kilépéskor azonnal érvénytelen — nem csak a frissítő. |
| **Jogosultságok** | 36 érvényesített jogosultság; a `permission-status.test.ts` elbukik, ha egy „aktív" sor mögött nincs útvonal. Az adminfelület 404-et ad, nem 403-at: a felület létezése maga az információ. |
| **GraphQL** | Mélységkorlát 10, kötegelés kikapcsolva, introspekció élesben tiltva (ellenőriztem az éles végponton), lekérdezésszöveg-hossz korlátozva. |
| **WebSocket** | Jegyalapú hitelesítés, korlátozott hitelesítés előtti pufferrel, újrahitelesítő söpréssel. |
| **Fejlécek** | CSP `unsafe-inline` nélkül a scriptekre, HSTS, `X-Content-Type-Options`, `frame-ancestors`. |
| **Titkok** | Végigkerestem a követett fájlokat API-kulcsra, tokenre, magánkulcsra. A `.env` nincs követve; a `.env.example` helykitöltőket tartalmaz. **Valódi titkot nem találtam a verziókezelt fájlokban.** |
| **Fiók-felsorolás** | A `/forgot` 204-et ad, akár létezik a fiók, akár nem. |
| **Sebességkorlát** | Külön a hitelesítésre és az írásokra; az `adversarial.test.ts` a megkerülését is vizsgálja. |

---

## Amit nem vizsgáltam

* **Kockázati motor / botfelismerés.** A kért „Security & Risk Engine" új
  alrendszer lenne. Ezen a forgalmon — egy magyar nyelvű példány, 14 fiók — a
  meglévő sebességkorlát és a vészkapcsolók fedezik a kockázatot, és egy
  pontozó motor, amit senki nem kalibrál, hamis pozitívokat termel. Akkor
  érdemes, ha van mit kalibrálni rajta: mérhető visszaélés.
* **Terheléses és fuzz-vizsgálat.** Nem futtattam.
* **Függőségek CVE-vizsgálata.** Tizenkét futásidejű függőség, mind ismert
  karbantartású; verzióról verzióra átnézést nem végeztem.
