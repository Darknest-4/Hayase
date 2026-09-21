# Analytics + Discord — gap-lista

**Módszer:** a repository és a **futó éles rendszer** együttes mérése. Ahol
szám szerepel, az mérés. Dátum: 2026-09-21.

**Állapotjelölés:**
`COMPLETE` = DB → backend → API → jogosultság → felület → valós adat → teszt →
éles működés, végig. `PARTIAL` = a lánc egy része hiányzik. `MISSING` = nincs.
`BLOCKED` = nem rajtam múlik, és a blokkoló meg van nevezve.

---

## 0. Két pontosítás a feladatkiíráshoz

**„A jelenlegi csak Szolgáltatók és Rendszer."** Mérve: a statisztikai panel
**nyolc** fülből áll — `Látogatók`, `Címek`, `Keresés`, `Fiókok`, `Eszközök`,
`Teljesítmény` (ezek korábbról), plusz `Szolgáltatók` és `Rendszer` (ezeket én
tettem hozzá). A hiány valós, de kisebb, mint a kiírás feltételezi.

**`discord.animehub.hu` DNS-e MÁR BE VAN ÁLLÍTVA.** Mérve: ugyanazokra a
Cloudflare-címekre mutat, mint az `animehub.hu`. Ma `HTTP 525`-öt ad (SSL
handshake failed az origin felé), mert a Caddyben **nincs blokk erre a
névre**. Ez tehát nem DNS-, hanem reverse-proxy-feladat — és elvégezhető.

---

## 1. Analytics Core (2–4. pont)

| Követelmény | Állapot | Mérés / indok |
|---|---|---|
| Event Collector létezik | `COMPLETE` | `analytics/collector.ts`, kérési úton kívül, kötegelve |
| …**oldalletöltést** gyűjt | `COMPLETE` | `page_views`: 1337 sor |
| …munkamenetet | `COMPLETE` | `analytics_sessions`: 143 |
| …keresést | `COMPLETE` | `search_stats`: 15 254 |
| …fiókeseményt (reg/login) | `COMPLETE` | `account_events`: 216 |
| …biztonsági eseményt | `COMPLETE` | `security_logs`: 15 615 |
| …API-kérést és késleltetést | `COMPLETE` | `performance_metrics`: 22 667 |
| …epizód/anime megnyitást | `PARTIAL` | `anime_stats_daily` 32, `episode_stats_daily` **3** sor — az összesítő létezik, de a nyers esemény nem minden útvonalon keletkezik |
| …**watch start / progress / completion** | `PARTIAL` | `watch_stats_daily`: **3** sor. A lejátszó küld haladást, de nincs külön „start"/„completion" esemény |
| …kedvelés / watchlist / like | `PARTIAL` | `xp_events`: 20 sor; nincs dedikált analitikai esemény |
| …keresési találat-interakció | `MISSING` | nincs ilyen esemény |
| …logout / session end | `PARTIAL` | a munkamenet vége **számított** (30 perces ablak), nem esemény |
| …provider request/error/timeout | `COMPLETE` | `provider_metrics_daily` — én építettem, mérve |
| …admin action | `COMPLETE` | `audit_logs`, particionált |
| **Egységes esemény-struktúra** (3. pont) | `MISSING` | ma **táblánként külön alak** van. Nincs közös `event_id`/`event_type`/`metadata` séma |
| Idempotencia / deduplikáció | `PARTIAL` | az oldalletöltésnél van (10 mp-es ablak, 20 000 kulcs); a többi eseménynél nincs egységes dedupe |
| Óránkénti aggregáció | `PARTIAL` | `system_metrics_hourly` van; az analitikai összesítő **napi** |
| Napi aggregáció | `COMPLETE` | `rollup.ts`, idempotens |
| Heti / havi aggregáció | `MISSING` | nincs; a panel napi sorokból összegez |
| Időszak-összehasonlítás, trend, % | `COMPLETE` | `admin-routes.ts` `previous` blokk + `analyticsKpi` |

**Összegzés:** az Analytics Core **váza kész és jól megtervezett**, de az
eseménykör szűk, és nincs egységes eseményséma.

---

## 2. YUME Web Analytics Dashboard (5–8., 33. pont)

