# Események

Minden esemény, amit a rendszer rögzít: hol keletkezik, ki írja, mi van benne.

## 1. Oldalletöltés

**Honnan:** a kliens `POST /v1/analytics/view` hívása (a router `navigate()`
függvényéből, egyetlen helyről).
**Hova:** memóriapuffer → `analytics_sessions` + `page_views`.

Amit a kliens küldhet:

| mező | kötelező | korlát |
|---|---|---|
| `route` | igen | 1–200 karakter; az azonosítók `:id`-re cserélődnek a kiszolgálón |
| `entityId` | nem | uuid |
| `referrer` | nem | max 500 karakter; csak a gazdagép marad meg |
| `screenWidth` | nem | 1–10000; **sávvá** alakul |
| `utm.source/medium/campaign` | nem | max 80 karakter |

Bármi más → **400**. A kliens nem mondhatja meg, hogy ki ő, mikor volt, vagy
hányszor.

Duplikátumszűrés: ugyanaz a látogató + ugyanaz az útvonal + ugyanaz az
entitás 10 másodpercen belül **egy** letöltés. Ez fogja meg a frissítgetést és a
duplán elsütött beacont.

## 2. Nézés

**Honnan:** `PATCH /v1/me/progress/:episodeId` — amit a lejátszó amúgy is küld,
fél percenként.
**Hova:** `watch_progress` (a felhasználó haladása) és `watch_history` (a
menet).

| esemény | mikor keletkezik |
|---|---|
| `WATCH_START` | az első haladásírás egy epizódra hat órán belül → új `watch_history` sor, `finished = false` |
| `WATCH_PROGRESS` | további írások → `watched_sec` nő (sosem csökken: a visszatekerés nem veszi vissza a megnézett időt) |
| `WATCH_COMPLETE` | a kliens `completed: true`-t küld, és a pozíció hihető → `finished = true`, `ended_at` beáll |

Nincs külön `PAUSE`/`RESUME`/`SEEK`/`BUFFER` esemény. Ezek a lejátszóban
történnek, és önálló eseményként küldve ingyen hamisíthatók lennének, miközben
a kérdésre — „hányan indították el, és hol hagyták abba" — a fentiek is
válaszolnak. Ha egyszer lesz videóforrás és pufferelési panasz, akkor lesz
mihez mérni, és akkor érdemes bevezetni.

**Felfújás elleni védelem:**

* egy epizód egy menete hat órán belül **egy sor**, akárhányszor tölt be a lap;
* a befejezés csak akkor számít, ha a pozíció legalább 60 másodperc **vagy** a
  hossz felénél tart — egy „kész" 3 másodpercnél nem mérés, hanem hibás hívás;
* az XP és a statisztikafrissítés csak az **első** befejezéskor jár.

## 3. Keresés

**Honnan:** a keresés végpontja írja, a kiszolgálón.
**Hova:** `search_stats` (nyers + normalizált alak, találatszám, kattintott cím).

## 4. Fiókesemények

**Honnan:** az `auth` útvonalak, a kiszolgálón.
**Hova:** `account_events`, sorszámozott hivatkozással.

| esemény | mikor | eredmény |
|---|---|---|
| `REG` | sikeres regisztráció | `success` |
| `LOGIN` | sikeres belépés | `success` |
| `LOGIN` | felfüggesztett fiók belépési kísérlete | `blocked` |
| `LOGIN_FAILED` | rossz jelszó vagy nem létező fiók | `failed` |
| `LOGOUT` | kijelentkezés erről az eszközről | `success` |
| `SESSIONS_REVOKED_ALL` | kijelentkezés mindenhonnan | `success` |
| `PASSWORD_CHANGE` | jelszóváltoztatás (siker és kudarc is) | `success` / `failed` |
| `PASSWORD_RESET_REQUEST` | visszaállítás kérése (csak létező fióknál) | `success` |
| `PASSWORD_RESET` | a visszaállítás megtörtént | `success` |
| `ACCOUNT_DELETE` | a fiók törlése | `success` |

A hivatkozás alakja: `LOGIN_000182`. A sorszám adatbázis-sorozatból jön, tehát
két egyidejű esemény nem kaphat azonos számot. Ez az, amit egy bejelentésben
idézni lehet — az uuid-t senki nem mondja ki hangosan.

**Amit egy sikertelen belépés NEM tartalmaz:** a megadott azonosítót. Nem
létező fióknál az nem a fiók előzménye, hanem egy idegen által begépelt szöveg
— lehet elgépelt e-mail-cím vagy egy másik oldal jelszava. A metaadat csak
annyit mond: `bad_password` vagy `no_such_account`.

### Hol van ez a `security_logs`-hoz képest

Ugyanaz az esemény **mindkettőbe** bekerül, és ez szándékos:

| | `security_logs` | `account_events` |
|---|---|---|
| kérdés | „ki próbálkozott" | „mi történt ezzel a fiókkal" |
| IP | igen | nem |
| hivatkozási szám | nincs | van (`LOGIN_000182`) |
| kinek mutatható | `security.manage` | `analytics.accounts` — és elvben a fiók tulajdonosának is |

## 5. Adminisztrátori műveletek

**Hova:** `audit_logs` (már létezett; lásd `modules/audit/audit.ts`).

Minden művelet rögzíti: ki, mit, min, mikor, mi volt előtte, mi lett utána — és
ahol a felület megköveteli, az **indoklást** is. Indoklás nélkül a mentés
visszaállítása, a sebességkorlát átírása és a vészkapcsolók átbillentése el sem
indul.

## 6. Hibák és teljesítmény

| adat | tábla | ki írja |
|---|---|---|
| hibák, csoportosítva | `error_groups`, `error_logs` | az API hibakezelője |
| végpontok válaszideje | `performance_metrics` | az API, címkékkel (`route`) |
| gép és szolgáltatások | `system_metrics`, `service_status` | a monitor worker, percenként |

Kérés-azonosító (`request_id`) köti össze a hármat: egy hibabejelentésből
megtalálható a naplósor és a fiókesemény is.
