# Karbantartási mód — API

## `GET /v1/status` — nyilvános

Mindig elérhető, **karbantartás alatt is**. `Cache-Control: no-store` — pont a
változását akarjuk látni.

```json
{
  "status": "maintenance",
  "mode": "ACTIVE",
  "scope": "global",
  "title": "Épp dolgozunk rajta",
  "message": "A YUME hamarosan újra elérhető lesz.",
  "startsAt": "2026-09-20T02:00:00.000Z",
  "estimatedEnd": "2026-09-20T04:00:00.000Z",
  "estimatedEndLocal": "2026. 09. 20. 06:00 CEST",
  "timezone": "Europe/Budapest",
  "retryAfter": 3600,
  "version": 12,
  "video": { "name": "maintenance.mp4", "url": "/assets/videos/maintenance.mp4", "type": "video/mp4" }
}
```

**Amit nem ad ki** (27. pont): belső okot, adatbázis-állapotot,
infrastruktúra-részletet, admin-információt, biztonsági metaadatot. A
mezőkészlet szándékosan rövid — ami nincs benne, azt nem lehet véletlenül
kiszivárogtatni.

A `video` mezőt csak akkor keressük meg, ha tényleg karbantartás van: normál
üzemben egy könyvtárolvasás minden státuszkérésnél fölösleges lemezmunka.

## A visszautasított kérés válasza

### Fejlécek, mindig

```
HTTP/1.1 503 Service Unavailable
Retry-After: 120
Cache-Control: no-store
X-Yume-Maintenance: true
X-Request-ID: 1a6246a6-02b6-4cd1-becc-5bf3ef95…
```

Az `X-Yume-Maintenance` az, ami megkülönbözteti egy közönséges 503-tól. A
kliens **ebből** ismeri fel a karbantartást, nem a státuszkódból: egy 503
jöhet máshonnan is, és arra nem karbantartási oldal jár.

### Gépi hívónak: JSON

```json
{
  "error": {
    "code": "YUME_MAINTENANCE",
    "mode": "ACTIVE",
    "scope": "global",
    "message": "A YUME hamarosan újra elérhető lesz.",
    "retryAfter": 120,
    "requestId": "1a6246a6-…"
  }
}
```

### Böngészőnek: oldal

Az `Accept` fejléc dönt: a böngésző navigációja `text/html`-t kér **előbb**, a
`fetch` és a `curl` nem. A `*/*` szándékosan nem elég — azt minden
programkönyvtár küldi.

Az oldal **magában áll**: se stíluslap, se betűkészlet, se szkript. Egy
státuszoldal, ami letölt valamit, pont akkor hasal el, amikor a kiszolgáló
bajban van.

## Admin: `/v1/admin/maintenance`

`security.manage` jogosultsághoz kötve — ugyanoda, ahova a csak-olvasható
üzem. Nem tartalmi szerkesztés, hanem üzemeltetés.

### `GET /`

A teljes állapot: beállítás, érvényes mód, hátralévő idő, helyi idők, a
gyorsítótár állapota, az élő jegyek, a változástörténet és a megtalált videók.

### `PUT /`

Mentés — **mindig új verzió**. A törzs mezői a `maintenance_configs`
oszlopainak felelnek meg. A mentés után a példány azonnal frissül, a többi az
értesítésből (vagy legkésőbb a lejárati időből).

Hibák:

| státusz | mikor |
|---|---|
| `400` | a befejezés a kezdés előtt van |
| `403` | nincs `security.manage` jogosultság |

### `POST /preview`

**Nem aktivál semmit.** Egy kitalált beállítással lefuttatja a döntést nyolc
jellemző hívóra, és megmondja, mi **történne**:

```json
{
  "effectiveMode": "DEGRADED",
  "at": "2026-09-20T03:00:00.000Z",
  "results": [
    { "label": "látogató, lejátszó", "kind": "BLOCK", "reason": "a(z) player terület átmenetileg kikapcsolva" },
    { "label": "admin, karbantartás", "kind": "ALLOW", "reason": "helyreállítási útvonal" },
    { "label": "egészségjelző", "kind": "ALLOW", "reason": "mindig nyitott útvonal" }
  ]
}
```

### `POST /bypass`

Új mentességi jegy. **A jegy CSAK most látható** — utána sehol nem érhető el,
mert az adatbázisban csak a lenyomata van.

```json
{
  "token": "a1b2c3d4e5f60718.XXXX….YYYY…",
  "id": "a1b2c3d4e5f60718",
  "scope": "global",
  "expiresAt": "2026-09-20T03:15:00.000Z",
  "header": "x-yume-maintenance-bypass",
  "note": "A jegy csak most látható. Fejlécben vagy sütiben küldd, sosem az URL-ben."
}
```

Használat:

```bash
curl -H 'x-yume-maintenance-bypass: <jegy>' https://yumee.duckdns.org/v1/anime
```

Böngészőben a `yume_maintenance_bypass` süti is működik — ott fejlécet nem
lehet feltenni egy navigációhoz.

**Az URL-be sosem kerül.** Egy cím bekerül a proxynaplókba, a böngésző
előzményeibe és a hivatkozó fejlécbe; egy rövid életű jegy is túl sok helyen
hagyna nyomot.

### `DELETE /bypass/:id`

Visszavonás. **Azonnal hat**: a következő ellenőrzés már elutasítja.
