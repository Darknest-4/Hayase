# YUME — szétválasztás három VPS-re

**Állapot:** terv. A rendszer ma egy gépen fut; ez a dokumentum azt írja le,
hogyan lehet szétvinni — és mit kell ELŐBB megnézni, mert több pont a
szolgáltatódon múlik, nem a kódon.

Kiindulás: [`current-architecture-audit.md`](current-architecture-audit.md).

---

## 0. Amit a terv NEM tud, és neked kell ellenőrizned

Ezeket a repóból nem lehet megállapítani. Ne kezdj a költözésnek, amíg nincs
rájuk válasz:

1. **Van-e privát hálózat a szolgáltatódnál**, és a három VPS ugyanabban a
   régióban/zónában lehet-e. Ha nincs, a gépek közti forgalom a publikus
   interneten megy, és akkor **TLS kötelező** az adatbázis-kapcsolatra is.
2. **Számlázik-e a szolgáltató belső forgalmat.** A képek már az R2-ből
   mennek, de az API↔DB forgalom folyamatos.
3. **Van-e tűzfal a szolgáltató felületén** (a géptől függetlenül), vagy csak
   a gépen belüli `ufw`/`nftables`.
4. **Mekkora a várható terhelés.** A szétválasztás önmagában NEM gyorsít —
   hálózati ugrást ad hozzá. Akkor éri meg, ha az erőforrás fogy, vagy ha a
   hibahatárok elkülönítése a cél.

---

## 1. Előkészítés — még az egy gépen

Ezek a lépések már MEG VANNAK, vagy a jelenlegi gépen elvégezhetők:

| lépés | állapot |
|---|---|
| bedrótozott szolgáltatás-címek megszüntetése | **kész** — nincs ilyen az API-ban |
| adatbázis `DATABASE_URL`-ből | **kész** |
| migráció párhuzamos-biztos (advisory lock) | **kész** |
| feladatsor párhuzamos-biztos (`SKIP LOCKED`) | **kész** |
| WebSocket több példány közt (LISTEN/NOTIFY) | **kész** |
| liveness/readiness szétválasztva | **kész** |
| `API_PUBLIC_URL` → a lapba írva, a kliens onnan olvassa | **kész** |
| `SERVE_WEB=false` — az API csak API legyen | **kész** |
| a reverse proxy YUME-blokkja a repóban | **kész** |
| `.env.example` teljes | **kész** |
| osztott sebességkorlát-számláló (Redis) | **hiányzik** — a 2. APP példánnyal együtt kell |

---

## 2. A célállapot

```
Cloudflare
   │
   ▼
APP VPS ──── nginx/Caddy + a statikus kliens
   │           (SERVE_WEB nélkül futó, csak fájlokat adó kiszolgáló)
   │  HTTPS, privát hálózaton
   ▼
API VPS ──── app (SERVE_WEB=false) + worker + (később) redis
   │  privát hálózat, TLS
   ▼
DB VPS  ──── postgres + backup
```

**A YUME-ban az APP ma nem külön szolgáltatás**, hanem az API konténer által
kiszolgált statikus fájlkészlet. Az APP VPS ezért a legegyszerűbb darab: egy
webkiszolgáló, ami az `apps/web` tartalmát adja, és a lapba beírja az API
címét. Ez a legkisebb, legkevésbé kockázatos első lépés is egyben.

---

## 3. A költözés sorrendje

A sorrend szándékos: a **legkisebb kockázatú megy először**, és minden lépés
után vissza lehet állni.

### 3.1 DB VPS (elsőként, mert ez a legnehezebben visszavonható)

1. VPS felállítása, `apt upgrade`, SSH kulcsos belépés, jelszavas belépés
   **csak azután kikapcsolva**, hogy a kulcsos működik.
2. Tűzfal: alapból minden bejövő tiltva; **5432 CSAK az API VPS privát
   címéről**. Sosem `0.0.0.0/0`.
3. Docker + a `postgres` és `backup` szolgáltatás a compose-ból.
4. **TLS a kapcsolatra**, ha nincs privát hálózat: `ssl=require` a
   `DATABASE_URL`-ben, tanúsítvány a Postgresen.
5. `pg_dump` a jelenlegi gépről → visszaállítás az újra →
   **visszaállítási próba**, mielőtt bármit átkapcsolnál.
6. `DATABASE_URL` átírása az API-n, `docker compose up -d app worker`.
7. Ellenőrzés: `/v1/health/ready` zöld, a katalógus betölt, belépés működik.

