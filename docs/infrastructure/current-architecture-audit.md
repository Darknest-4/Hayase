# YUME — jelenlegi architektúra, audit

**Dátum:** 2026-09-21 · **Állapot:** csak felmérés, kódmódosítás nélkül.

Ez a dokumentum azt írja le, ami **van**, nem azt, aminek lennie kéne. Minden
állítás mögött parancs vagy fájlhivatkozás áll; ahol nem tudtam megmérni, ott
kimondom.

---

## 0. Három feltevés, amit a felmérés megcáfolt

A feladatleírás olyan rendszert ír le, ami itt nem ez. Mielőtt bármi másról szó
esne, ezt tisztázni kell, mert a terv nagy része ezen áll vagy bukik.

| a leírás szerint | a valóság |
|---|---|
| APP = Next.js, külön szolgáltatás | **nincs külön APP szolgáltatás.** `apps/web` keretrendszer nélküli, build nélküli ES-modul kliens, statikus fájlokként; az **API konténer szolgálja ki** (`@fastify/static`, `apps/api/src/app.ts`) |
| Redis fut és használatban van | **a kód nem használ Redist.** Nincs kliens könyvtár a `package.json`-ökben; a `REDIS_URL` egyetlen hatása egy TCP-próba (`observability/probes.ts`). A compose `redis` szolgáltatása `infra` profil mögött van, és **nem fut** |
| Discord bot szolgáltatás | **nincs bot a repóban és nem fut ilyen konténer.** A „discord" találatok kimenő webhookok. A Caddyfile viszont két helyen `reverse_proxy yume-bot-1:4100`-ra irányít — **ezek az útvonalak halottak** |

Ebből következik: az „APP VPS / API VPS" szétválasztás ma **nem konfigurációs
kérdés**, hanem az első valódi fejlesztési feladat (lásd 6.1).

---

## 1. Jelenlegi architektúra

### Ami tényleg fut

```
Internet → Cloudflare → yonagi-caddy-1 (:80, :443)
                              │  „web" Docker-hálózat
                              ▼
                        yume-app-1  (API + statikus webkliens, :4000, nem publikált)
                              │  „yume_default" hálózat
                              ├── yume-postgres-1   (:5432, nem publikált)
                              ├── yume-worker-1     (port nélkül)
                              └── yume-backup-1     (cron, port nélkül)

                        pgfwd (socat) → 127.0.0.1:15432 → postgres:5432
```

Mérve: `docker ps --filter name=yume --format '{{.Names}}: {{.Ports}}'`

```
yume-app-1: 4000/tcp        yume-worker-1: 4000/tcp
yume-postgres-1: 5432/tcp   yume-backup-1: 5432/tcp
```

**Egyetlen YUME konténer sem publikál portot a gazdagépre.** A `4000/tcp` és a
`5432/tcp` kitett (`EXPOSE`), nem publikált — kívülről nem érhető el.

### A gépen futó többi rendszer

`yonagi-app-1`, `yonagi-db-1`, `yonagi-redis-1`, `yonagi-caddy-1`, `anivexa-api`.
A Caddy **közös**: nem a YUME repóból jön, hanem `/opt/YonagiFansub/Caddyfile`-ból,
és három oldalt szolgál ki. A repóban lévő `infrastructure/reverse-proxy/Caddyfile`
**nincs használatban** (a `caddy` szolgáltatás `profiles: ['disabled']` az
override-ban).

### Hálózatok

| hálózat | tagok | megjegyzés |
|---|---|---|
| `yume_default` | app, worker, postgres, backup, pgfwd | belső |
| `web` (külső) | **csak az app**, `yume-app` alias | ezen át éri el a Caddy |

**A Postgres nincs rajta a `web` hálózaton** — a Caddy és a másik két projekt
nem éri el. Ez helyes, és a szétválasztás szempontjából jó kiindulás.

---

## 2. Szolgáltatások és függőségeik

