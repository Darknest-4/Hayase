# Üzembe helyezés és üzemeltetés — statisztika és Discord

Mit kell beállítani, mi indul el magától, és mi az, amit ember kapcsol be.

---

## 1. Szolgáltatások

| Szolgáltatás | Mit csinál | Kell hozzá |
|---|---|---|
| `app` | API + webkliens + Discord-vezérlőpult | `DATABASE_URL`, `JWT_SECRET` |
| `worker` | összesítés, nyesés, szondák, tartós üzenetek | ugyanaz |
| `gateway` | Discord WebSocket, üzenet- és tagstatisztika | `DISCORD_BOT_TOKEN` |
| `postgres` | minden adat | — |
| `backup` | napi mentés + ellenőrzés | — |

```bash
docker compose up -d --build app worker gateway
```

A **gateway külön folyamat**, nem a workerben: állandó kapcsolatot tart és
~41 másodpercenként szívvernie kell; egy hosszú worker-feladat alatt a
szívverés elmaradna, és a Discord bontaná a kapcsolatot. Lásd
`docs/discord-gateway.md`.

## 2. Környezeti változók

### Kötelező

| Változó | Mire |
|---|---|
| `DATABASE_URL` | adatbázis |
| `JWT_SECRET` | munkamenetek |
| `POSTGRES_PASSWORD` | a compose ebből építi a címet |

### Discord

| Változó | Alap | Mit kapcsol |
|---|---|---|
| `DISCORD_BOT_TOKEN` | — | REST és gateway. Enélkül a Discord-részek `not_configured` állapotban vannak, **nem hibásak** |
| `DISCORD_CLIENT_ID` | — | OAuth-összekötés |
| `DISCORD_CLIENT_SECRET` | — | OAuth-összekötés |
| `DISCORD_GATEWAY_ENABLED` | `true` | a gateway ki/be |
| `DISCORD_GUILD_MEMBERS_INTENT` | `false` | tagmozgás — **csak ha a portálon is engedélyezve van** |
| `DISCORD_GATEWAY_STALE_MS` | `300000` | meddig hisszük élőnek |

> A privilegizált intentet nem szabad „biztos, ami biztos" alapon bekapcsolni:
> ha a fejlesztői portálon nincs engedélyezve, a Discord a **csatlakozást**
> utasítja vissza (4014), tehát nem kevesebb adat jönne, hanem **semmi**.

### Megőrzés

Lásd `docs/analytics-privacy.md`. Alapértelmezések: nyers oldalletöltés és
munkamenet 90 nap, keresőkifejezés 30, fiókesemény és biztonsági napló 365,
Discord-frissítési esemény 30. Az összesítők **nem nyesődnek**.

### Terhelésmérés (csak a mérőverem)

`LOAD_TEST_KEY`, `LOAD_TEST_IPS`, `LOAD_JWT_SECRET` — ezek az **éles** app
környezetében nincsenek beállítva, tehát ott nem is léteznek.

## 3. Migrációk

Az alkalmazás **induláskor** lefuttatja őket. Kézzel:

```bash
docker compose exec app node --experimental-strip-types \
  src/infrastructure/migrations/migrate.ts
```

Minden migráció **additív** (`CREATE TABLE IF NOT EXISTS`, új oszlop): nincs
adatvesztő lépés, és egy visszaállás a régi képre sem töri el az adatbázist.

## 4. Fordított proxy

A `discord.animehub.hu` **ugyanahhoz az alkalmazáshoz** megy, de minden
nem-API címét a `/dashboard` előtag alá írja át:

```caddy
@api path /v1/* /graphql* /graphiql* /ws*
handle @api { reverse_proxy yume-app-1:4000 { … } }
handle {
    rewrite * /dashboard{uri}
    reverse_proxy yume-app-1:4000 { … }
}
```

Az API-előtagok azért maradnak ki, mert különben a vezérlőpult a saját
API-ját nem érné el: a lap betöltődne, és utána minden hívás 404 lenne.

Telepítés:

```bash
scripts/reverse-proxy/install.sh /opt/YonagiFansub/Caddyfile
docker compose restart caddy      # abban a projektben, ahol a Caddy fut
```

## 5. Az első nap

Amire számítani kell egy friss telepítésen — és ami **nem hiba**:

| Jelenség | Miért |
|---|---|
| a 30/90/365 napos nézetek üresek | még nincs annyi nap. Az **Áttekintés** kiírja, mióta mérünk |
| „nincs elegendő adat" | a gyűjtés az első látogatóval indul |
| a Discord-nézetek `not_configured` | nincs token — ez szándékos állapot, nem üzemzavar |
| a tagmozgás üres | privilegizált intent nélkül nem létezik |
| a gateway `ready`, de nincs üzenetadat | még nem írt senki a szerveren |

**Visszamenőleges adat nincs, és kitalálni tilos.**

## 6. Ellenőrzés telepítés után

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://animehub.hu/v1/health
curl -s -o /dev/null -w '%{http_code}\n' https://discord.animehub.hu/
docker compose logs gateway --tail 20
docker compose exec postgres psql -U yume -d yume \
  -c "select status, last_event_at, reconnects from discord_gateway_state"
```

Az adminfelület **Statisztika → Adatminőség** füle egy helyen megmondja, mit
gyűjtünk, mióta, és van-e lyuk a napi összesítőben.

## 7. Amikor valami nem stimmel

| Tünet | Hol nézd |
|---|---|
| a panel üres, a nyers táblák nőnek | Adatminőség → hiányzó napok; `worker` napló |
| egy nap hiányzik | leállt worker; az összesítő idempotens, újrafuttatható |
| a Discord-üzenet percenként módosul | az előzményben nincs `skipped` → a tartalom rendereléskor változik |
| a gateway `failed` | `last_error` — beállítási hiba, nem üzemzavar |
| a gateway `ready`, de `last_event_at` régi | lefagyott folyamat; `docker compose restart gateway` |
| 429 a mérésben | a mérőkulcs nem ad mentességet |

## 8. Amit soha ne

* **ne** kapcsold be a `GUILD_MEMBERS` intentet a portálon való engedélyezés
  előtt — a bot onnantól nem csatlakozik;
* **ne** futtasd a mérővetőket az éles adatbázison — a scriptek meg is
  tagadják, de a cím elgépelhető;
* **ne** tedd nyilvánosra a Postgres portját;
* **ne** commitold a `.env`-et.
