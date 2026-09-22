# Adatvédelem a statisztikában

**Mit gyűjtünk, mit nem, meddig őrizzük, és miért éppen így.** Ez a
dokumentum a rendszer tényleges viselkedését írja le, nem szándékot: minden
állítás mögött kód vagy tábla áll, és a végén ott a hely, ahol ellenőrizhető.

---

## 1. A vezérelv

Egy látogatottsági kimutatáshoz **két dolog kell**: meg lehessen mondani,
hogy két kérés ugyanattól az embertől jött-e (különben minden oldalletöltés
külön „látogató"), és **ne lehessen megmondani, hogy ki az**.

A YUME ezt egy **napi sóval képzett hash**-sel oldja meg
(`apps/api/src/modules/analytics/visitor.ts`):

```
látogatói kulcs = sha256(IP + user-agent + a NAPI SÓ), 32 hexjegyre vágva
```

A só naponta cserélődik, és a régit **eldobjuk**
(`analytics_salt`, megőrzés: 2 nap). Ennek két következménye van:

* a napon belüli egyediséghez **elég** („ma hány ember járt itt");
* a napokon átívelő követéshez **nem elég** — és nem is tesszük azzá.

**Ennek ára van, és nem hallgatjuk el.** A „visszatérő látogató" ebből csak a
bejelentkezetteknél pontos, a heti „egyedi látogató" pedig **nem létezik**
ebben a rendszerben. Ezért hívják a heti összesítő oszlopát `visitor_days`-nek
(a napi egyediek összege), nem „egyedi látogatónak": ugyanaz a szám azzal a
címkével hazugság volna, méghozzá a hízelgő irányba — pont ezért nem venné
észre senki. Lásd `database/migrations/0073_analytics_periods.sql`.

## 2. Nyers IP-cím

**A látogatottsági táblákba sehol nem kerül.** Egy helyen van: a biztonsági
naplóban (`security_logs`), mert ott más a kérdés — „ki próbálkozott" —, és
ahhoz a cím maga kell.

Két lépcsőben tűnik el:

| Meddig | Mi történik | Környezeti változó |
|---|---|---|
| 30 nap | a **CÍM** törlődik, a sor marad | `SECURITY_LOG_IP_DAYS` |
| 365 nap | a **SOR** is törlődik | `SECURITY_LOG_RETENTION_DAYS` |

Miért két lépcső: „honnan próbálkoztak" napokban érdekes kérdés (a
szolgáltatók újraosztják a címeket, és ami ma egy támadóhoz vezetne, holnap
valaki máshoz), „mi történt ezzel a fiókkal" viszont hónapokban — és arra az
esemény cím nélkül is teljes válasz.

## 3. Sütik

**Nincs analitikai süti.** A látogatói kulcs a kiszolgálón áll elő, kérésenként
újraszámolva; a böngészőben nem marad semmi, amiből visszakereshető lenne.

## 4. Megőrzési idők

Mind környezeti változóból jön, és a felület **Adatminőség** füle ki is írja,
melyik forrásra mennyi érvényes.

| Adat | Alapértelmezés | Változó |
|---|---|---|
| nyers oldalletöltés | 90 nap | `ANALYTICS_RAW_RETENTION_DAYS` |
| munkamenet | 90 nap | `ANALYTICS_SESSION_RETENTION_DAYS` |
| **nyers keresőkifejezés** | 30 nap | `ANALYTICS_SEARCH_RAW_DAYS` |
| fiókesemény | 365 nap | `ACCOUNT_EVENT_RETENTION_DAYS` |
| biztonsági napló | 365 nap | `SECURITY_LOG_RETENTION_DAYS` |
| Discord-frissítési esemény | 30 nap | `DISCORD_EVENT_RETENTION_DAYS` |
| napi/heti/havi összesítő | **nem nyesődik** | — |

A nyers keresőkifejezés azért a legrövidebb, mert **személyes adat lehet**:
valaki a saját nevére keres. A normalizált alak marad, a nyers eltűnik.

**Aminek következménye van:** a nyers sorok eltűnése után bizonyos számok már
**nem számolhatók újra**. A heti/havi összesítő `unique_users_exact` mezője
pontosan ezt jelzi — ha hamis, a szám nem a nyers adatból jött.

## 5. A Discord oldala

A gateway **darabszámokat** gyűjt, semmi mást:

* **nincs** üzenetszöveg — a `MESSAGE_CONTENT` privilegizált intentet nem is
  kérjük, és nélküle az esemény `content` mezője üres;
* **nincs** szerzőazonosító — csak annyi, hogy bot volt-e;
* **nincs** jelenlét;
* **nincs** taglista.

A séma nem is tud ilyet tárolni, és ezt egy teszt őrzi
(`test/discord-gateway.test.ts` → „semmilyen szöveget vagy szerzőt nem
tárol"): a `discord_message_stats_daily` és a `discord_member_stats_daily`
oszlopai között nem lehet `content`, `author`, `user_id`, `message_id` vagy
`username`.

Az **OAuth**-ból két dolgot kérünk (`identify`, `guilds`): a Discord-azonosítót
és a szerverek listáját. A hozzáférési tokent **nem tároljuk** — egyszer
lekérdezünk vele, aztán eldobjuk; ezt is teszt őrzi.

## 6. Hol ellenőrizhető

| Állítás | Hol |
|---|---|
| napi só, eldobás | `apps/api/src/modules/analytics/visitor.ts`, `analytics_salt` |
| megőrzés | `apps/api/src/modules/analytics/rollup.ts` → `RETENTION` |
| IP-maszkolás | `rollup.ts` → `pruneAnalytics()` |
| a Discord nem tárol tartalmat | `database/migrations/0074_discord_gateway.sql` |
| a token nem kerül naplóba | `apps/api/src/modules/discord/rest-client.ts` |
| élő állapot | admin → Statisztika → **Adatminőség** fül |

## 7. Amit egy látogató kérhet

A `account_events` tábla **fiókra bontva** tartalmazza, mi történt egy
felhasználóval (regisztráció, belépés, jelszóváltás). Ez az a nézet, amit egy
adatkikérési kérésre ki lehet adni: `GET /v1/admin/analytics/accounts/:userId`,
külön jogosultsággal (`analytics.accounts`) — mert ez **személyes adat**, és
más kérdés, mint a látogatottság.

A látogatottsági táblákból **nem lehet** egy embert kikeresni: a napi kulcs
másnap már nem azonosítja, és a só sincs meg hozzá.