| Követelmény | Állapot | Mérés |
|---|---|---|
| Időszakválasztó | `COMPLETE` | `ANALYTICS_RANGES` |
| Egyedi tartomány | `COMPLETE` | `windowOf()` `from`/`to` |
| Kézi frissítés | `PARTIAL` | fülváltás újratölt; nincs dedikált gomb |
| Auto-refresh | `MISSING` | — |
| Export | `COMPLETE` | `GET /export`, `analytics.export` joggal |
| Utolsó frissítés ideje | `PARTIAL` | csak a Rendszer fülön |
| Adatminőség-jelzés (34. pont) | `MISSING` | — |
| KPI: anime, epizód, felhasználó | `PARTIAL` | a Címek/Fiókok fülön van, az „Overview"-n nincs |
| KPI: aktív felhasználó, új reg. | `COMPLETE` | Látogatók fül |
| KPI: watch start/completion | `MISSING` | nincs adat mögötte (lásd fent) |
| KPI: kedvelés, watchlist, like | `MISSING` | nincs adat mögötte |
| KPI: uptime | `PARTIAL` | `service_status`-ban van, KPI-ként nincs |
| **Overview** összefoglaló oldal | `MISSING` | nincs ilyen fül |
| Users fül | `COMPLETE` | `Fiókok` |
| Content fül | `PARTIAL` | `Címek` + `Keresés` külön; nincs összefogott Content nézet |
| Providers fül | `COMPLETE` | én építettem |
| System Health fül | `COMPLETE` | én építettem |
| API fül | `PARTIAL` | `Teljesítmény` néven létezik |
| Timeseries fül | `MISSING` | — |
| Data Quality fül | `MISSING` | — |

---

## 3. User / Content / Provider analytics (6–9. pont)

| Követelmény | Állapot | Mérés |
|---|---|---|
| User analytics oldal | `COMPLETE` | `GET /users`, `Fiókok` fül |
| Eszköz/böngésző/OS bontás | `COMPLETE` | `GET /breakdown`, `Eszközök` fül |
| Retention / visszatérő | `PARTIAL` | `returning_visitors` az összesítőben; nincs kohorsz-nézet |
| Átlagos munkamenethossz | `COMPLETE` | `avg_duration_sec` |
| **Account activity napló** | `COMPLETE` | `account_events`, sorszámozva |
| Admin user detail analytics | `COMPLETE` | `GET /accounts/:userId` |
| …lapozás | `PARTIAL` | limit van, kurzor nincs |
| Content: legnézettebb anime | `COMPLETE` | `GET /anime` |
| Content: epizód-befejezési arány | `PARTIAL` | az adat 3 sor — a mező megvan, a mérés nem |
| Content: drop-off | `MISSING` | — |
| Search: nulla találatú | `COMPLETE` | `zero_result_searches` |
| Search → megnyitás konverzió | `MISSING` | nincs interakció-esemény |
| Provider: p50/p95/p99 | `MISSING` | ma átlag és max van, percentilis nincs |
| Provider: elérhetőség-trend | `PARTIAL` | napi bontás van, „availability %" nincs |
| Provider: forrásstatisztika animénként | `MISSING` | — |

---

## 4. System Health (10. pont)

| Komponens | Állapot | Mérés |
|---|---|---|
| Web / API / PostgreSQL / worker | `COMPLETE` | `service_status`, valós ellenőrzésből |
| Redis / RabbitMQ / OpenSearch / MinIO | `COMPLETE` | `not_configured` — szándékosan nincs bekapcsolva |
| **Discord bot / Discord API** | `MISSING` | nincs a `service_status`-ban |
| queue / backup / storage | `PARTIAL` | van adat máshol, a health panelen nincs |
| CPU / RAM / disk | `PARTIAL` | `system_metrics` gyűjti, a health panelen nincs |
| Docker konténerek | `MISSING` | — |
| Incidens-előzmény | `MISSING` | — |
| Elavult ellenőrzés jelzése | `COMPLETE` | `stale` mező |

---

## 5. Discord (12–24. pont)

