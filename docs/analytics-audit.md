# Analytics-audit — mi van, mi hiányzik, mi mibe kerül

**Állapot:** read-only audit. Ez a dokumentum a kérés 2. pontjának terméke, és
kódmódosítás előtt készült. Dátum: 2026-09-21.

A vizsgálat módszere: a repository és a **futó éles rendszer** együttes
olvasása — séma, adatmennyiség, konténerek, reverse proxy. Ahol számot írok,
az mérés, nem becslés.

---

## 0. A legfontosabb megállapítás elöl

A kérés két rendszert ír le. A kettő **nem egy nagyságrendben van**:

| | Mi a helyzet |
|---|---|
| **Webes analitika** (4–6. pont) | **Nagyrészt MEGVAN**, és érett. Ez bővítés, nem építés. |
| **Discord analitika** (7–11. pont) | **NULLÁRÓL indul. Nincs Discord bot.** |

A Discord-integrációt ebben a projektben **egyszer már megépítették, majd
szándékosan visszavonták**. A `database/migrations/0028_drop_discord_messages.sql`
saját szövege mondja ki:

> „The Discord integration was reverted. […] It held only a mapping from a
> purpose key to a Discord message id"

Az akkor eldobott `discord_messages` tábla **pontosan az a registry**, amit a
10.3. pont most újra kér. Ez nem érv az ellen, hogy megépüljön — de tudni kell
róla, mert egy korábbi döntés visszafordításáról van szó, nem új területről.

Mérve, ma:

- `discord.js` / `@discordjs/*` / bármilyen Discord-könyvtár: **egyetlen
  `package.json`-ban sincs**
- Discord bot konténer: **nincs**, sem futó, sem leállított (`docker ps -a`)
- Discord környezeti változó (token, client id, guild): **egy sem**
- `discord.animehub.hu` a reverse proxyban: **nincs**. A Caddy négy nevet
  szolgál ki: `animehub.hu`, `www.animehub.hu`, `yumee.duckdns.org`,
  `yonagifansub.duckdns.org`, `api.animehub.hu`

Az **egyetlen** meglévő Discord-kapcsolat **kimenő webhook**: egyirányú,
`discord` formátumú embed, bot nélkül, gateway nélkül, guild-hozzáférés nélkül.

---

## 1. Jelenlegi architektúra

**Monorepo**, npm workspaces: `apps/api`, `apps/web`, `packages/*`.

| Réteg | Mi | Megjegyzés |
|---|---|---|
| API | Fastify + `@fastify/jwt`, `cookie`, `cors`, `rate-limit`, `static`, `websocket`, mercurius (GraphQL) | 33 modul a `src/modules/` alatt |
| Web | Keretrendszer nélküli ES-modulok, saját hash-router, build lépés nélkül | `apps/web/src` |
| Adatbázis | PostgreSQL 16, ORM **nincs** — nyers SQL a `infrastructure/database` fölött | verziózott migrációk a `database/migrations/`-ban (0066-ig) |
| Sor | **Postgres-alapú** feladatsor (`infrastructure/queue`) | nem RabbitMQ; az `service_status` szerint a RabbitMQ `not_configured` |
| Redis | a compose-ban **van**, de `--profile infra` mögött, **alapból kikapcsolva** | `service_status`: `redis = not_configured` |
| Megfigyelés | `infrastructure/observability/{host-metrics,probes}.ts` | ebből él a `service_status` |
| Proxy | Caddy, a repón kívüli közös `Caddyfile`-ban, jelölők közé generálva | `scripts/reverse-proxy/install.sh` |

**Fontos következmény:** a rendszer ma **Redis nélkül** működik, és a sorozás
Postgresen megy. A kérés 15. pontja Redis-cache-t és elosztott lockot említ —
ez ma nem adottság, hanem új infrastruktúra lenne.

---

## 2. Meglévő analitika — részletesen

A `apps/api/src/modules/analytics/` **nyolc fájl, ~1630 sor**, és a
tervezési elvei egybeesnek a kérés 13. pontjával:

