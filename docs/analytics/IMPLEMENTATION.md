# Hol van mi

A látogatottsági és terhelésmérő rendszer kódtérképe. Ha valamit módosítani
kell, ez mondja meg, hol.

## Kiszolgáló

| fájl | mi |
|---|---|
| `apps/api/src/modules/analytics/visitor.ts` | napi só, látogatói kulcs, böngésző/eszköz felismerés, képernyősáv, hivatkozó |
| `apps/api/src/modules/analytics/collector.ts` | memóriapuffer, duplikátumszűrés, kötegelt kiírás |
| `apps/api/src/modules/analytics/collect-routes.ts` | `POST /v1/analytics/view` — az egyetlen végpont, amit a kliens hív |
| `apps/api/src/modules/analytics/rollup.ts` | napi összesítők és a megőrzési takarítás |
| `apps/api/src/modules/analytics/worker.ts` | az `analytics` feladatsor kezelője |
| `apps/api/src/modules/analytics/account-events.ts` | fiókesemények írása, olvasása, titokszűrés |
| `apps/api/src/modules/analytics/admin-routes.ts` | `/v1/admin/analytics/*` — a kimutatások és az export |
| `apps/api/src/modules/analytics/routes.ts` | **régi, nem az enyém**: `/badges`, `/analytics/dashboard`, `/analytics/overview`, `/errors`, `/audit` |
| `apps/api/src/middleware/load-test.ts` | a sebességkorlát alóli kivétel — három feltétel |

Módosított, meglévő fájlok:

| fájl | mi változott |
|---|---|
| `apps/api/src/modules/auth/routes.ts` | fiókesemények minden hitelesítési ponton; eszköz rögzítése a munkamenethez |
| `apps/api/src/modules/auth/repository.ts` | `rememberDevice()`, és a munkamenet megkapja a `device_id`-t |
| `apps/api/src/modules/library/routes.ts` | a nézés előzménye az **indítástól**, nem csak a befejezéstől |
| `apps/api/src/middleware/security.ts` | a korlátozó `allowList`-je ismeri a mérőforrást |
| `apps/api/src/modules/security/posture.ts` | `load-test-exemption` ellenőrzés |
| `apps/api/src/workers/index.ts` | `analytics` sor, óránkénti összesítés, napi takarítás |
| `apps/api/src/config.ts` | `loadTestKey`, `loadTestIps` |

## Kliens

| fájl | mi |
|---|---|
| `apps/web/src/shared/lib/analytics.js` | a jelzés: `pageView(route, entityId)` |
| `apps/web/src/app/router.js` | egyetlen hívás a `navigate()`-ben — minden útvonal innen jelez |
| `apps/web/src/shared/api/yume.js` | `analytics.view` és `admin.analytics.*` |
| `apps/web/src/pages/admin.js` | a `Látogatottság` szakasz öt füllel, és a felhasználói panel tevékenységblokkja |

## Adatbázis

`database/migrations/0051_analytics_foundations.sql`

Új: `analytics_sessions`, `analytics_daily`, `analytics_breakdown`,
`anime_stats_daily`, `episode_stats_daily`, `account_events` (particionált),
`analytics_salt`, `account_event_seq`.

Meglévő és használt: `page_views`, `search_stats`, `performance_metrics`,
`security_logs`, `watch_history`, `devices`, `audit_logs`.

## Végpontok

| végpont | jogosultság | mit ad |
|---|---|---|
| `POST /v1/analytics/view` | — (írási korlát alatt) | 204 |
| `GET /v1/admin/analytics/visitors` | `analytics.view` | napi sorok + összesítés + előző időszak |
| `GET /v1/admin/analytics/breakdown` | `analytics.view` | egy dimenzió bontása |
| `GET /v1/admin/analytics/realtime` | `analytics.view` | most: online, mai számok, top keresés/cím, biztonsági jelzések |
| `GET /v1/admin/analytics/anime` | `analytics.view` | címenkénti lista |
| `GET /v1/admin/analytics/anime/:id` | `analytics.view` | egy cím, epizódonkénti lemorzsolódással |
| `GET /v1/admin/analytics/search` | `analytics.view` | top és találat nélküli keresések |
| `GET /v1/admin/analytics/performance` | `analytics.view` | mérőszámok és a leglassabb végpontok |
| `GET /v1/admin/analytics/users` | `analytics.view` | globális felhasználói kimutatás |
| `GET /v1/admin/analytics/accounts/:userId` | `analytics.accounts` (rejtett) | egy fiók tevékenysége, munkamenetei, eszközei |
| `GET /v1/admin/analytics/export` | `analytics.export` (rejtett) | CSV/JSON, auditálva |

## Jogosultságok

`analytics.view`, `analytics.accounts`, `analytics.export` — mindhárom az
`admin` szerepkörhöz rendelve a migrációban.

## Környezeti változók

| változó | alapérték | mire |
|---|---|---|
| `ANALYTICS_BUFFER` | 500 | hány esemény után ürül a puffer |
| `ANALYTICS_FLUSH_MS` | 5000 | milyen gyakran ürül |
| `ANALYTICS_RAW_RETENTION_DAYS` | 90 | oldalletöltések megőrzése |
| `ANALYTICS_SESSION_RETENTION_DAYS` | 90 | látogatói munkamenetek |
| `ANALYTICS_SEARCH_RAW_DAYS` | 30 | a **nyers** keresőkifejezés anonimizálása |
| `ACCOUNT_EVENT_RETENTION_DAYS` | 365 | fiókesemények |
| `LOAD_TEST_KEY` | *nincs* | a sebességkorlát alóli kivétel kulcsa — éles telepítésen ne legyen beállítva |
| `LOAD_TEST_IPS` | `127.0.0.1,::1` | mely forráscímek mentesülhetnek |

## Terhelésmérés

| fájl | mi |
|---|---|
| `docker-compose.load.yml` | a mérőverem: app + worker + saját Postgres |
| `scripts/load/seed-db.sh` | az adatállomány az éles legfrissebb **ellenőrzött** mentéséből |
| `scripts/load/seed-users.mjs` | fiókok és valódi azonosítók a méréshez |
| `scripts/load/run.sh` | fokozatonkénti futtatás, mintavétellel és jelentéssel |
| `scripts/load/sample.mjs` | erőforrás-mintavétel 5 mp-enként (a meglévő host-metrikákkal) |
| `scripts/load/report.mjs` | a jelentés — csak mért számokból |
| `tests/load/main.js` | a vegyes forgalom, hét látogatótípussal |
| `tests/load/playback.js` | a lejátszás indítása (nem videóletöltés) |
| `tests/load/websocket.js` | socketkapacitás |

Részletek: [LOAD_TESTING.md](LOAD_TESTING.md).

## Tesztek

| fájl | mit köt ki |
|---|---|
| `apps/api/test/analytics.test.ts` | mit mondhat a kliens, mit nem; a kulcs napi cseréje; a duplikátumszűrés; az összesítő idempotenciája; a jogosultságok; hogy IP nem szivárog a tevékenységnézetbe |
| `apps/api/test/load-test-gate.test.ts` | a sebességkorlát-kivétel három feltétele, és hogy bármelyik hiánya megfogja |