```
caddy (idegen projekté)
   └── app ──┬── postgres        (kötelező)
             ├── R2 / Cloudflare (kép- és videótár, opcionális)
             └── Turnstile       (emberpróba, opcionális)

worker ──┬── postgres            (kötelező)
         ├── R2                  (képtükrözés)
         └── AniList / Jikan / ani.zip (metaadat)

backup ──── postgres → `backups` kötet → R2 (`BACKUP_SYNC_CMD`)

redis ── SENKI (infra profil, nem fut)
bot   ── nem létezik
```

Az `app` és a `worker` **ugyanabból a képből** épül (`build: .`), csak a
parancsuk más. Ez egyszerű és jó; a szétválasztásnak nem akadálya.

---

## 3. Ami a szétválasztásra **már készen áll**

Ez a rész fontosabb, mint a hibalista: sok munka már el van végezve.

| terület | állapot | bizonyíték |
|---|---|---|
| bedrótozott szolgáltatás-címek az API-ban | **nincs** | a `localhost`/`127.0.0.1` találatok mind hurokcím-felismerés, SSRF-védelem vagy WAF-minta |
| adatbázis-cím | `DATABASE_URL`-ből | `docker-compose.yml`, `config.ts` |
| migrációk párhuzamossága | **advisory lock** | `migrate.ts:53` `pg_advisory_lock` |
| feladatsor párhuzamossága | **`FOR UPDATE SKIP LOCKED`** | `infrastructure/queue/index.ts:122` |
| WebSocket több példány közt | **Postgres LISTEN/NOTIFY** | `infrastructure/pubsub/index.ts` — kimondottan Redis helyett |
| liveness / readiness szétválasztva | **igen** | `GET /v1/health` → `{"status":"ok"}`; `GET /v1/health/ready` → függőségenkénti állapot, titok nélkül |
| lokális fájlírás az alkalmazásból | **nincs** | egyetlen `writeFile`/`createWriteStream` sincs az `apps/api/src`-ben; a média R2-be megy |
| adatbázis-port kitettsége | **nincs publikálva** | `docker ps` |
| konténer-megkeményítés (app, worker) | `no-new-privileges`, `cap_drop: ALL`, `USER node` | `docker-compose.yml`, `Dockerfile:76` |
| CORS éles alapértelmezése | azonos origó, `*` visszautasítva | `config.ts:corsOrigins()` |

---

## 4. Hibák, kockázatok, szétválasztást akadályozó részek

### 4.1 A kliens azonos origót feltételez — **ez az APP/API szétválasztás fő akadálya**

`apps/web/src/shared/api/yume.js:11`

```js
base () {
  const saved = localStorage.getItem('yume-api')
  if (saved) return saved
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    return window.location.origin      // ← ide
  }
  return 'http://localhost:4000'
}
```

Külön APP VPS-en a kliens a saját origójára hívna, ahol nincs API. Van
felülbíráló (`localStorage`), de az nem telepítési eszköz.

**Kockázat:** közepes. **Javítás:** a kiszolgált `index.html`-be injektált
API-alap (a lap már most a kiszolgálón készül, `app.ts` `servePage`), plusz
`CORS_ORIGINS` beállítása. Nem igényel routercserét.

### 4.2 A worker a **teljes gazdagép fájlrendszerét** csatolja

`docker-compose.yml:170` — `- /:/host:ro`

Egyetlen `statfs('/host')` hívás miatt (`host-metrics.ts:114`), hogy a lemez
telítettsége a gazdagépé legyen, ne az overlay-é. Ennek ára, hogy a worker
folyamat **olvasni tudja a gép minden fájlját** — köztük a `/opt/YonagiFansub`
és az `anivexa` `.env` fájljait, és az SSH-kulcsokat.

**Kockázat:** magas. **Javítás:** egyetlen üres könyvtár csatolása, ami
ugyanazon a fájlrendszeren van (a `statfs` a fájlrendszert méri, nem az utat).
Ugyanaz a szám, nulla kitettséggel.

### 4.3 A Caddy halott végpontra irányít

`/opt/YonagiFansub/Caddyfile:89` és `:134` — `reverse_proxy yume-bot-1:4100`,
de ilyen konténer nincs. Az `/interactions` útvonal mindkét gazdanéven 502-t ad.