| Fájl | Mit csinál |
|---|---|
| `collect-routes.ts` | `/v1/analytics` — az **egyetlen** végpont, amit a kliens hív, és **pontosan egy dolgot** fogadhat el tőle: melyik oldalra lépett. Minden más szerveroldali. |
| `collector.ts` | Memóriában gyűlik, **kötegben** megy ki (`ANALYTICS_BUFFER=500`, `ANALYTICS_FLUSH_MS=5000`). Az írás **nincs a kérési úton**. Deduplikáció: 20 000 kulcsos ablak. |
| `visitor.ts` | **Napi sóval képzett hash** — a napon belüli egyediséghez elég, a napokon átívelő követéshez szándékosan nem. Nincs süti, nincs kliensoldali azonosító. |
| `rollup.ts` | Napi/óránkénti összesítés, **idempotens** (`INSERT … ON CONFLICT DO UPDATE` a frissen számolt értékre, nem hozzáadás). Megőrzés-nyesés is itt. |
| `admin-routes.ts` | 10 olvasó végpont. Szabály: **a panel nem olvas nyers eseménytáblát**, csak összesítőt — kivéve az élő nézetet (5 perces ablak). |
| `account-events.ts` | Fiókesemények sorszámozva (`REG_000001`, `LOGIN_000182`) — a `security_logs`-tól **szándékosan külön**, más megőrzéssel és más láthatósággal. |
| `worker.ts` | Az összesítő külön feladatsor-típus, hogy egy lassú összesítés ne tartson fel egy felhasználói frissítést. |

### Meglévő végpontok (`/v1/admin/analytics`)

```
GET /visitors     GET /breakdown   GET /realtime    GET /anime
GET /anime/:id    GET /search      GET /performance GET /accounts/:userId
GET /users        GET /export
```

### Meglévő admin felület

`apps/web/src/pages/admin.js` — statisztika szekció **öt füllel**:
`Látogatók`, `Címek`, `Keresés`, `Fiókok`, `Teljesítmény`; időszakválasztóval,
KPI-kártyákkal, **előző időszakhoz hasonlítással**, élő nézettel.

### Jogosultságok (már léteznek)

```
analytics.view      analytics.accounts   analytics.configure   analytics.export
admin.analytics.view  audit.read/view    audit_log.view/export
search_stat.view/export/purge   stats_daily.view/recompute
profile_stats.view/recalculate
```

### Megőrzés (már konfigurálható)

| Adat | Alapérték | Változó |
|---|---|---|
| nyers oldalletöltés | 90 nap | `ANALYTICS_RAW_RETENTION_DAYS` |
| munkamenet | 90 nap | `ANALYTICS_SESSION_RETENTION_DAYS` |
| nyers keresés | 30 nap | `ANALYTICS_SEARCH_RAW_DAYS` |
| fiókesemény | 365 nap | `ACCOUNT_EVENT_RETENTION_DAYS` |
| biztonsági napló IP-je | 30 nap | `SECURITY_LOG_IP_DAYS` |
| biztonsági napló | 365 nap | `SECURITY_LOG_RETENTION_DAYS` |

---

## 3. Meglévő adatforrások — a 2.2. pont ellenőrzése

A kérés felsorolását tételesen végigmértem az **éles** adatbázison:

| Kért adat | Van? | Hol | Éles sorok |
|---|---|---|---|
| Animek száma | ✅ | `anime` | — |
| Epizódok száma | ✅ | `episodes` | — |
| Felhasználók száma | ✅ | `users` | — |
| Regisztrációk | ✅ | `account_events` (particionált) | 216 |
| Bejelentkezések | ✅ | `account_events`, `security_logs` | 15 614 |
| Anime megtekintések | ✅ | `anime_stats_daily` | 32 |
| Epizódmegnyitások | ✅ | `episode_stats_daily`, `watch_stats_daily` | — |
| Watchlist műveletek | ✅ | `library`, `xp_events` | — |
| Keresések | ✅ | `search_stats` (particionált) | — |
| Provider-használat | ✅ | `provider_events` | — |
| Hibák | ✅ | `error_groups`, `error_logs` (particionált) | 23 csoport |
| API-kérések / késleltetés | ✅ | `performance_metrics` (particionált) | — |
| Rendszerállapot | ✅ | `service_status`, `system_metrics`, `system_metrics_hourly` | 7 komponens |
| Discord **webhook**-események | ✅ | `webhooks`, `webhook_deliveries` | 1 651 kézbesítés |
| Discord **bot**-események | ❌ | — | nincs bot |
| Guild adatok | ❌ | — | nincs bot |
| Discord tagok | ❌ | — | nincs bot |
| Parancshasználat | ❌ | — | nincs bot |
| Notification események | ⚠️ részben | `notifications` modul megvan, de **Discord-oldali** kézbesítési metrika nincs | — |

