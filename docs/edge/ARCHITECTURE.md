# YUME Edge — felépítés

## Mi ez, és mi nem

Ez **nem** egy Cloudflare-másolat. Cloudflare a hálózat szélén ül, több száz
ponton, és a forgalom nagy részét azelőtt eldobja, hogy az bárhová megérkezne.
Egy egygépes telepítés ezt nem tudja lemásolni, és aki megpróbálja, egy lassabb
alkalmazást kap, nem egy védettebbet.

Amit ez a réteg csinál: a YUME saját alkalmazásán belül, a kérési út elején
eldönti, hogy egy kérés **gyanús-e**, és ha igen, mit kezdjünk vele. A
hálózati szintű elárasztás (SYN flood, volumetrikus DDoS) ellen ez nem véd, és
nem is állítjuk, hogy védene — az a szolgáltató és a tűzfal dolga.

## Ami már megvolt, és amit nem írtunk újra

| terület | létező megoldás |
|---|---|
| TLS, HSTS | Caddy, automatikus tanúsítvánnyal |
| sebességkorlát | `@fastify/rate-limit`, IP-kulcs, négy vödör, **futásidőben állítható** |
| biztonsági napló | `security_logs` — hatezer sor, tíz eseménytípus |
| fiók tiltása | `users.status` + `token_version` visszavonás |
| bot-felismerés (UA) | `analytics/visitor.ts` |
| állapotjelentés | `security/posture.ts` — tizenhat ellenőrzés |
| vészkapcsolók | csak olvasható mód, külső szinkron, webhookok |
| megőrzés | `pruneAnalytics` |

Az Edge ezekre épül. A `security_logs`-ba ír (nem egy második naplóba), a
meglévő jogosultságrendszert használja, és a meglévő sebességkorlát **után**
fut — az a nyers mennyiséget fogja meg olcsón, ez a mintát nézi.

## A kérés útja

```
            Caddy (TLS, HSTS)
                  │
            @fastify/rate-limit        ← nyers mennyiség, IP szerint
                  │
         ┌────────▼────────┐
         │   YUME Edge     │  onRequest hook
         │                 │
         │  1. tiltás?     │  memóriabeli pillanatkép (10 mp)
         │  2. számlálók   │  csúszó ablak, memóriában
         │  3. WAF         │  minta az URL-en és a lekérdezésen
         │  4. IP-intel    │  memóriagyorsítótár (5 perc)
         │  5. pontszám    │  risk.ts — jelek súlyozva
         │  6. döntés      │  policy.ts — küszöbök
         └────────┬────────┘
                  │  allow / monitor / challenge / throttle / block
                  ▼
          csak olvasható mód → hitelesítés → útvonal
                  │
             onResponse         ← 404-ek és belépési hibák megjegyzése
                  │
          eseménypuffer → 5 mp-enként kötegben az adatbázisba
```

**A forró út 0,22 ms.** Mérve: 400 kérés a `/v1/config`-ra, mediánban 1,33 ms
éllel és 1,11 ms nélküle. Adatbázis-lekérdezés a közös úton nincs.

## Modulok

| fájl | felelősség |
|---|---|
| `config.ts` | a beállítás: súlyok, küszöbök, hatókör — `site_settings`-ből, gyorsítótárazva |
| `waf.ts` | tizenhat nevesített szabály, súlyossággal, pontszámmal, hatókörrel |
| `ip-intel.ts` | provider-absztrakció + helyi heurisztika + gyorsítótár |
| `counters.ts` | többdimenziós csúszó ablakok (IP, fiók, munkamenet, útvonal) |
| `risk.ts` | jelek → pontszám. **Nem dönt.** |
| `policy.ts` | pontszám → döntés. **Nem pontoz.** |
| `bans.ts` | a tiltómotor: IP, hálózat, fiók, munkamenet, API-kulcs |
| `events.ts` | pufferelt naplózás két szinten |
| `index.ts` | a forró út, ami összefűzi őket |
| `worker.ts` | ami nem fér bele a kérési útba |
| `admin-routes.ts` | az operátori felület |

## A szétválasztás, ami a rendszert együtt tartja

**A pontozás és a döntés külön fájl.** Ez nem formalitás:

* külön változnak — a súlyokat az hangolja, aki a forgalmat nézi, a
  küszöböket az, aki a kockázatot vállalja;
* a **száraz üzem** így tiszta: a pontozás ugyanazt számolja élesben és
  szárazon, csak a végrehajtás marad el. Ha a `dryRun` a pontozás közepén ülne
  egy `if`-ben, az első hibája az lenne, hogy élesben mást számol;
* a döntés **visszafejthető**: a naplóban ott van, melyik jel mennyit adott.
  Egy „87 pont" nem válasz arra, hogy miért.

## Amit szándékosan nem építettünk

* **Redis.** Egy app-példány fut. A `counters.ts` pontosan az a fájl, amit ki
  kell cserélni, amikor lesz második — a hívói felülete nem változik. Lásd
  `docs/redis.md`.
* **Saját CAPTCHA.** A `challenge` döntés ma naplózásra való: a rendszer
  megjelöli a kérést, de nem állít akadályt. Egy CAPTCHA a látogatók
  mindegyikének költség, a támadók egy részének nem az — és ma nincs
  bizonyítékunk arra, hogy szükség lenne rá. A döntési fokozat megvan, a
  megvalósítása akkor jön, ha a napló megindokolja.
* **VPN-adatbázis.** Külső adat nélkül nem lehet megmondani, hogy egy cím
  VPN-é. Nem tettünk úgy, mintha lehetne: a helyi provider azt mondja meg,
  amit tényleg tud, és a `confidence` mező kimondja, mennyire.

Részletek: [RISK.md](RISK.md), [WAF.md](WAF.md), [BANS.md](BANS.md),
[OPERATIONS.md](OPERATIONS.md).