**Kockázat:** alacsony (nem használt útvonal). **Javítás:** vagy a bot
megépítése, vagy az útvonal eltávolítása — de a Caddyfile **közös** három
projekttel, tehát ez nem egyoldalú döntés.

### 4.4 A reverse proxy a repón kívül él

Az éles Caddyfile `/opt/YonagiFansub/Caddyfile`; a repóban lévő változat nincs
használatban és eltért tőle. A YUME telepítése így **nem önhordó**: egy tiszta
gépen a `docker compose up` nem adja vissza a jelenlegi működést.

**Kockázat:** közepes (telepíthetőség, visszaállíthatóság).

### 4.5 `pgfwd` — compose-on kívüli konténer

`alpine/socat`, kézzel indítva 2026-09-15-én, `127.0.0.1:15432 → postgres:5432`.
Hurokcímre kötve, tehát az internet felől nem elérhető, de **semmilyen fájl nem
dokumentálja**: egy újratelepítés után nem jön vissza, és aki nem tudja, hogy
van, az nem érti, miért működik a helyi `psql`.

### 4.6 `.env.example` 15 változóval le van maradva

A compose-ban hivatkozott, de a példából hiányzó kulcsok:

```
ACME_EMAIL  BACKUP_AT_HOUR  BACKUP_KEEP_DAYS  BACKUP_SYNC_CMD
CLOUDFLARE_ANALYTICS  EDGE_PROBE_URL  MAINTENANCE_VIDEO_BASE
MEDIA_BASE_URL  PUBLIC_URL  TRUST_PROXY  TURNSTILE_HOSTNAMES
TURNSTILE_PROTECT  TURNSTILE_SECRET_KEY  TURNSTILE_SITE_KEY  YUME_DOMAIN
```

Egy új telepítés ezekről nem tud. (A hiányzók egy részét ebben a munkamenetben
magam vezettem be — a mulasztás is az enyém.)

### 4.7 Példányhoz kötött memóriaállapot

| hol | mi | mi történik két példánynál |
|---|---|---|
| `edge/counters.ts:59` | csúszóablakos számlálók | a korlát példányonként külön számol → a tényleges küszöb kétszerese |
| `middleware/auth.ts:69,80` | jogosultság- és token-verzió gyorsítótár (TTL-lel) | egy visszavont jog a TTL-ig élhet a másik példányon |
| `@fastify/rate-limit` | alapértelmezett memóriatár | mint fent |
| `edge/ip-intel.ts` | IP-adatok gyorsítótára | csak több hálózati hívás, nincs helyességi következmény |
| `maintenance/cache.ts` | konfiguráció + LISTEN/NOTIFY | **rendben**: a NOTIFY minden példányt értesít |

Egy példánynál mindegyik helyes. **Ez az, amiért a Redis egyszer kelleni fog** —
nem cache-ként, hanem osztott számlálóként. A kód ezt több helyen ki is mondja.

### 4.8 Verziórögzítés

`postgres:16-alpine`, `redis:7-alpine`, `caddy:2-alpine`, `node:22-alpine` —
**minor szintű**, nem digest. Egy `docker compose pull` más patch-verziót hozhat.
Nem `latest`, tehát a legrosszabb eset nincs meg, de reprodukálhatónak nem
mondható.

### 4.9 `postgres` és `backup` nincs megkeményítve

Az `app` és a `worker` kap `no-new-privileges`-t és `cap_drop: ALL`-t, a
`postgres` és a `backup` nem. A `backup` a mentéseket tartalmazó kötetet írja.

---

## 5. Biztonsági megállapítások, sorrendben

1. **A worker teljes gazdagép-hozzáférése** (4.2) — a legsúlyosabb tétel.
2. **A Caddyfile a repón kívül** (4.4) — a telepítés nem reprodukálható.
3. `pgfwd` dokumentálatlan (4.5) — hurokcímre kötve, tehát nem sürgős.
4. `postgres`/`backup` megkeményítés hiánya (4.9).
5. A `.env` a gazdagépen olvasható minden olyan folyamatnak, ami a `/`-t látja —
   ez a 4.2 következménye, nem külön tétel.