**A séma particionált**: `account_events`, `audit_logs`, `error_logs`,
`performance_metrics`, `search_stats`, `system_metrics` mind havi partíciókkal
futnak. Ez a 15. pont skálázhatósági elvárásának már megfelel.

---

## 4. Ami hiányzik

### 4.1. Webes oldalon (kicsi, jól körülhatárolt)

1. **Content Analytics** (6.2.) — a legtöbbje megvan (`anime_stats_daily`,
   `search_stats`), de „legtöbbet keresett + watchlisthez adott + kedvelt"
   egy nézetben nincs összefogva.
2. **Provider Analytics** (6.3.) — `provider_events` létezik, **panel nincs
   rá**. Ez a legkisebb munka a legnagyobb haszonnal: a szolgáltatólánc
   állapota ma csak naplóból olvasható.
3. **System Health panel** (6.4.) — a `service_status` adat megvan, a
   dedikált panel nincs.
4. **Export / időzóna / „nulla bázisú százalék"** finomítások (5.1., 5.2.).

### 4.2. Discord oldalon (teljes rendszer, nulláról)

Ami **nem létezik és meg kellene építeni**:

- Discord alkalmazás és bot **a Discord fejlesztői portálon** (ez nem kód)
- `discord.js` függőség és egy **gateway-folyamat** (állandó WebSocket)
- **Új konténer** a compose-ban, saját életciklussal és health checkkel
- **Discord OAuth** a guild-hozzáféréshez, a YUME-fiókhoz kötve
- `discord.animehub.hu` **új név a reverse proxyban** (ma nincs)
- Guild/tag/parancs/notification **metrikatáblák + aggregáció**
- `persistent_messages` registry (10.3.) — **a 0028-ban eldobott tábla utódja**
- Elosztott lock a több bot-példányhoz — **ma nincs Redis**, tehát vagy
  Postgres advisory lock, vagy Redis bekapcsolása

---

## 5. Adatduplikációs kockázatok

1. **`security_logs` vs `account_events`** — mindkettő rögzít bejelentkezést.
   Ez **szándékos** (más kérdésre válaszolnak, más megőrzéssel), de egy
   „bejelentkezések" grafikonnál el kell dönteni, melyik a forrás. Ha mindkettő,
   a szám duplázódik.
2. **`anime_stats_daily` vs `watch_stats_daily` vs `episode_stats_daily`** —
   átfedő fogalmak. A „megtekintés" definícióját **ki kell írni**, különben a
   KPI-kártya és a grafikon mást mutat ugyanarra.
3. **Discord notification vs webhook** — ha a bot is küld értesítést és a
   webhook is, ugyanaz az esemény kétszer jelenne meg a statisztikában.
4. **`system_metrics` vs `system_metrics_hourly`** — nyers és összesített
   ugyanarról; keverésük kétszeres számot ad.

---

## 6. Biztonsági megállapítások

**Ami már jól van megoldva** (nem kell újraépíteni):

- A gyűjtő végpont a klienstől **egyetlen** mezőt fogad el — a hamisítható
  „megnézés"-számlálás eleve ki van zárva.
- A látogatóazonosítás **napi sóval hasheltt**, süti nélkül.
- A nyers IP megőrzése **külön, rövidebb** (30 nap) a naplóénál (365).
- A jogosultságok **szerveroldalon** érvényesülnek, és a session-kezelés kész.

**Amire a Discord-rész miatt figyelni kell:**

1. **Bot token**: soha nem mehet a frontendre, és a repóba sem. A projektben
   már van erre gyakorlat (`.env`, `scrub.ts`, a webhook-titkok sosem térnek
   vissza a válaszban).
2. **Guild-jogosultság nem gyorsítótárazható korlátlanul** (7.2.) — a Discord
   oldalán bármikor elvehetik. Minden érzékeny művelet előtt friss ellenőrzés.
3. **Guild-adatok szeparációja**: egy szerver adminja **csak a saját** guildjét
   láthatja. Ez a legkönnyebben elrontható pont; szerveroldali szűrés kell,
   nem frontend.
