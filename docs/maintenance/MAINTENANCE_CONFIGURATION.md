# Karbantartási mód — beállítás

## Az adatbázis

### `maintenance_configs`

**Minden módosítás új sor.** A legnagyobb `version` az érvényes. Nem
szépségből: egy karbantartás utólag mindig kérdés lesz („mikor kapcsoltuk be,
ki, és mit mondtunk a látogatóknak"), és egy felülírt sor erre nem tud
válaszolni.

| mező | mire |
|---|---|
| `version` | a gyorsítótár azonosítója is — ebből tudja egy példány, hogy friss-e |
| `mode` | `OFF` / `SCHEDULED` / `ACTIVE` / `DEGRADED` / `READ_ONLY` / `EMERGENCY` |
| `scope` | a tizenhárom hatókör egyike |
| `enabled` | enélkül a beállítás mentve van, de nem hat |
| `starts_at`, `ends_at` | **abszolút pillanatok**, nem helyi idő |
| `estimated_end_at` | tájékoztatás, nem hat a döntésre |
| `timezone` | **kizárólag megjelenítésre** |
| `title`, `public_message` | amit a látogató lát |
| `allow_existing_sessions`, `drain_seconds` | kiürítés |
| `bypass_policy` | szabad alakú, a bővíthetőségért |
| `created_by`, `created_at` | ki és mikor |

Adatbázisszintű megszorítások, mert a felület megkerülhető, a tábla nem:

- a mód csak a hat ismert érték egyike lehet;
- `0 ≤ drain_seconds ≤ 3600`;
- **egy ablak, aminek a vége a kezdete előtt van, nem ablak.**

### `maintenance_bypass_tokens`

A jegy maga **nincs benne** — csak a SHA-256 lenyomata. Ugyanaz az elv, mint a
jelszavaknál: aki megszerzi az adatbázist, ne tudjon vele bemenni.

**Örök jegy nem létezik**, és ezt is az adatbázis tartatja be:
`expires_at <= created_at + 24 óra`.

## Környezeti változók

| változó | alap | mire |
|---|---|---|
| `RATE_LIMIT_TRUST_INTERNAL` | `true` | a saját hálózatunk mentessége a sebességkorlát alól |

A karbantartásnak **nincs saját környezeti változója**, és ez szándékos: egy
karbantartást a telepítés újraindítása nélkül kell tudni be- és kikapcsolni.
Minden az adatbázisban van.

## A hatókörök és az útvonalaik

| hatókör | útvonalak |
|---|---|
| `global` | mind |
| `web` | a szerveroldalon semmi (ez a kliens felületéről szól) |
| `api` | `/v1`, `/graphql` |
| `authentication` | `/v1/auth` |
| `registration` | `/v1/auth/register` |
| `player` | `/v1/anime/episodes`, `/v1/sources`, `/v1/media` |
| `catalog` | `/v1/anime` |
| `search` | `/v1/search`, `/v1/anime/search` |
| `watch-history` | `/v1/history`, `/v1/watch`, `/v1/library` |
| `watch-party` | `/v1/watch-together`, `/v1/w2g` |
| `comments` | `/v1/comments`, `/v1/forum`, `/v1/chat` |
| `profiles` | `/v1/profile`, `/v1/users` |
| `admin` | `/v1/admin` |

Az illesztés **teljes szegmensre** megy: a `/v1/searching` **nem** tartozik a
`search` alá.

## Ami MINDIG nyitva marad

```
/v1/health      /v1/status      /v1/config      /v1/maintenance
```

Enélkül nem lehetne **kijönni**: az irányítórendszer halottnak hinné a
szolgáltatást, és a karbantartási oldal sem tudná megkérdezni, vége van-e már.

És a helyreállítási útvonalak, vészhelyzetben is:

```
/v1/admin/maintenance      /v1/auth/login      /v1/auth/refresh
```

Enélkül a vészhelyzet egyirányú ajtó lenne: bekapcsolni lehetne, kikapcsolni
nem.

## A karbantartási videó

Nincs mit beállítani. A rendszer megnézi az `assets/videos` könyvtárat, és:

1. a kifejezetten karbantartásra szánt nevet választja
   (`maintenance`, `maintenance-loop`, `maintenance-background`,
   `karbantartas`);
2. ha nincs ilyen, a névsor elsőjét;
3. ha nincs videó, **az oldal ugyanúgy teljes** — a videó dísz, nem tartalom.

Támogatott: `.mp4`, `.webm`, `.m3u8`.
