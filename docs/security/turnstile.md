# Emberpróba — Cloudflare Turnstile

## Mit véd, és mit nem

Nem a jelszót: azt a sebességkorlát és a szándékosan drága hasítás
(scrypt, N=2^17) védi. Ez a **tömeget** fogja:

* a percenként húsz kitalált e-mail-címmel nyitott fiókot,
* a végigpróbált jelszólistát,
* a jelszó-emlékeztetővel bombázott idegen postaládát.

Egy ilyen kérés önmagában szabályos. Csak az a gyanús benne, hogy nem ember
küldte.

## Beállítás

```
TURNSTILE_SITE_KEY=0x…      # nyilvános, a widget HTML-jébe kerül
TURNSTILE_SECRET_KEY=0x…    # SOHA nem hagyja el a kiszolgálót
TURNSTILE_HOSTNAMES=animehub.hu,www.animehub.hu,yumee.duckdns.org
TURNSTILE_PROTECT=register                # jelenleg CSAK a regisztráció — lásd lent
```

**Mindkét kulcs hiányában a modul minden kérést átenged**, és az idegen
eredetű widget-szkript a CSP-be sem kerül bele. A kikapcsolás ezért egy sor
kivétele a `.env`-ből — ez az a fogantyú, amihez éjjel is hozzá lehet nyúlni.

A titok a `.env`-ben él, ami a `.gitignore`-ban van. Sehol máshol.

### Miért csak a regisztráció, egyelőre

A kód alapértelmezése `register,login`. Ezen a telepítésen mégis `register`
áll, és ennek mért oka van.

A widget él: betöltődik, megjelenik, a teljes Turnstile-folyamat lefut, a CSP
átengedi, és a kiszolgálói oldal minden ága tesztelt. Amit **nem lehet innen
megmérni**, az az, hogy a Turnstile egy *valódi embernek* kiad-e tokent — egy
automatizált böngészőnek ugyanis szándékosan nem ad. Böngészős próbán a widget
az „ellenőrizd, hogy ember vagy" jelölőnégyzetet mutatta, és tokent nem adott;
ez a termék helyes működése, nem hiba, de bizonyítéknak nem elég.

Amíg ez emberi próbával meg nem erősödik, a belépés érintetlen marad: ha a
widget bármi miatt nem működne, senki nem reked kívül a saját fiókjából. A
regisztráció ellenben látható és visszafordítható módon akad meg.

**A belépés bekapcsolása egy sor**, miután egy valódi böngészőben látszott,
hogy a widget kipipálja magát:

```bash
sed -i 's/^TURNSTILE_PROTECT=.*/TURNSTILE_PROTECT=register,login/' .env
docker compose up -d app
```

**Visszavonás bármikor**, ha valami elromlana: vedd ki a `TURNSTILE_SECRET_KEY`
sort, `docker compose up -d app`. A hitelesítés azonnal emberpróba nélkül megy
tovább.

### Miért nincs benne a `forgot` az alapértelmezésben

Egy emberpróba csak ott működik, ahol van űrlap, ami tokent tud szerezni. A
jelszó-emlékeztetőnek a webkliensben **ma nincs ilyen űrlapja**. Bevenni annyi
lenne, mint csendben bezárni egy végpontot: minden hívása 403-at kapna, és
senki nem tudná, miért. Amikor készül hozzá felület, a lista bővíthető.

### A gazdanevek listája

A Cloudflare megmondja, **melyik oldalon futott** a widget, és ezt
összevetjük. Enélkül egy máshol szerzett token is jó lenne — a helyszín kulcsa
nyilvános, tehát bárki kiteheti a saját lapjára.

A lista a `PUBLIC_URL` gazdájából indul, és a `TURNSTILE_HOSTNAMES` egészíti
ki. **Üres listánál nem ellenőrzünk**: egy olyan telepítésen, ahol a
`PUBLIC_URL` sincs beállítva, egy kitalált gazdanév mindenkit kizárna.

> Amit a Cloudflare felületén is be kell állítani: a widget **saját**
> gazdanév-listájába fel kell venni minden nevet, ami az oldalt kiszolgálja.
> Ami ott nincs benne, azon a widget nem tud tokent adni.
>
> **Ez mérve is látszik.** Böngészős próbán az `animehub.hu` tiszta volt, a
> `yumee.duckdns.org` viszont HTTP 400-at kapott a Turnstile-tól — a régi
> domain nincs a widget listáján. Amíg nincs, ott a regisztráció nem megy.
> Két megoldás: vedd fel a nevet a Turnstile widget beállításánál, vagy
> irányítsd át a régi domaint az `animehub.hu`-ra.

## A hiba iránya — a legfontosabb döntés

Egy emberpróba kétféleképpen hibázhat, és a kettőt **nem szabad** egyformán
kezelni:

| mi romlott el | mit teszünk | miért |
|---|---|---|
| nincs token, lejárt, már felhasználták, más művelethez vagy más oldalon szerezték | **zárunk** (403) | pontosan ez a dolgunk |
| rossz titok, hálózati hiba, időtúllépés, a Cloudflare kiesése | **átengedünk**, hangosan naplózva | egy Cloudflare-kiesés nem zárhatja ki a tulajdonost a saját oldaláról |