| Követelmény | Állapot | Mérés |
|---|---|---|
| Persistent Message Engine | `COMPLETE` | élesben végigpróbálva: `created → skipped → edited → recreated` |
| hash-alapú kihagyás | `COMPLETE` | élesben `skipped → skipped → skipped` |
| elosztott zár | `COMPLETE` | Postgres, egyidejűséggel mérve |
| helyreállítás törölt üzenetre | `COMPLETE` | élesben, kézi törléssel |
| retry / backoff | `COMPLETE` | tesztelve |
| Discord REST kliens | `COMPLETE` | token-szivárgás mérve |
| jogosultság-ellenőrzés | `COMPLETE` | `BigInt`, owner/admin felülírás |
| guild-elkülönítés | `COMPLETE` | `guild_id` a `WHERE`-ben, tesztelve |
| worker-kör | `COMPLETE` | élesben fut |
| Persistent Message admin UI | `PARTIAL` | lista, engedélyezés, resync, előnézet **van**; **create / edit / delete / test / recreate / history** a felületen **nincs** |
| Üzenettípus: `yume_statistics` | `COMPLETE` | élesben |
| `system_health` | `COMPLETE` | élesben |
| `provider_status` | `COMPLETE` | élesben |
| `latest_releases` | `PARTIAL` | kód kész, élesben nincs beállítva |
| `server_statistics` | `MISSING` | gateway kellene hozzá |
| `anime_schedule` | `MISSING` | — |
| `popular_anime` | `MISSING` | — |
| `bot_status` | `MISSING` | — |
| **Discord OAuth** | `MISSING` | nincs kód, és nincs `DISCORD_CLIENT_SECRET` |
| **Discord Gateway service** | `MISSING` | nincs folyamat, nincs konténer |
| Guild overview / member / channel / role analytics | `MISSING` | gateway nélkül nincs adatforrás |
| Command analytics | `MISSING` | nincs parancs implementálva |
| Notification analytics | `PARTIAL` | `webhook_deliveries` 1651 sor van; Discord-oldali nincs |
| Bot health | `PARTIAL` | `GET /status` mondja, be van-e kötve; gateway-metrika nincs |
| Discord audit log | `COMPLETE` | `audit_logs`, 4 új művelettel |
| `discord.animehub.hu` | `BLOCKED → részben elhárítható` | DNS kész, **Caddy-blokk hiányzik** → ma `HTTP 525` |

---

## 6. Keresztmetszeti követelmények

| Követelmény | Állapot | Mérés |
|---|---|---|
| Hitelesítés minden végponton | `COMPLETE` | 401 mérve |
| Jogosultság szerveroldalon | `COMPLETE` | `requirePermission` / `holds` |
| Guild-elkülönítés | `COMPLETE` | tesztelve, szabotázzsal is |
| Bemenet-ellenőrzés | `COMPLETE` | séma minden végponton |
| Rate limiting | `COMPLETE` | globális, `@fastify/rate-limit` |
| Token-szivárgás | `COMPLETE` | három teszt méri |
| Audit-napló | `COMPLETE` | a Discord-műveletekre is |
| **Megőrzési házirend** | `PARTIAL` | analitikára és naplókra **van** és konfigurálható; Discord-eseményekre most készült; **dokumentálva nincs** |
| `docs/analytics-privacy.md` | `MISSING` | — |
| **Terheléses teszt** | `MISSING` | nincs k6, nincs mérés |
| Indexek | `PARTIAL` | a új tábláknál van; teljes áttekintés nincs |
| Redis | `N/A` | szándékosan nincs; a lock Postgresen |

---

## 7. Mi blokkolt, és mi nem

**Valóban blokkolt (nem rajtam múlik):**

1. **Discord OAuth** — kell `DISCORD_CLIENT_SECRET` a fejlesztői portálról, és
   a `redirect URI` regisztrálása. Enélkül a flow megírható, de nem
   ellenőrizhető, és a guild-tulajdonosok nem tudnak belépni.
2. **Gateway által gyűjtött adat** — taglétszám, üzenetszám, parancshasználat
   csak akkor létezik, ha a gateway **fut és gyűjt**. Az első valós számok a
   bekapcsolás után **napokkal** lesznek értelmesek; visszamenőleges adat
   nincs, és a 35. pont szerint kitalálni tilos.
3. **Történelmi analitika** — az `analytics_daily` ma 8 sor. A 30/90 napos
   nézetek addig „nincs elegendő adat" állapotot mutatnak, amíg a rendszer
   nem gyűjtött annyit. Ez nem hiba, hanem a 11. és 35. pont követelménye.

**NEM blokkolt, elvégezhető:**

- `discord.animehub.hu` Caddy-blokk (DNS kész)
- szerveroldali eseménybővítés
- egységes eseményséma + dedupe
- heti/havi aggregáció, percentilisek
- Overview / Timeseries / Data Quality fülek
- Persistent Message UI hiányzó műveletei
- Discord bot/API a `service_status`-ba
- Gateway-szolgáltatás váza
- privacy-dokumentáció, terheléses teszt

---

## 8. Végrehajtási sorrend

1. `discord.animehub.hu` elérhetővé tétele (Caddy)
2. Szerveroldali eseménybővítés + egységes séma + dedupe
3. Aggregáció: heti/havi, percentilisek
4. Dashboard: Overview, Timeseries, Data Quality
5. Persistent Message UI: create/edit/delete/test/recreate/history
6. Discord bot/API a rendszerállapotba
7. Gateway-szolgáltatás
8. OAuth (a titok megérkezéséig: kód + dokumentáció)
9. Privacy-dokumentáció, terheléses teszt
