# Discord setup, javítás és takarítás

**Egy szerver, amit a rendszer magától beállít — és amit soha nem ront el.**

---

## 1. Három szabály

1. **Idempotens.** Ugyanaz a futás másodszor nem hoz létre semmit. A döntést
   a registry logikai kulcsa hozza, nem a Discord-objektum neve.
2. **Amit nem mi hoztunk létre, ahhoz nem nyúlunk.** Egy azonos nevű, már
   létező csatornát **örökbe fogadunk** (kezeljük), de sosem törlünk.
3. **Egy elbukott lépés nem állítja meg a többit.** Minden lépés külön
   eredményt ad, és a futás `partial` lesz — egy zöld pipa egy félbehagyott
   szerver fölött rosszabb, mint egy piros.

## 2. A registry

Ez a rendszer egyetlen helye, ahol az áll, **mi a miénk**.

| Oszlop | Mit jelent |
|---|---|
| `logical_key` | a MI nevünk (`channel:uj-epizodok`) |
| `discord_object_id` | amit a Discord adott |
| `managed_by_yume` | kezeljük |
| **`created_by_yume`** | **MI hoztuk létre** — csak ezt szabad törölni |
| `configuration_version` | melyik leírás hozta létre |
| `deleted_at` | soft delete: a történet is válasz |

**A két tulajdonlási szint a különbség egy takarítás és egy katasztrófa
között.** Ha a setup egy már létező `#altalanos` csatornát talál, nem hoz
létre másodikat — hanem attól kezdve kezeli, `created_by_yume = false`-szal.
A gyári visszaállítás kizárólag a `true` sorokat törli.

Két **részleges egyedi index** zárja ki a duplikációt: egy guildben egy
logikai kulcs egyszer szerepelhet élő sorként, és egy Discord-objektum
egyszer. Nem egy előzetes lekérdezés, amit két egyidejű setup mindkettőnek
„nincs még"-gyel válaszolna meg.

## 3. A struktúra

Egyetlen fájlban: `apps/api/src/modules/discord/structure.ts`. **Nincs benne
egyetlen Discord-azonosító sem** — azt a Discord adja, guildenként mást.

| Kategória | Csatornák |
|---|---|
| Információ | informacio, bejelentesek, szabalyzat, udvozlet |
| Közösség | altalanos, anime-beszelgetes, ajanlasok, off-topic |
| YUME | uj-epizodok, adasmenetrend, nepszeru-animek, statisztika, bot-allapot |
| Bot | bot-parancsok, bot-naplo |

Rangok: **YUME Moderator**, **YUME Support**, **YUME Notifications**,
**YUME Verified**.

**Egyik sem kap Administratort**, és a `YUME Verified` semmilyen jogot nem ad
— mindkettőt teszt őrzi. Az Administrator bit minden mást felülír; egy
„értesítések" rang, ami mellékesen adminjogot ad, pontosan az a hiba, amit
hónapokkal később, egy incidens közben szoktak megtalálni.

A YUME-csatornákban az `@everyone` **látja** a csatornát, de nem ír bele: egy
folyamatosan frissülő embed alá beszúrt üzenetektől az embed feljebb csúszna.

## 4. A négy művelet

| Művelet | Mit csinál | Töröl? |
|---|---|---|
| **Előnézet** | megmutatja a tervet | nem — semmit nem módosít |
| **Setup** | létrehozza a hiányzókat | nem |
| **Javítás** | újraszinkronizál, majd pótol | nem |
| **Gyári visszaállítás** | törli, amit MI hoztunk létre | igen, két lépésben |

Az előnézet és a futtatás **ugyanazt a tervet** használja — nem két külön
kódút, ami idővel szétcsúszik.

### A lépések állapotai

| Állapot | Mit jelent |
|---|---|
| `ok` | rendben van, nincs teendő |
| `create` | hiányzik |
| `adopt` | létezik azonos néven, de nem a miénk |
| `update` | a miénk, de eltér a leírástól |
| `recreate` | a miénk volt, és a Discordból eltűnt |
| `blocked` | jogosultság vagy rangsorrend miatt nem végezhető el |

## 5. Jogosultság és rangsorrend

A terv **előre** megnézi, mit tud a bot:

* hiányzó `Csatornák kezelése` / `Szerepkörök kezelése` → az érintett lépések
  `blocked`, és meg sem próbáljuk;
* a bot **legmagasabb rangja fölötti** rangot a Discord nem engedi módosítani
  → `blocked`, érthető indoklással. Enélkül a hiba egy
  „hiányzó jogosultság" lenne, amiből senki nem találná ki, hogy a
  sorrenden múlik.

Az `@everyone` jogosultságai is beleszámítanak a bot összesített jogaiba, és
az `Administrator` mindent felülír.

> **Mért hiba, élesben.** A `GET /guilds/{id}/members/@me` végpont **csak
> OAuth bearer tokennel** működik; bot tokennel a Discord `50035`-tel
> utasítja vissza. Emiatt a rendszer azt hitte, hogy a botnak nincs
> egyetlen jogosultsága sem, és mind a 23 lépést blokkolta — egy olyan
> szerveren, ahol a bot valójában adminisztrátor. A kliens azóta előbb a
> bot saját azonosítóját kérdezi le.

## 6. A gyári visszaállítás védelmei

1. **Külön megerősítő lépés** — az első gomb csak előnézetet ad.
2. **A törlendők listája előre látszik**, a védettekkel együtt.
3. **Szerveroldali jegy**, ami egy guildhez, egy felhasználóhoz, egy
   művelethez és egy **konkrét listához** szól, öt percig, **egyszer**.
4. **Ha közben változik a lista**, a jegy érvénytelen.
5. **`POST` és jegy** — GET-tel vagy CSRF-fel nem indítható.
6. **Csak `created_by_yume = true`** — örökbe fogadott objektum soha.
7. **Audit log** minden törlésről.
8. **Részleges eredmény** pontosan kiírva, nem „sikeres".

Amit **soha** nem töröl: más botok objektumait, ismeretlen objektumokat, az
`@everyone` rangot, és bármit, ami nincs a registryben.

## 7. Újraszinkronizálás

Ha valaki kézzel törölt egy csatornát a Discordban, a registry még azt hiszi,
hogy megvan. Az újraszinkronizálás ezt észreveszi: a **sor megmarad**, csak a
`discord_object_id` ürül ki — így marad meg az, hogy ez a **mi** objektumunk
volt, és a következő javítás újra létrehozza.

## 8. Hol van

| Mi | Hol |
|---|---|
| A kívánt struktúra | `apps/api/src/modules/discord/structure.ts` |
| A registry | `apps/api/src/modules/discord/registry.ts` |
| A motor | `apps/api/src/modules/discord/setup.ts` |
| A felület | `apps/discord/src/setup.js` |
| A tesztek | `apps/api/test/discord-setup.test.ts` |
| Vezérlőpult | `discord.animehub.hu` → **Setup** |
