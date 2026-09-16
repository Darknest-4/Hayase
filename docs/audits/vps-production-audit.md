# YUME — éles VPS-audit

**Dátum:** 2026-09-16 · **Gép:** `dark-1` (83.229.82.185) · **Terjedelem:** VPS, Docker, hálózat, Caddy, alkalmazás, Edge, adatbázis, mentés, titkok, naplózás, teljesítmény, függőségek, frontend, megfigyelhetőség

Ez a jelentés **mérésekre** épül, nem becslésre. Ahol szám szerepel, az egy lefuttatott parancs kimenete; ahol „nem ellenőriztem", ott ez ki van írva. Minden javítás után lefutott a teljes regresszió (840 API + 316 kliens + 43 böngészőteszt), és a javítások élesben is ellenőrizve lettek.

---

## Vezetői összefoglaló

| | darab |
|---|---|
| Talált probléma | 22 |
| Javítva és ellenőrizve | 9 |
| Dokumentálva, szándékosan nem javítva | 13 |
| Kritikus, ami **nyitva maradt** | 1 (SSH-01 — beavatkozást igényel) |

**A három legfontosabb megállapítás:**

1. **A gép SSH-n gyakorlatilag védtelen volt.** Hét nap alatt 155 125 sikertelen belépési kísérlet, semmilyen brute-force védelem, tűzfal nélkül, engedélyezett root- és jelszavas belépéssel, miközben a `/root/.ssh/authorized_keys` üres. Betörésnek nincs nyoma. Telepítettem `fail2ban`-t; az SSH-konfigurációhoz **nem nyúltam**, mert kulcs híján az kizárná a tulajdonost — lásd SSH-01.
2. **Az adatbázis nem indult volna újra magától.** A `postgres` szolgáltatásnak nem volt `restart` szabálya, miközben minden más szolgáltatásnak volt. Egy újraindítás után a YUME adatbázis nélkül jött volna vissza.
3. **Minden telepítés fél perc kiesés volt.** Nem az alkalmazás miatt — az 24 másodperc alatt egészséges lett —, hanem mert a Caddy egészségellenőrzője a konténercsere alatt DNS-hibát kapott és a következő ellenőrzésig 503-at adott. Mérve javítás után: egy teljes újratelepítés alatt 153 sikeres kérésre 1 sikertelen.

---

## 1. VPS-állapot

| | |
|---|---|
| OS | Ubuntu 24.04.4 LTS |
| Kernel | 6.8.0-124-generic |
| CPU | 4 vCPU, Intel Xeon (SapphireRapids), KVM |
| RAM | 9,7 GiB (2,2 használt, 6,4 gyorsítótár, 7,5 elérhető) |
| Swap | **nincs** |
| Lemez | 50 GB ext4, 44% használt (az audit előtt 62%) |
| Inode | 20% |
| Terhelés | 0,15 / 0,31 / 0,76 (4 magon) |
| Üzemidő | 11 nap |
| Folyamatok | 212, zombi nincs |
| Időzóna | UTC, NTP aktív, óra szinkronban |
| Hibás systemd unit | 0 |
| Cron | csak a disztribúció sajátjai (`e2scrub_all`, `sysstat`); saját crontab nincs |

A gépen **két projekt** fut: a YUME és a `YonagiFansub`. Ez több megállapítás hátterében ott van.

## 2. Docker-állapot

| konténer | kép | állapot | újraindítás | memória | korlát |
|---|---|---|---|---|---|
| yume-app-1 | yume-app | healthy | 0 | 49,6 MiB | 768 MB / 256 PID |
| yume-worker-1 | yume-worker | healthy | 0 | 60,6 MiB | 512 MB / 256 PID |
| yume-postgres-1 | postgres:16-alpine | healthy | 0 | 660 MiB | nincs |
| yume-backup-1 | postgres:16-alpine | fut | 0 | 3,6 MiB | nincs |
| pgfwd | alpine/socat | fut | 0 | 1,0 MiB | nincs |

Privilegizált konténer nincs. Az `app` és a `worker` `node` felhasználóként fut. Újraindítási hurok sehol. A `yonagi-*` konténerek külön projekthez tartoznak, nem módosítottam őket.

## 3. Hálózat

Kívülről elérhető portok (ellenőrizve a publikus IP-n):

| port | szolgáltatás | indokolt? |
|---|---|---|
| 22 | SSH | igen |
| 80, 443 | Caddy | igen |
| 3000 | **yonagi-app, közvetlenül** | **nem** — lásd NET-02 |

A PostgreSQL **nincs publikálva**. A `pgfwd` a 15432-t csak a `127.0.0.1`-re köti (teszteszköz). Az útvonal `Internet → Caddy → YUME app → Postgres` zárt.

## 4. Caddy

Az **élő** konfiguráció a `/opt/YonagiFansub/Caddyfile` — a YUME saját `caddy` szolgáltatása nem fut, a 80/443-at a másik projekt Caddy-je tartja, és a YUME-ot is az szolgálja ki. A repóbeli `infrastructure/reverse-proxy/Caddyfile` **nem** az élő konfiguráció.