**Visszaállás:** a régi Postgres a helyén marad, kikapcsolva; a `DATABASE_URL`
visszaírásával egy újraindítás alatt visszaáll. A dump miatt ne írj az új DB-be,
amíg a próba le nem zárult.

### 3.2 APP VPS

1. VPS, tűzfal: 80/443 a Cloudflare tartományaiból (`trust-proxy.sh --matcher`).
2. A statikus kliens kiszolgálása. Két út:
   * **egyszerű**: ugyanez a kép `SERVE_WEB=true`-val, de az API-hívások a
     másik gépre mennek (`API_PUBLIC_URL`);
   * **tisztább**: csak egy Caddy/nginx az `apps/web` tartalmával. Ekkor a
     lapba a `yume:api-base` jelölőt a kiszolgálónak kell beírnia — ma ezt az
     API konténer teszi, tehát ehhez egy apró kiszolgáló kell.
3. `API_PUBLIC_URL=https://api.pelda.hu`, és az API-n `CORS_ORIGINS` az APP
   origójára. **A kettő együtt jár**: enélkül a böngésző az első hívásnál
   elhasal.
4. DNS: az APP gazdaneve az APP VPS-re, az `api.` az API VPS-re.

### 3.3 API VPS

1. A `SERVE_WEB=false` bekapcsolása — innentől az API csak API.
2. A worker marad az API mellett (közös kép, közös adatbázis-közelség).
3. Tűzfal: 443 a Cloudflare felől, 5432 KIFELÉ a DB VPS-re.

### 3.4 Redis — csak a MÁSODIK APP/API példánnyal

Amíg egy `app` fut, nincs miért. Amikor lesz kettő, azonnal kelleni fog:
a sebességkorlát számlálói (`edge/counters.ts`) és a jogosultság-gyorsítótár
(`middleware/auth.ts`) példányonként külön élnek, tehát a tényleges küszöb a
példányok számával szorzódik. A WebSocket-szórás **nem** vált Redisre.

---

## 4. Élesítés előtti ellenőrzőlista

* [ ] `pg_dump` friss, és a **visszaállítás ki van próbálva** üres adatbázisra
* [ ] a DB tűzfala csak az API VPS-t engedi
* [ ] `DATABASE_URL` TLS-sel, ha nincs privát hálózat
* [ ] `API_PUBLIC_URL` és `CORS_ORIGINS` **együtt** beállítva
* [ ] `TRUST_PROXY` a Cloudflare tartományaival mindkét gépen
* [ ] `PUBLIC_URL` az APP gazdanevére
* [ ] `TURNSTILE_HOSTNAMES` tartalmazza az összes kiszolgáló gazdanevet,
      és a Turnstile widget beállításánál is ott vannak
* [ ] `/v1/health` és `/v1/health/ready` mindkét gépen válaszol
* [ ] a mentés az új DB VPS-ről fut, és az R2-be is kimegy
* [ ] R2-token **gépenként külön, szűkítve** (ma fiókszintű — `SEC-02`)
* [ ] a régi gép szolgáltatásai leállítva, de **nem törölve**, amíg a próba
      le nem zárult
* [ ] visszaállási lépések leírva és kipróbálva

---

## 5. Kiesés minimalizálása

A leghosszabb kiesés a DB-költözés. Két út:

* **Egyszerű (percek):** karbantartási mód be (a rendszernek van ilyen, és
  jegyet is tud adni az üzemeltetőnek) → `pg_dump` → visszaállítás →
  `DATABASE_URL` → indítás → karbantartás ki.
* **Majdnem nulla:** logikai replikáció a régiről az újra, majd átkapcsolás.
  Több beállítás, több hibalehetőség; a jelenlegi mérettel az első bőven elég.

---

## 6. Mit NEM old meg a szétválasztás

* **Nem gyorsít.** Hálózati ugrást ad hozzá az API↔DB útra.
* **Nem ad rendelkezésre állást.** Három gép, három hibalehetőség — HA a cél,
  ahhoz példányonként kettő kell, és osztott állapot (Redis).
* **Nem egyszerűsíti az üzemeltetést.** Három gépet kell frissíteni,
  menteni és figyelni.

Ha a cél a jelenlegi méretnél **a hibahatárok elkülönítése** (egy elszabadult
worker ne vigye magával a webkiszolgálást) vagy **az adatbázis külön erőforrása**,
akkor megéri. Ha „mert így szokás", akkor még nem.
