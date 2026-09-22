# Analytics + Discord — a hiánylista lezárása

**Módszer:** a repository és a **futó éles rendszer** együttes mérése. Ahol
szám szerepel, az mérés. Első felvétel: 2026-09-21. Lezárás: 2026-09-22.

**Állapotjelölés:** `COMPLETE` = DB → backend → API → jogosultság → felület →
valós adat → teszt → éles működés, végig. `PARTIAL` = a lánc egy része
hiányzik. `MISSING` = nincs. `BLOCKED` = nem rajtam múlik, és a blokkoló meg
van nevezve.

---

## 1. Ami a lista első felvétele óta elkészült

| Tétel | Volt | Most | Mérés |
|---|---|---|---|
| `discord.animehub.hu` | `MISSING` | `COMPLETE` | `HTTP 525` → `200`; a másik három név sértetlen |
| Discord bot/API a rendszerállapotban | `MISSING` | `COMPLETE` | két szonda, élesben zöld |
| **Discord OAuth** | `MISSING` | `COMPLETE` (kód) / `BLOCKED` (éles) | 20 teszt; a titok a felhasználónál |
| Persistent Message UI: create/edit/delete/test/recreate/history | `PARTIAL` | `COMPLETE` | 18 e2e-tétel a vezérlőpulton |
| Üzenettípus: `server_statistics` | `MISSING` | `COMPLETE` | élesben renderelve, valós Discord-létszámmal |
| `anime_schedule` | `MISSING` | `COMPLETE` | 176 címnél van jövőbeli adásidő |
| `popular_anime` | `MISSING` | `COMPLETE` | `anime_stats_daily`-ből |
| `bot_status` | `MISSING` | `COMPLETE` | élesben: `created → edited → skipped` |
| Heti/havi aggregáció | `MISSING` | `COMPLETE` | éles adaton: 2026-09-21-i hét = 13 munkamenet, 2 nap |
| Provider p50/p95/p99 | `MISSING` | `COMPLETE` | vödrös eloszlás, felső korlátként kiírva |
| Overview fül | `MISSING` | `COMPLETE` | `/summary` |
| Timeseries fül | `MISSING` | `COMPLETE` | napi/heti/havi, fehérlistás mérőszámmal |
| Data Quality fül | `MISSING` | `COMPLETE` | 15 forrás, hiányzó napok, megőrzés |
| **Egységes eseményséma** | `MISSING` | `COMPLETE` | `analytics_events`, zárt típusszótár |
| Idempotencia / dedupe | `PARTIAL` | `COMPLETE` | kétrétegű: pontos memóriában, vödrös az adatbázisban |
| Keresés → megnyitás konverzió | `MISSING` | `COMPLETE` | e2e-ben, kattintástól az adatbázisig |
| **Discord Gateway** | `MISSING` | `COMPLETE` | élesben `ready`, `intents=513`, létszám gyűjtve |
| Guild overview / channel / role | `MISSING` | `COMPLETE` | REST-ből, privilegizált intent nélkül |
| Member analytics | `MISSING` | `PARTIAL` | napi létszám megvan; a MOZGÁS privilegizált intentet kér |
| Message analytics | `MISSING` | `COMPLETE` | gateway gyűjti, csatornánként |
| Notification analytics | `PARTIAL` | `COMPLETE` | `webhook_deliveries`-ből |
| Bot health | `PARTIAL` | `COMPLETE` | szondák + 24 órás eseménybontás |
| Terheléses teszt | `MISSING` | `COMPLETE` | négy fokozat, valódi számokkal |
| `docs/analytics-privacy.md` | `MISSING` | `COMPLETE` | — |
| `docs/analytics-architecture.md` | `MISSING` | `COMPLETE` | — |
| `docs/analytics-api.md` | `MISSING` | `COMPLETE` | — |
| `docs/discord-dashboard.md` | `MISSING` | `COMPLETE` | — |
| `docs/discord-gateway.md` | `MISSING` | `COMPLETE` | — |
| `docs/persistent-messages.md` | `MISSING` | `COMPLETE` | — |
| `docs/analytics-load-testing.md` | `MISSING` | `COMPLETE` | mért számokkal |
| `docs/analytics-deployment.md` | `MISSING` | `COMPLETE` | — |

## 2. A Discord-rész kiköltözött a YUME adminpaneljéből

Nem átnevezés: **saját alkalmazás** (`apps/discord`), amit ugyanez a
kiszolgáló ad a `/dashboard` előtag alatt, és a Caddy a
`discord.animehub.hu` gyökerére ír át.