4. **Tagszintű viselkedési profil**: a 8.4. maga is kimondja, hogy aggregálni
   kell. Egy „ki mennyit írt" lista megfigyelési eszköz — alapból nem készül.
5. **SSRF**: már van `infrastructure/http/ssrf.ts`, a webhook-kézbesítés
   használja. Discord API-hívásoknál ugyanezt kell.

---

## 7. Javasolt migrációs stratégia

A meglévő rendszert **nem bontjuk meg**. A kérés 20. pontja is ezt mondja
(„Ne változtasd meg a meglévő YUME működését csak azért, mert egy új
architektúra egyszerűbbnek tűnik").

- A webes analitika **bővül**, nem cserélődik: új végpontok a meglévő
  `/v1/admin/analytics` prefix alatt, új fülek a meglévő panelen.
- Minden új tábla **additív migráció**, `IF NOT EXISTS`, destruktív lépés
  nélkül.
- A Discord-rész **külön modul** (`modules/discord/`), és a bot **külön
  szolgáltatás** — mert egy állandó gateway-kapcsolat más életciklus, mint egy
  HTTP-kiszolgáló, és egy bot-újraindítás nem állíthatja meg a weboldalt.
- A meglévő **webhook-rendszer marad**; a bot nem váltja ki azonnal (20. pont).

---

## 8. Implementációs sorrend

| Fázis | Tartalom | Függ tőlem? |
|---|---|---|
| **1. Audit** | ez a dokumentum | ✅ kész |
| **2. Provider + System Health panel** | a meglévő `provider_events` és `service_status` adatra; **nincs új adatgyűjtés** | ✅ önállóan mehet |
| **3. Content/User analytics kiegészítés** | a meglévő összesítőkre | ✅ önállóan mehet |
| **4. Discord alkalmazás + bot váz** | discord.js, gateway, konténer, health | ❌ **kell tőled**: Discord alkalmazás + bot token |
| **5. Discord OAuth + guild permission** | a YUME-fiókhoz kötve | ❌ kell tőled: OAuth client id/secret, redirect URI |
| **6. Guild metrikák + aggregáció** | tagok, parancsok, üzenetszám | a 4–5. után |
| **7. Persistent Message Engine** | registry, hash, lock, retry, recovery | a 4–6. után |
| **8. Dashboard + tesztek** | UI, E2E, terheléses mérés | a végén |

**A 4. fázistól kezdve a munka nem tud elindulni nélküled**, mert:
- a bot tokent **nem tudom és nem is szabad kitalálnom**,
- a Discord alkalmazást a te fiókodban kell létrehozni,
- a `discord.animehub.hu` névhez DNS-rekord kell — a DNS-hez pedig a saját
  szabályod szerint nem nyúlok automatikusan.

---

## 9. A módosítandó fájlok listája (2–3. fázis)

**Backend**
- `apps/api/src/modules/analytics/admin-routes.ts` — új olvasó végpontok
- `apps/api/src/modules/providers/` — a `provider_events` olvasása panelhez
- `apps/api/src/modules/system/dashboard.ts` — health összegzés
- `database/migrations/0067_*.sql` — indexek, ha a mérés indokolja

**Frontend**
- `apps/web/src/pages/admin.js` — új fülek (`Szolgáltatók`, `Rendszer`)
- `apps/web/css/admin.css` — a kártyák és grafikonok stílusa

**Tesztek**
- `apps/api/test/analytics-*.test.ts`
- `tests/e2e/analytics-*.test.mjs`

---

## 10. Ismert korlátozások (ma)

1. **Nincs Redis** — a 15. pont Redis-cache-e és elosztott lockja ma nem
   adottság. Postgres advisory lock kiváltja, de ezt ki kell mondani.
2. **A `service_status` négy komponenst `not_configured`-ként jelent**
   (redis, rabbitmq, opensearch, minio). Ezeket a health panelen nem szabad
   „hibás"-ként mutatni — ez nem hiba, hanem „nincs bekapcsolva".
3. **Az `analytics_daily` ma 8 sor** — a rendszer fiatal. A 90 napos
   grafikonok jó darabig „nincs elegendő történelmi adat" állapotot fognak
   mutatni, és ez a helyes viselkedés (8.3.), nem hiba.