Amit **nem** találtam problémának: publikált adatbázis-port, `0.0.0.0/0`
szabály, titok a naplóban, titok a `/v1/health*` válaszokban, `latest` tag.

---

## 6. Javasolt módosítások — sorrendben, indoklással

### 6.1 Az APP/API szétválasztás előkészítése (kód)

* az API alapcíme a kiszolgált `index.html`-be injektálva (`API_PUBLIC_URL`),
  a `window.location.origin` csak tartalékként;
* `CORS_ORIGINS` beállítása, amint az APP külön gazdanevet kap;
* a statikus kiszolgálás leválaszthatósága: az `app` konténer kapjon kapcsolót
  (`SERVE_WEB=false`), hogy később csak API legyen.

### 6.2 A worker gazdagép-csatolásának szűkítése

`- /:/host:ro` helyett egy dedikált üres könyvtár ugyanarról a fájlrendszerről.

### 6.3 A Caddy visszahozása a repóba

A YUME-ra vonatkozó blokk a repóban éljen, és onnan kerüljön a közös fájlba —
vagy a YUME kapjon saját, a 80/443-at nem foglaló proxyt a közös mögött.

### 6.4 `.env.example` kiegészítése (dummy értékekkel)

### 6.5 Redis bevezetése — **csak a második példánnyal együtt**

Ma nincs miért. Amikor lesz második `app`, akkor viszont a 4.7 három tétele
azonnal hibás lesz. A bevezetés akkor időszerű, és akkor is csak számlálóra és
jogosultság-gyorsítótárra; a pub/sub marad LISTEN/NOTIFY-on.

### 6.6 Verziók digestre rögzítése

---

## 7. Fájlok

### Módosítandó (a 6. pont szerint)

| fájl | miért |
|---|---|
| `docker-compose.yml` | worker gazdagép-csatolás, `postgres`/`backup` megkeményítés, `SERVE_WEB` |
| `.env.example` | 15 hiányzó változó |
| `apps/web/src/shared/api/yume.js` | API-alap injektálásból |
| `apps/api/src/app.ts` | az alap injektálása a lapba, `SERVE_WEB` kapcsoló |
| `infrastructure/reverse-proxy/Caddyfile` | a valósághoz igazítás |
| `docs/deployment/*` | a tényleges telepítési lánc leírása |

### Amihez nem kell hozzányúlni

`migrate.ts` (advisory lock rendben) · `infrastructure/queue/index.ts`
(`SKIP LOCKED` rendben) · `infrastructure/pubsub/index.ts` (LISTEN/NOTIFY
rendben) · `modules/system/routes.ts` (health checkek rendben) ·
`packages/database` · `apps/api/src/modules/**` üzleti logika ·
`scripts/database/*` (mentés/visszaállítás megvan)

---

## 8. Migrációs kockázatok (három VPS-re)

| kockázat | mérték | enyhítés |
|---|---|---|
| a kliens azonos origót vár | **magas** | 6.1, élesítés előtt |
| a Caddy három projektet szolgál | **magas** | a YUME szétválasztása a közös proxyból külön lépés, a másik két oldal érintése nélkül |
| privát hálózat a szolgáltatónál | ismeretlen | **a tényleges VPS-szolgáltatónál ellenőrizendő** — nem feltételezem, hogy van |
| adatbázis-késleltetés külön gépen | közepes | a kapcsolatszám és a pool méretezése; mérni kell, nem becsülni |
| a `web` külső hálózat megszűnik | közepes | a szétválasztással a Caddy → app hívás hálózatról TLS-re vált |
| R2-hitelesítő két gépen | alacsony | külön, szűkített token gépenként (a mostani fiókszintű — `SEC-02`) |

---

## 9. Amit nem mértem meg

* **Terhelés alatti viselkedés** két példánnyal — nincs második példány.
* **Adatbázis-késleltetés külön gépen** — nincs második gép.
* **A szolgáltató privát hálózata** — a repóból nem állapítható meg.
* **A `backup` visszaállítási próbája** — a szkript létezik
  (`scripts/database/restore.sh`), de ebben a felmérésben nem futtattam;
  éles adatbázison nem is futtatnám engedély nélkül.