**Miért:** más a közönsége és más a jogcíme. Oda az is beléphet, akinek a
YUME-ban NINCS admin jogosultsága, csak a Discord-szerverén van „Szerver
kezelése" joga — és egy ilyen embernek nem kell, és nem is szabad látnia a
katalógust, a felhasználókat vagy a moderációt.

A YUME adminpaneljében a `webhooks` maradt: az a YUME **saját** kimenő
értesítése, nem a Discord-bot vezérlése. Ezt teszt őrzi.

## 3. Ami továbbra sem teljes — és miért

| Tétel | Állapot | Miért |
|---|---|---|
| **OAuth éles próbája** | `BLOCKED` | kell a `DISCORD_CLIENT_SECRET` és a visszairányítási cím regisztrálása a fejlesztői portálon. A kód kész és tesztelt; élesben nem próbálható ki |
| **Tagmozgás (belépés/kilépés)** | `BLOCKED` | `GUILD_MEMBERS` privilegizált intent kell, a portálon engedélyezve. Enélkül a Discord a CSATLAKOZÁST utasítja vissza, tehát nem kevesebb adat jönne, hanem semmi |
| **Parancsstatisztika** | `MISSING` | a botnak nincs egyetlen slash-parancsa sem. Nem azért üres, mert nem gyűjtjük — nincs, amit használni lehetne |
| **Történelmi analitika** | idő kérdése | az `analytics_daily` ma 9 sor. A 30/90/365 napos nézetek addig „nincs elegendő adat" állapotot mutatnak, amíg a rendszer nem gyűjtött annyit. Ez nem hiba, hanem követelmény |
| **Gateway-adat visszamenőleg** | nem létezik | az üzenet és a tagmozgás ESEMÉNY; a Discord akkor küldi, amikor megtörténik. Ami nem volt begyűjtve, az nincs |
| Drop-off, retenciós kohorsz | `MISSING` | önálló feladat, nem ennek a körnek a része |
| Docker-konténer-állapot a health panelen | `MISSING` | a konténerállapot a Docker socketjét igényelné — az a workernek adott jogosultság, amit nem érdemes megnyitni egy panelért |

## 4. Amit a munka közben a MÉRÉS talált meg

Nem feltételezés, hanem elbukott mérés:

1. **`/overview` névütközés** — az előtagon már létezett; a Fastify el sem
   indult, és a teljes analitikai készlet elhasalt. A figyelmeztetés húsz
   sorral följebb állt ugyanabban a fájlban.
2. **Fel nem használt `$2`** — a Postgres nem tudta kikövetkeztetni a
   típusát, és az egész kérés 500-zal állt meg.
3. **Az időoszlop neve táblánként más** — a legtöbb `created_at`, nem `at`.
4. **`'week 1'` nem intervallum** — az `'1 week'` az; ettől minden heti sor
   nullát mutatott.
5. **Két adminfelület egy lapon** — két egyidejű navigáció csúszott egymásba;
   öt e2e-tétel bukott el tőle úgy, hogy a felület hibátlan volt.
6. **A `fastify-static` könyvtárkérésre 403-at ad**, nem lapot.
7. **Abszolút `/src/app.js`** a vezérlőpult lapján a webkliens könyvtárába
   mutatott.
8. **A beállítatlan OAuth elrejtette a MÁR meglévő összekötést** is.
9. **A vödrös dedupe a határon átereszt** — két kattintás két másodperccel
   két szeletbe eshet. Innen a kétrétegű megoldás.
10. **Egy ottfelejtett `provider_metrics_daily` sor** elrontott egy másik
    készletet: a beégetett `187` helyett a szabályt kell mérni.
11. **A lejátszó „angol" hibaüzenete** nem a terméké volt: a próba egy MÁSIK
    modulpéldányt nézett (bélyegzett vs. közvetlen cím).

## 5. Számok, a lezáráskor

| | |
|---|---|
| API-teszt | **1552** |
| webteszt | **715** |
| e2e-teszt | **134** |
| migráció | 0075-ig, mind additív |
| új leírás | 8 |
| Discord-üzenettípus | 8 |
| vezérlőpult-nézet | 11 |

## 6. Mi kell a felhasználótól

1. **`DISCORD_CLIENT_SECRET`** (és `DISCORD_CLIENT_ID`) a `/opt/yume/.env`-be,
   valamint a `https://discord.animehub.hu/v1/discord/oauth/callback` cím
   regisztrálása a Discord fejlesztői portálon → ezzel az OAuth élesben is
   működik.
2. Ha kell a tagmozgás: **`GUILD_MEMBERS`** engedélyezése a portálon, majd
   `DISCORD_GUILD_MEMBERS_INTENT=true` és a gateway újraindítása.
3. Minden más megy magától.