A második azért van így, mert a másik választás elfogadhatatlan: a
regisztráció nem állhat meg olyan hibából, amiről a látogató nem tehet.
Ilyenkor a sebességkorlát továbbra is áll — a védelem gyengül, de nem tűnik
el, és a napló megmondja, hogy épp gyengébb.

**A csendes átengedés lenne a rossz megoldás. Ezért nem csendes.**

Amit ilyenkor a naplóban keress:

```
AZ EMBERPRÓBA NEM FUTOTT LE, és a kérést átengedtük…
AZ EMBERPRÓBA A MI HIBÁNKBÓL BUKOTT EL, és a kérést átengedtük…
```

## A kapu helye

Minden védett útvonal **első sora**. Nem stílus kérdése: a jelszó-ellenőrzés
szándékosan drága, és egy robot kérésére egyetlen ilyet sem akarunk elégetni.
Ha a kapu a jelszó után futna, a végpont továbbra is kimerítő terhelésnek
lenne kitéve — csak közben emberpróbánk is lenne.

Ezt teszt méri: egy nem létező fiókkal, rossz jelszóval indított belépés
**403**-at kap, nem 401-et. A 401 azt jelentené, hogy a jelszóhoz hozzáértünk.

## CSP

A widget idegen origóról tölt **szkriptet és iframe-et**, tehát két
direktívába kell bekerülnie:

```
script-src 'self' https://challenges.cloudflare.com
frame-src  … https://challenges.cloudflare.com
```

Ez a lazítás **csak akkor kerül a fejlécbe, ha az emberpróba be van állítva**
— egy Turnstile nélküli telepítés ne engedjen be olyasmit, amit nem használ.

> A CSP **némán öl**: rossz beállítás mellett a widget egyszerűen nem jelenik
> meg, hibaüzenet nélkül. Ez a projektben egyszer már megtörtént a
> státuszoldal beágyazott szkriptjével, ezért van rá külön teszt.

## A token élettartama

Egyszer használatos, és néhány perc múlva lejár. A kliens ezt a hívónak nem
adja tovább:

* **küldés után mindig újrarajzolunk** — akármi miatt bukott el a küldés, rossz
  jelszó miatt is: a token elhasználódott, és a következő próbálkozás
  ugyanazzal biztosan elbukna;
* lejáratkor eldobjuk, amink van;
* az ablak bezárásakor a widgetet is elbontjuk, mert iframe-et és időzítőt
  hagyna maga után.

**Egy widget van, nem kettő.** A belépés és a regisztráció ugyanazt az ablakot
használja, a Cloudflare viszont a tokent a *művelethez* köti — a kiszolgáló
visszautasít egy belépésre szerzett tokent regisztrációnál. Fülváltáskor
ezért a widget újraépül a másik művelettel.

## Amit a kliens nem tud betölteni

Reklámszűrő, vállalati proxy, szakadó hálózat: bármelyik megeheti a szkriptet.
Ilyenkor a felhasználó **érthető üzenetet** kap még küldés előtt („Az
emberpróba nem tölthető be. Ha reklámszűrőt használsz, engedélyezd ezt az
oldalt."), nem pedig egy örökké pörgő gombot vagy egy értelmezhetetlen 403-at.

## Tesztek és mérőeszközök

* A **böngészős e2e** futások kikapcsolják magukban az emberpróbát: API-hívással
  regisztrálnak, tehát nincs widgetjük. A törlés az app importja *előtt*
  történik, mert a CSP betöltéskor épül fel.
* A **terheléses** mérés (`tests/load`) ugyanígy: ott nincs kulcs beállítva.
  Ha valaha élesben mérnél, vedd ki a titkot egy futás idejére.
* Nincs „terheléses kulcs" típusú megkerülés. Egy emberpróba, amin egy
  megosztott titokkal át lehet menni, pont annyit ér, mint a titok.

## Mellékes, de ugyanaz a hibafajta: a Web Analytics beacon

A Cloudflare Web Analytics mérőszkriptjét **nem mi tesszük be**: ha a zónán be
van kapcsolva, a Cloudflare az élen fűzi bele a HTML-be, a mi kódunk
megkerülésével. A CSP viszont a mi fejlécünk — és az blokkolta:

```
Loading the script 'https://static.cloudflareinsights.com/beacon.min.js/…'
violates the following Content Security Policy directive: "script-src 'self'…"
```

A kapcsoló a Cloudflare felületén be volt kapcsolva, a beacon minden
oldalbetöltésnél megpróbált elindulni, és **semmilyen adat nem érkezett**.
Néma hiba, ugyanaz a fajta, mint a widget CSP-problémája lett volna.

```
CLOUDFLARE_ANALYTICS=true
```

Alapból nincs benne: egy Cloudflare nélküli telepítés ne engedjen be egy
origót, amit sosem fog használni.