* TLS 1.3, Let's Encrypt, érvényes 2026-12-03-ig, `Verify return code: 0`
* HTTP/2 működik, HTTP/3 hirdetve (`alt-svc: h3`)
* Tömörítés: zstd + gzip, a `style.css`-en **80% megtakarítás** (208 034 → 41 306 bájt)
* HSTS a Caddy-tól; a **többi biztonsági fejlécet az alkalmazás állítja** (CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy`, COOP, `X-Permitted-Cross-Domain-Policies`) — a Caddy minimalizmusa ezért nem hiányosság
* **IP-hamisítás nem lehetséges** — mérve: öt kérés hamisított `X-Forwarded-For`-ral és egy `Forwarded`-del, a sebességkorlát számlálója végig a valódi címhez tapadt (297→290, monoton). `TRUST_PROXY=172.16.0.0/12`, a Caddy a `172.20.0.6`.

## 5. Alkalmazás

Hitelesítés: Bearer-only API, forgó frissítő token `httpOnly`/`Secure`/`SameSite=Strict` sütiben, 15 perces hozzáférési token munkamenet-azonosítóval. A kijelentkezés visszavonja a munkamenetet, a jelszóváltás minden eszközt kiléptet.

Megkerülési kísérletek éles kóddal, mind **elutasítva**:

| kísérlet | eredmény |
|---|---|
| `alg:none`, aláírás nélkül | 401 |
| `alg:NONE` (kis/nagybetű) | 401 |
| üres HMAC-titokkal aláírva | 401 |
| RS256-nak vallja magát (algoritmus-keveredés) | 401 |
| lejárt token | 401 |
| idegen `sub`, rossz titok | 401 |
| `crit:` ismeretlen kiterjesztés | **200 → a frissítés után 401** |

Útvonalbejárás (`/../etc/passwd`, `--path-as-is`): **403**. A `/.env` 200-at ad, de az az SPA visszaesése (index.html), titkot nem tartalmaz — ezt a `static-exposure.test.ts` is őrzi.

SQL-injekció: minden lekérdezés paraméterezett; a `security.test.ts`, `adversarial.test.ts`, `idor.test.ts`, `ssrf.test.ts`, `csrf.test.ts` együtt 239 állítással zöld.

## 6–7. Biztonság és Edge

Az Edge élő állapota: `enabled: true`, **`dryRun: true`** — kiértékel és naplóz, de nem hajt végre tiltást (a `site_settings`-ben nincs `edge` sor, tehát az alapértelmezés érvényes). Hét nap alatt 1 blokk-döntés és 1 WAF-találat: a támadási forgalom ezen a gépen SSH-n érkezik, nem HTTP-n.

Az Edge tesztek (`edge`, `edge-waf`, `edge-integration`) és a biztonsági suite-ok együtt **239/239** zöld. Az él hibája nem okoz kiesést (`failure is not an outage` teszt), a hitelesítési és admin útvonalak `fail-closed`-ok.

## 8. Adatbázis

PostgreSQL 16.15. Kapcsolatok: 7 a 100-ból. Gyorsítótár-találat **98,16%**. Holtpont a statisztikában 3 — mindhárom a **teszt-adatbázisban** keletkezett tesztek között (`DELETE FROM anime` vs. a könyvtárvető), éles forgalomban nem.

Legnagyobb táblák: `episodes` 228 MB, `watch_progress` 215 MB, `anime` 128 MB, `anime_synonyms` 105 MB. Az autovacuum fut, a legnagyobb holt-sor arány 8,8% (`system_metrics_2026_09`).

Éles hibanapló az elmúlt 24 órában: **0 db 5xx az alkalmazásból** (135× 200, 4× 401, 2× 204). A feladatsor: **0 függő, 0 feladott** mind a nyolc sorban; az órás karbantartás egy kísérletből lefut.

## 9. Mentés és helyreállítás

Naponta 03:00 UTC, 14 napos megőrzés, 22 mentés a köteten, egyenként ~104 MB.

**Valódi visszaállítási próbát végeztem** egy külön adatbázisba (`yume_restore_test`), nem csak a fájl létezését néztem:

| | éles | visszaállított |
|---|---|---|
| anime / episodes / users | 32 536 / 364 064 / 5 | **egyezik** |
| library_entries / watch_progress | 32 390 / 364 064 | **egyezik** |
| anime_synonyms / security_logs | 224 347 / 6 887 | **egyezik** |
| táblák / indexek / függvények / kiterjesztések | 164 / 421 / 122 / 5 | **egyezik** |

A helyreállíthatóság tehát bizonyított. A próba-adatbázist eldobtam.

## 10. Titkok

| hely | állapot |
|---|---|
| `/opt/yume/.env` | **SECRET FOUND** — 7 kulcs; jogosultság `0600 root:root`, gitignorálva |
| konténer-környezet (`docker inspect`) | **SECRET FOUND** — `JWT_SECRET` (64), `DATABASE_URL`, `POSTGRES_PASSWORD` (44) |
| git history (1945 commit) | **tiszta** — minden találat dokumentáció vagy tesztfixtúra (`'B'.repeat(64)`, `'short-secret'`) |
| webhook-cél | Discord webhook URL az adatbázisban (rendeltetésszerű) |

**Kiszivárgott titkot nem találtam.** A `LOAD_TEST_KEY` szerepel a `.env`-ben, de a compose **nem adja át az appnak** — ellenőrizve a futó konténerben: nincs beállítva, a sebességkorlát-kerülés nem aktív.

## 11. Naplózás

Journal 424 MB. Az alkalmazás strukturált JSON-t naplóz; a `Authorization` fejléc a Caddy naplójában `REDACTED`. Érzékeny adatot a naplókban nem találtam. A biztonsági napló böngészőazonosítót 500 karakteren vág.

## 12. Teljesítmény (mérve, éles rendszeren)

| végpont | p50 | p95 | p99 |
|---|---|---|---|
| `/v1/health` | 30,2 ms | — | — |
| `/v1/config` | 31,6 ms | 46,7 ms | 47,9 ms |
| `/v1/anime?limit=20` | 31,6 ms | 45,7 ms | 46,1 ms |
| `/v1/anime/search?q=naruto` | 44,4 ms | 52,4 ms | 55,9 ms |
| `/` (SPA) | 30,0 ms | 42,0 ms | 42,3 ms |

Böngészési rendezések az új indexek előtt/után: `newest` **56,3 → 30,7 ms**, `title` 30,8 ms. Adatbázis-szinten `31,3 ms → 0,162 ms` és `34,0 ms → 0,217 ms`.

Rendszerszint a mérés pillanatában: CPU 32,4%, memória 24,8%, lemez 43,3%, API-késleltetés 5,5 ms, DB-késleltetés 24,3 ms.

## 13. Függőségek

`npm audit` az audit elején: **2 kritikus** (`fast-jwt` ≤ 6.2.3, hat riasztás). Az audit végén: **0**.

## 14. Frontend

49 ES-modul, 872 kB JS, 281 kB CSS, build lépés nélkül. Tömörítve a CSS 41 kB. A 304-es újraellenőrzés működik. Minden statikus fájl `cache-control: public, max-age=0` — lásd FE-01.

## 15. Megfigyelhetőség

24 mérőszám percenként: CPU (terhelés, magonként, százalék), memória, swap, lemez (használat, IOPS, várakozás, átvitel), hálózat (átvitel, késleltetés, csomagvesztés), feladatsor (függő, halott), API- és DB-késleltetés, mentés kora, üzemidő. Ez erős lefedettség.

**Egy rés van:** a fordított proxy egészségét semmi nem méri — és a mai kiesés pont ott volt.

---

## 16–18. Talált hibák, javítások, státusz

### Javítva és ellenőrizve

---
**ID:** VPS-01 · **Súlyosság:** CRITICAL · **Komponens:** SSH / gazdagép

**Probléma:** Semmilyen brute-force védelem nem futott egy jelszóval védett, root-belépést engedő SSH-n, tűzfal nélkül.

**Bizonyíték:** 7 nap alatt **155 125** sikertelen belépés (`journalctl -u ssh`); a legaktívabb támadó 12 320 kísérlettel. `fail2ban`, `sshguard`, `crowdsec`: egyik sem telepítve. `ufw`: inaktív. `iptables -S INPUT`: `-P INPUT ACCEPT`. A `/root/.ssh/authorized_keys` **1 bájt** — kulcs nincs.

**Hatás:** A root jelszó volt az egyetlen védelem napi ~22 000 találgatás ellen. Sikeres találat teljes gépátvétel.

**Gyökérok:** A gép alapállapotban maradt; a védelem soha nem került fel.

**Javítás:** `fail2ban` telepítve és indításkor engedélyezve. Szándékosan engedékeny beállítás: 5 hibás próbálkozás 10 percen belül, **1 órás, magától feloldódó tiltás**, és a tulajdonos öt megfigyelt címe, a loopback és a Docker-hálózatok mentesülnek. Az SSH-konfigurációhoz nem nyúltam.

**Ellenőrzés:** Hat másodperccel az indítás után 4 támadó cím tiltva; a tiltás az nftables `f2b-table` halmazában érvényesül. A 22-es port továbbra is fogad kapcsolatot, egyik saját cím sincs tiltva.

**Státusz:** ✅ javítva — de a valódi megoldás SSH-01 alatt, nyitva.

---
**ID:** DOCKER-01 · **Súlyosság:** HIGH · **Komponens:** docker-compose

**Probléma:** A `postgres` szolgáltatásnak nem volt `restart` szabálya.

**Bizonyíték:** `docker inspect yume-postgres-1 → RestartPolicy: no`, miközben `app`, `worker`, `caddy`, `backup` mind `unless-stopped`.

**Hatás:** Újraindítás, összeomlás vagy Docker-daemon-frissítés után az adatbázis nem jön vissza, a többi szolgáltatás viszont igen — és egy nem létező kiszolgálóra indulnak újra körbe-körbe. Teljes, néma kiesés.

**Gyökérok:** Kimaradt sor a compose-ban.

**Javítás:** `docker update --restart unless-stopped yume-postgres-1` (élesben, **újraindítás nélkül**) + `restart: unless-stopped` a `docker-compose.yml`-be.

**Ellenőrzés:** Az élő policy `unless-stopped`, a konténer indítási ideje változatlan (11 napja fut).

**Státusz:** ✅ javítva

---
**ID:** CADDY-01 · **Súlyosság:** HIGH · **Komponens:** fordított proxy

**Probléma:** Minden telepítés ~30 másodperc kiesést okozott.

**Bizonyíték:** Caddy-napló: `"Get http://yume-app-1:4000/v1/health: dial tcp: lookup yume-app-1 on 127.0.0.11:53: server misbehaving"`, majd `"no upstreams available"` → **503** a `/healthz`, `/v1/config` és `/v1/auth/permissions` kérésekre, miközben a konténer 24 másodperc alatt `healthy` lett, és a Caddyból közvetlenül kérve az app `{"status":"ok"}`-t adott.

**Hatás:** A konténer újralétrehozásakor a Caddy DNS-hibát kap, leírja az upstreamet, és a következő ellenőrzésig (`health_interval 30s`) mindenkinek 503-at ad. Ma ez négyszer fordult elő.

**Gyökérok:** Aktív egészségellenőrzés hosszú intervallummal, visszavonulási logika nélkül. Egy kérés azonnal elhasalt ahelyett, hogy megvárta volna a felálló upstreamet.

**Javítás:** `health_interval 5s`, `health_timeout 3s`, `lb_try_duration 20s`, `lb_try_interval 500ms` a YUME blokkban. A Caddyfile **közös a másik projekttel**, ezért mentés → `caddy validate` → kecses `caddy reload`.

**Ellenőrzés:** Fél másodpercenkénti kopogtatás egy teljes `--force-recreate` telepítés alatt: **153 sikeres, 1 sikertelen** — és az az egy is kapcsolatbontás a konténercsere pillanatában, nem 503. Mindkét oldal (yumee és yonagifansub) 200-at ad.

**Státusz:** ✅ javítva

---
**ID:** APP-01 · **Súlyosság:** HIGH · **Komponens:** keresés

**Probléma:** Az ékezetsemleges keresés fel volt építve, tesztelve volt, indexelve volt — és soha egyetlen lekérdezés nem hívta meg.

**Bizonyíték:** A 0022-es migráció azért készült, hogy „nobody types »támadás« on a phone — they type »tamadas«". Létrehozta a `yume_unaccent` függvényt és három GIN trigram-indexet rá; a `hungarian-text.test.ts` őrizte, hogy a függvény hajtogat és immutable. A `grep -rn unaccent apps/api/src` **üres**. A három index `idx_scan = 0` volt az adatbázis létrehozása óta, 62 MB-on. Élesben mérve: **„Őrült" → 0 találat, „Orult" → 1**; „támadás" → 2, „tamadas" → 9.

**Hatás:** Aki helyesen írta a magyart, kevesebbet talált, mint aki nem — egy magyar oldalon.

**Gyökérok:** Az építőelem elkészült, a bekötése elmaradt. A tesztek az elemet mérték, nem a használatát.

**Javítás:** A hajtogatás a jelöltválasztást **kiváltja**, nem egészíti ki (a hajtogatott trigramhalmaz a nyers bővebb halmaza). Új 55-ös rangsorszint a hajtogatott egyezésnek, a „tartalmazza" (60) alatt és a teljes szöveges találat (40) fölött. A rangsor nyers marad, tehát a pontos betűzés továbbra is előrébb kerül.

**Ellenőrzés:** Élesben, telepítés után: „tamadas" 11 ↔ „támadás" 11 (korábban 9 ↔ 2), „Orult" 1 ↔ „Őrült" 1. Új `search-accents.test.ts` (8 állítás) a szimmetriát rögzíti, nem a „talál valamit"-et. A régi predikátum 0 sort talál ott, ahol az új 1-et — a teszt tehát valódi.

**Megjegyzés a költségről, őszintén:** a hajtogatott kifejezés-index heap-ellenőrzésénél a `yume_unaccent()` minden jelölt soron újra lefut. A hasonlóság-igényes kérdések ezért drágábbak: `kimetsu` 99,4 → 128,3 ms, `támadás` 58,6 → 96,3 ms; másutt nem romlott vagy javult (`naruto` 53,6 → 47,8, `attack on titan` 75,3 → 52,7). Ez az ékezetsemlegesség ára. Csökkenthető egy tárolt, generált oszloppal — lásd „Ajánlott következő lépések".

**Státusz:** ✅ javítva

---
**ID:** DB-01 · **Súlyosság:** MEDIUM · **Komponens:** katalógus-böngészés

**Probléma:** A „legújabb" és a „cím szerint" rendezés minden kérésnél végigolvasta a katalógust.

**Bizonyíték:** `EXPLAIN ANALYZE`: `Seq Scan on anime (actual rows=30828)` + `top-N heapsort`, **31,3 ms** és **34,0 ms**. Végponton `sort=newest` 56,3 ms, szemben a rendezés nélküli 31 ms-mal. A 0049-es migráció három rendezéshez adott indexet, ezt a kettőt szándékosan kihagyta, ezzel a feltétellel: „ha egyszer forró útra kerül, akkor kap".

**Hatás:** A válaszidő fele a rendezésre ment el egy felületen, amit a katalógus rendezőválasztója felkínál.

**Gyökérok:** A 0049 feltétele teljesült, de nem volt telemetria, ami jelezte volna.

**Javítás:** `0054_browse_newest_title_indexes.sql` — két részleges index a 0049 mintájára (`WHERE visibility = 'public'`, `(sort_value, id)`).

**Ellenőrzés:** `Index Scan using anime_browse_newest_idx`, **0,162 ms**; `anime_browse_title_idx`, **0,217 ms**. Végponton `newest` 56,3 → 30,7 ms.

**Státusz:** ✅ javítva

---
**ID:** DEP-01 · **Súlyosság:** jelentve CRITICAL, ténylegesen LOW · **Komponens:** `@fastify/jwt` / `fast-jwt`

**Probléma:** Hat riasztás a hitelesítési könyvtárban, köztük „JWT auth bypass" és „Identity/Authorization Mixup".

**Bizonyíték:** `npm audit`: 2 kritikus. A YUME beállítása: statikus HMAC-titok, nincs aszinkron kulcsfeloldó, nincs ellenőrzési gyorsítótár, nincs `allowed*` RegExp, nincs aszimmetrikus kulcs. Hat kihasználási kísérlet a **valódi** beállítással: öt elutasítva, egy (`crit` fejléc) reprodukálható — de ahhoz érvényes aláírás kell, tehát a támadó már birtokolja a titkot.

**Hatás:** A jelentett kritikus besorolás ebben a konfigurációban nem áll meg. A `crit`-eltérés szabványsértés, nem megkerülés.

**Gyökérok:** Elavult függőség.

**Javítás:** `@fastify/jwt` 9.1.0 → 10.2.2 (`fast-jwt` 5.0.6 → 6.3.3). A használt felület három hívás, mind változatlan.

**Ellenőrzés:** `npm audit`: **0 sebezhetőség**. A `crit` fejléc most **401**. Teljes regresszió zöld, e2e 43/43, élesben a hitelesítés működik.

**Mellékhatás, kezelve:** a fast-jwt 6 **felülírja** a payloadban megadott `exp`-et az `expiresIn`-nel, ezért az `adversarial.test.ts` lejárt-token mintája némán érvényes tokent kezdett gyártani. A termék viselkedése végig helyes volt (a valóban lejárt token 401), a teszt avult el — most visszadátumozott `iat`-tal dolgozik, és előbb **állítja**, hogy a token tényleg lejárt.

**Státusz:** ✅ javítva

---
**ID:** VPS-02 · **Súlyosság:** MEDIUM · **Komponens:** lemez

**Probléma:** 10,22 GB Docker build cache és 3 kilépett terhelésmérő konténer, 62%-os lemeztelítettség mellett.

**Bizonyíték:** `docker system df`: Build Cache 10,22 GB (6,79 GB visszanyerhető); `/var/lib/containerd` 14 GB.

**Hatás:** 19 GB szabad hely egy 50 GB-os lemezen, miközben a mentések naponta ~104 MB-tal nőnek.

**Javítás:** `docker builder prune -af`, `docker image prune -f`, a kilépett terhelésmérő konténerek eltávolítása. A futó képfájlokat nem érintette.

**Ellenőrzés:** **62% → 44%**, 19 GB → 27 GB szabad.

**Státusz:** ✅ javítva

---
**ID:** DOCKER-02 · **Súlyosság:** MEDIUM · **Komponens:** konténer-jogosultságok

**Probléma:** A YUME konténerei a Docker alapértelmezett képességkészletével futottak, jogosultság-emelés tiltása és folyamatkorlát nélkül.

**Bizonyíték:** `docker inspect`: `SecurityOpt: []`, `CapDrop: []`, `PidsLimit: <nil>`.

**Javítás:** `security_opt: ['no-new-privileges:true']`, `cap_drop: ['ALL']`, `deploy.resources.limits.pids: 256` az `app` és a `worker` alatt. (A `pids` a `deploy.resources.limits` alá került, mert a szolgáltatás-szintű `pids_limit` ütközik vele.)

**Ellenőrzés:** Mindkét konténer `healthy`, `secopt=[no-new-privileges:true] capdrop=[ALL] pids=256`, az oldal és a keresés 200.

**Státusz:** ✅ javítva

---
**ID:** TEST-01 · **Súlyosság:** MEDIUM · **Komponens:** teszt-infrastruktúra

**Probléma:** A `scripts/database/test-db.sh` az éles mentésből töltötte fel a teszt-adatbázist, és ott megállt — a séma annyira régi lett, mint a dump.

**Bizonyíték:** Egy teljes futás **27 csomagot** bukott el `relation "edge_bans" does not exist` hibával, és a hibaüzenet a tesztekre mutatott, nem a szkriptre.

**Javítás:** A szkript a visszaállítás után lefuttatja a hiányzó migrációkat. (Ugyanez a gondolat került a `restore.sh`-ba a fantom mentéskérésekre — lásd a mai korábbi commitot.)

**Ellenőrzés:** A teljes csomag ezután 840/840.

**Státusz:** ✅ javítva

---

### Dokumentálva, szándékosan nem javítva

---
**ID:** SSH-01 · **Súlyosság:** CRITICAL · **Komponens:** SSH · **Státusz:** ⚠️ **NYITVA — beavatkozást igényel**

**Probléma:** `PermitRootLogin yes` + `PasswordAuthentication yes`, miközben SSH-kulcs egyáltalán nincs beállítva.

**Bizonyíték:** `sshd -T`: `permitrootlogin yes`, `passwordauthentication yes`, `maxauthtries 6`. `/root/.ssh/authorized_keys`: 1 bájt (üres). 30 nap alatt 85 sikeres root-belépés, mind **jelszóval**, öt magyar címtartományból.

**Miért nem javítottam:** Kulcs híján a jelszavas belépés kikapcsolása **azonnal kizárná a tulajdonost a saját gépéből**. Ez pontosan az a beavatkozás, amit a feladat kifejezetten tilt automatikusan elvégezni.

**Betörésre utaló jel nincs:** egyetlen `uid=0` fiók, a `/etc/passwd` 2025 márciusa óta változatlan, minden sikeres belépés a tulajdonos címtartományaiból, gyanús kimenő kapcsolat nincs.

**Pontos javítási terv — ebben a sorrendben, és a 3. lépés előtt hagyd nyitva a jelenlegi munkamenetet:**

1. A saját gépeden: `ssh-keygen -t ed25519 -C "yume-vps"`
2. `ssh-copy-id -i ~/.ssh/id_ed25519.pub root@83.229.82.185`
3. **Egy MÁSIK terminálból** ellenőrizd, hogy kulccsal be tudsz lépni: `ssh -i ~/.ssh/id_ed25519 root@83.229.82.185`. Amíg ez nem sikerül, ne menj tovább.
4. Csak ezután, a VPS-en:
   ```
   printf 'PasswordAuthentication no\nPermitRootLogin prohibit-password\nKbdInteractiveAuthentication no\n' > /etc/ssh/sshd_config.d/99-hardening.conf
   sshd -t && systemctl reload ssh
   ```
5. Harmadik terminálból ellenőrizd újra a belépést, **mielőtt** bezárnád a meglévőket.

Ezután a fail2ban másodlagos védelemmé válik, és a napi 22 000 találgatás tárgytalan lesz.

---
**ID:** NET-01 · **Súlyosság:** HIGH · **Komponens:** tűzfal · **Státusz:** ⚠️ nyitva

**Probléma:** Nincs gazdagép-tűzfal. `ufw`: inaktív. `iptables -S INPUT`: `-P INPUT ACCEPT`.

**Miért nem javítottam:** Tűzfal bekapcsolása az egyetlen elérési úton (SSH) kizárási kockázat, és a feladat ezt kifejezetten tiltja. Ráadásul a Docker saját `nftables`-szabályokat kezel; egy rosszul sorrendezett UFW-szabály a konténerhálózatot is elvághatja.

**Javítási terv (az SSH-01 4. lépése után, és csak nyitott munkamenet mellett):**
```
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80,443/tcp
ufw allow 3000/tcp          # csak ha a NET-02 szerint marad
ufw --force enable
```
A Docker publikált portjai megkerülik az UFW `INPUT` láncát (a `DOCKER-USER` láncba kerülnek), tehát a 80/443/3000 a Docker miatt marad elérhető; a szabály a **gazdagép** szolgáltatásait védi.

---
**ID:** NET-02 · **Súlyosság:** MEDIUM · **Komponens:** portkitettség · **Státusz:** ⚠️ nyitva

**Probléma:** A 3000-es port az internet felé nyitva, és a `yonagi-app`-ot **közvetlenül** szolgálja ki — Caddy nélkül, tehát TLS, biztonsági fejlécek és sebességkorlát nélkül.

**Bizonyíték:** `0.0.0.0:3000->3000/tcp`, `http://83.229.82.185:3000/` → **200**. A `yonagi-caddy-1` ugyanezt a konténert a `yonagi_default` hálózaton is eléri (`reverse_proxy yonagi-app-1:3000`).

**Miért nem javítottam:** Ez a **másik projekt** konfigurációja. A publikálás valószínűleg felesleges (a Caddy a Docker-hálózaton át éri el), de ezt a YonagiFansub tulajdonosának kell megerősítenie.

**Javítási terv:** a `/opt/YonagiFansub/docker-compose.yml`-ben `ports: ['3000:3000']` → `expose: ['3000']`, majd `docker compose up -d app`. Ellenőrzés: `https://yonagifansub.duckdns.org/` továbbra is 200, `http://83.229.82.185:3000/` már nem válaszol.

---
**ID:** VPS-03 · **Súlyosság:** MEDIUM · **Komponens:** memória · **Státusz:** ⚠️ nyitva

**Probléma:** Nincs swap (`swapon --show` üres), miközben `vm.swappiness = 60`.

**Hatás:** Memórianyomás alatt nincs lassuló fokozat — az OOM-killer azonnal folyamatot lő ki. 9,7 GiB mellett ma bőséges a tartalék (24,8% használt), de egy elszabadult import vagy egy nagy `work_mem`-es lekérdezéssor azonnal kilövéshez vezet.

**Javítási terv (nem igényel újraindítást):**
```
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl -w vm.swappiness=10        # SSD mellett alacsony érték a helyes
```

---
**ID:** DB-02 · **Súlyosság:** MEDIUM · **Komponens:** PostgreSQL hangolás · **Státusz:** ⚠️ nyitva

**Probléma:** A PostgreSQL a Docker-alapértelmezéseken fut egy 9,7 GiB-os gépen: `shared_buffers 128MB`, `work_mem 4MB`.

**Bizonyíték:** A hat keresési trigram-index együtt **88 MB** — a 128 MB-os pufferkészlet nagyobb részét egyetlen funkció foglalja. `pg_stat_database.temp_files = 379`: lekérdezések lemezre csordulnak, mert nem férnek a `work_mem`-be.

**Miért nem javítottam:** Mindkét beállítás **újraindítást igényel** (`shared_buffers` mindenképp), ami rövid kiesés. Az audit nem állíthat le adatbázist a tulajdonos döntése nélkül.

**Javítási terv:** a `docker-compose.yml` `postgres` szolgáltatásához:
```yaml
    command: >
      postgres -c shared_buffers=2GB -c effective_cache_size=6GB
               -c work_mem=16MB -c maintenance_work_mem=512MB
               -c random_page_cost=1.1
```
majd `docker compose up -d postgres` (~5 mp kiesés). Utána érdemes újramérni a keresést: az APP-01 maradék költségének egy része innen jöhet.

---
**ID:** DB-03 · **Súlyosság:** LOW · **Komponens:** indexek · **Státusz:** ⚠️ nyitva

**Probléma:** Két index soha nem szolgált ki olvasást: `anime_synonyms_lower_idx` (15 MB) és `anime_titles_lower_idx` (4,6 MB).

**Bizonyíték:** `idx_scan = 0` az adatbázis létrehozása óta. A `lower()` összehasonlítások a rangsoroló `CASE`-ben vannak, nem a `WHERE`-ben, ezért a tervező sosem nyúl hozzájuk.

**Javítási terv:** migráció `DROP INDEX CONCURRENTLY`-vel. ~20 MB és némi írási költség nyereség; a kockázat alacsony, de nem nulla, ezért nem az audit alatt.

---
**ID:** CADDY-02 · **Súlyosság:** LOW · **Komponens:** fordított proxy · **Státusz:** ⚠️ nyitva

**Probléma:** A `/interactions` útvonal a `yume-bot-1:4100` upstreamre mutat, ami **nem létezik**.

**Bizonyíték:** `POST /interactions` → **502**; `dial tcp: lookup yume-bot-1 ... server misbehaving`. `docker ps -a`: nincs `yume-bot` konténer.

**Hatás:** Ha ez egy Discord-alkalmazás interakciós végpontja, a Discord hibásnak jelöli. Emellett a Caddy hibanaplóját is zajosítja.

**Miért nem javítottam:** Nem tudom, a bot telepítése halasztódott-e vagy elhagyták. A route törlése termékdöntés.

---
**ID:** MON-01 · **Súlyosság:** MEDIUM · **Komponens:** megfigyelhetőség · **Státusz:** ⚠️ nyitva

**Probléma:** A fordított proxy egészségét semmi nem méri.

**Bizonyíték:** A CADDY-01 kiesése alatt az `app` konténer végig `healthy` volt, az `api.latency_ms` metrika rendben; a látogatók viszont 503-at kaptak. A monitorozás **nem látta**.

**Javítási terv:** a worker metrikagyűjtője kérjen le egy külső URL-t (`https://yumee.duckdns.org/v1/health`) és rögzítsen `edge.status` + `edge.latency_ms` mérőszámot. Ez a kívülről látható elérhetőséget méri, nem a belsőt — pontosan azt, ami ma hiányzott.

---
**ID:** DATA-01 · **Súlyosság:** LOW · **Komponens:** adatminőség · **Státusz:** ⚠️ nyitva

**Probléma:** Az éles biztonsági napló és a látogatottsági statisztika tesztforgalommal szennyezett.

**Bizonyíték:** `register` és `login_failed` napi eloszlása: 09-06..09-12 összesen 4 esemény; **09-14: 636 + 605, 09-15: 2413 + 2103, 09-16: 183 + 113** — pontosan a terhelésmérés napjai.

**Hatás:** A fiókstatisztika, a napi aktív grafikon és a biztonsági napló ezekben a napokban félrevezető.

**Megjegyzés:** A megismétlődést a külön teszt-adatbázis már megakadályozza. A meglévő sorok törlése adatvesztéssel jár egy naplóban, ezért ezt nem tettem meg magamtól — javaslat: a 09-14…09-16 közti `register`/`login_failed` sorok megjelölése vagy törlése ellenőrzött mentés után.

---
**ID:** FE-01 · **Súlyosság:** LOW · **Komponens:** frontend gyorsítótárazás · **Státusz:** ⚠️ nyitva

**Probléma:** Minden statikus fájl `cache-control: public, max-age=0`, tehát 49 JS-modul és a CSS **minden oldalbetöltésnél újraellenőrződik**.

**Bizonyíték:** `curl -sI` a `/`, `/src/app/main.js` és `/css/style.css` címeken; a 304-es válasz működik (`If-None-Match` → 304).

**Miért nem javítottam:** Hosszabb `max-age` tartalom-hasítás nélkül **elavult kódot szolgálna ki** egy telepítés után, a projekt viszont szándékosan build lépés nélküli. A helyes megoldás vagy egy minimális hasító lépés, vagy a jelenlegi állapot elfogadása. Ez tervezési döntés, nem hiba.

---
**ID:** FE-02 · **Súlyosság:** INFO · **Komponens:** frontend · **Státusz:** ⚠️ nyitva

`/manifest.webmanifest` → 404, és az `index.html` nem is hivatkozik rá. Egy mobil-első anime-oldalnál a PWA-manifest (telepíthetőség, ikon, téma) kézenfekvő hiányzó elem.

---
**ID:** EDGE-01 · **Súlyosság:** INFO · **Komponens:** YUME Edge · **Státusz:** ⚠️ tudatos döntés

Az Edge `dryRun: true` módban fut: mindent kiértékel és naplóz, de **nem hajt végre** tiltást (a kézi tiltások száraz üzemben is hatnak). Ez az alapértelmezés, és ma védhető — a támadási forgalom SSH-n érkezik, nem HTTP-n, hét nap alatt 1 blokk-döntés született. Az éles üzemre váltás előtt érdemes néhány hétnyi száraz naplót átnézni, hogy a küszöbök ne fogjanak valódi látogatót.

---
**ID:** SEC-01 · **Súlyosság:** LOW · **Komponens:** titkok · **Státusz:** ⚠️ nyitva

A `LOAD_TEST_KEY` és a `LOAD_JWT_SECRET` benne maradt a `.env`-ben a terhelésmérés után. **Nem aktív**: a fő `docker-compose.yml` nem adja át az appnak, és a futó konténerben ellenőrizve nincs beállítva. Rendrakásként érdemes kivenni; a Biztonság képernyő ellenőrzése amúgy is figyelmeztet, ha egyszer mégis átadásra kerülne.

---
**ID:** OS-01 · **Súlyosság:** INFO · **Komponens:** gazdagép · **Státusz:** ⚠️ nyitva

Felesleges szolgáltatások futnak egy KVM-vendégen: `open-vm-tools` (VMware-hez való, ez KVM), `ModemManager`, `gpu-manager`, `multipathd`, `open-iscsi`. Egyik sem sebezhetőség önmagában, de támadási felület és RAM. Kikapcsolásuk (`systemctl disable --now`) alacsony kockázatú, de nem sürgős.

---

## 19. Kockázatok

| kockázat | valószínűség | hatás | enyhítés |
|---|---|---|---|
| Root SSH-jelszó kitalálása | a fail2ban után **alacsony**, előtte közepes | teljes gépátvétel | SSH-01 elvégzése |
| Gazdagép-szolgáltatás kitettsége tűzfal nélkül | alacsony (kevés figyel) | változó | NET-01 |
| OOM-kilövés swap nélkül | alacsony | szolgáltatáskiesés | VPS-03 |
| A `yonagi` projekt változásai megtörik a YUME proxyját | **közepes** | YUME-kiesés | közös Caddyfile — lásd alább |
| Egyetlen gép, külső mentésmásolat nélkül | alacsony | **teljes adatvesztés** | `BACKUP_SYNC_CMD` beállítása |

**Két rendszerszintű kockázat, amit érdemes kimondani:**

1. **A YUME elérhetősége egy másik projekt konfigurációs fájlján múlik.** A `/opt/YonagiFansub/Caddyfile` szolgálja ki mindkét oldalt; egy ottani elgépelés a YUME-ot is leviszi. A YUME saját `caddy` szolgáltatása készen áll a compose-ban, de nem fut.
2. **A mentések ugyanazon a lemezen vannak, mint az adatbázis.** A `backup.sh` maga figyelmeztet: „BACKUP_SYNC_CMD is not set, so backups live only on this machine". Egy lemezhiba egyszerre viszi az adatot és a mentést. A visszaállítás bizonyítottan működik — de csak amíg a lemez él.

## 20. Ajánlott következő lépések

**Ebben a sorrendben:**

1. **SSH-kulcs beállítása, majd a jelszavas belépés kikapcsolása** (SSH-01). Ez az egyetlen kritikus, ami nyitva maradt.
2. **Mentés másolása a gépről** — `BACKUP_SYNC_CMD` beállítása (rclone, scp, S3). Ez a különbség „van mentésem" és „van mentésem egy lemezhiba után" között.
3. Tűzfal (NET-01), a 3000-es port lezárása (NET-02), swap (VPS-03).
4. PostgreSQL hangolás (DB-02) — ez a keresés maradék költségének egy részét is visszaadhatja.
5. A fordított proxy monitorozása (MON-01), hogy a következő proxy-kiesést ne kézzel kelljen megtalálni.
6. **A keresés ékezetkezelésének olcsóbbá tétele:** tárolt, generált oszlop (`canonical_title_folded text GENERATED ALWAYS AS (yume_unaccent(canonical_title)) STORED`) közvetlen trigram-indexszel. Így a heap-ellenőrzés nem hívja újra a függvényt soronként. Becslés helyett: érdemes megmérni a 0054 mintájára, előtte-utána `EXPLAIN ANALYZE`-zal.
7. A YUME saját Caddy-je alá helyezése, hogy az elérhetősége ne függjön egy másik projekttől.

---

## 21. Végső ellenőrzés

| kérdés | válasz | bizonyíték |
|---|---|---|
| Minden konténer egészséges? | **igen** | `app`, `worker`, `postgres` healthy; `backup`, `pgfwd` fut (nincs healthcheckjük) |
| Van újraindítási hurok? | **nincs** | mind a négy YUME-konténer `RestartCount: 0` |
| Váratlan nyitott port? | **egy** | 3000 (yonagi) — NET-02, dokumentálva |
| Hibás szolgáltatás? | **nincs** | `systemctl --failed`: 0 unit |
| Sikertelen migráció? | **nincs** | 56 migráció, legutóbb `0054` |
| Adatbázis-hiba? | **nincs 24 órán belül éles forgalomból** | 135× 200, 4× 401, 2× 204; 0 db 5xx |
| Kritikus biztonsági lelet? | **egy, nyitva** | SSH-01 — beavatkozást igényel |
| Minden teszt zöld? | **igen** | 840 API + 316 kliens + 43 böngésző |
| YUME elérhető? | **igen** | `/` 200, 124 ms |
| Hitelesítés működik? | **igen** | érvénytelen token 401, hat megkerülési kísérlet elutasítva |
| API működik? | **igen** | `/v1/config`, `/v1/anime`, `/v1/anime/search` mind 200 |
| Média működik? | **részben** | a végpontok válaszolnak, de **videóforrás nincs feltöltve** — ez a termék ismert hiánya, nem az infrastruktúráé |
| Admin működik? | **igen** | `/v1/admin/edge` hitelesítés nélkül 401; a panel mind a 20 szekciója renderel |
| Edge működik? | **igen, száraz üzemben** | 239/239 Edge- és biztonsági teszt zöld — EDGE-01 |
| Mentés működik? | **igen, bizonyítottan** | valódi visszaállítás: 164 tábla, 421 index, minden sorszám egyezik |
| Monitorozás működik? | **igen, egy réssel** | 24 mérőszám percenként; a proxy egészsége hiányzik — MON-01 |

**Amit nem ellenőriztem, és ezért nem is állítok:** nem futtattam külső gépről terhelésmérést (a korábbi 250 egyidejű felhasználós mérés ugyanerről a gépről készült, tehát a hálózati út nincs benne); nem végeztem képernyőolvasós akadálymentességi átnézést; nem auditáltam a `yonagi` projekt kódját, csak azokat a pontjait, ahol a YUME-mal érintkezik; és nem néztem át egyenként a 368 jogosultságot.

---

*A jelentés a `claude/audit-and-audit-status-page` ágon készült. Minden javítás külön commitban, a mérési adatokkal a commit-üzenetben.*
