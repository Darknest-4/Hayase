# YUME — production hardening, 2. kör

**Dátum:** 2026-09-16 · **Gép:** `dark-1` (83.229.82.185) · **Kiindulás:** `vps-production-audit.md`

Ez a kör az auditból megmaradt infrastruktúra-tételeket zárja le. A külső mentés
(R2) már korábban elkészült, azzal itt nem foglalkozom.

---

## Amit nem kerestem, mégis ez lett a legfontosabb

**Egy adatbázis-újraindítás megölte az API-t és a workert.** A PostgreSQL
hangolásához újra kellett indítani a konténert, és a naplóban ez fogadott:

```
throw er; // Unhandled 'error' event
error: terminating connection due to administrator command
Emitted 'error' event on BoundPool instance
```

Mindkét konténer `RestartCount: 1`-gyel jött vissza. Nem a Postgres hibázott,
és nem is egy egzotikus helyzet volt: **minden tervezett karbantartás így
végződött volna.**

Három, egymástól független út vezetett ide, és mindhármat egy hétköznapi
művelet — az adatbázis újraindítása — indította el:

1. **A kapcsolatkészletnek nem volt hibafigyelője.** A `pg` `error` eseményt
   bocsát ki, ha egy ÉPPEN NEM HASZNÁLT kapcsolaton történik baj. Az ilyen
   esemény nem tartozik egyetlen `await`-hez sem; figyelő nélkül a Node
   `EventEmitter`-e kivételt dob, és a folyamat kilép.
2. **A worker indulása nem tűrte a még induló adatbázist.** A
   `scheduleRecurring()` `57P03`-mal (`the database system is starting up`)
   elhasalt, elkapás nélkül — és a `setInterval`-ban lévő
   `void scheduleRecurring()` ugyanez volt kezeletlen elutasításként.
3. **A feladatsor lekérdező hurka kiengedte az `ECONNREFUSED`-ot.** A `claim()`
   minden körben lekérdez; ha a Postgres nem fogad, a hiba kiszállt a
   `runWorker`-ből a legfelső szintre.

Négy újraindításon át mérve:

| újraindítás | app | worker | kérések a mérés alatt |
|---|---|---|---|
| 1. (javítás előtt) | ✗ összeomlott | ✗ összeomlott | 169 sikeres, 1 hibás |
| 2. (készlet-figyelő után) | ✓ túlélte | ✗ összeomlott | 175 sikeres, 4 hibás |
| 3. (indulási védelem után) | ✓ túlélte | ✗ összeomlott | 178 sikeres, 0 hibás |
| 4. (a hurok javítása után) | ✓ **túlélte** | ✓ **túlélte** | 183 sikeres, **0 hibás** |

Az ötödik (a `random_page_cost` visszavétele) szintén nulla összeomlással ment.
A worker az újraindítás után azonnal dolgozott tovább.

---

## Tételek

### SSH-01 — nyitva marad, szándékosan

**Állapot:** ⚠️ **NEM ZÁRTAM LE.** Nem volt használható kulcs.

| | |
|---|---|
| `/root/.ssh/authorized_keys` | **1 bájt**, 0 érvényes kulcssor |
| más felhasználó kulcsai | nincs |
| `permitrootlogin` | `yes` |
| `passwordauthentication` | `yes` |
| sikertelen belépés 24 óra alatt | **29 675** |
| fail2ban | aktív, 8 cím tiltva |

A brief STEP 2-je szerint kulcs híján nem szabad hozzányúlni a
konfigurációhoz, és nem is generáltam itt kulcsot: annak a privát fele ezen a
gépen maradna, ami a tulajdonosnak használhatatlan, és önmagában is rossz
gyakorlat. **Az SSH-konfiguráció változatlan.**

A teendő változatlanul a `vps-production-audit.md` SSH-01 szakaszában.
Amíg ez nem történik meg, a fail2ban a védelem — az elmúlt 24 órában 29 675
próbálkozásból egy sem járt sikerrel.

### NET-01 — host tűzfal

**Állapot:** ✅ kész, de a valódi nyereséggel együtt kell érteni.

| | előtte | utána |
|---|---|---|
| UFW | `inactive` | `active`, indításkor bekapcsol |
| `INPUT` alapszabály | `ACCEPT` | `deny` |
| engedélyezett | — | 22, 80, 443 (v4 + v6) |
| `DEFAULT_FORWARD_POLICY` | `DROP` | `ACCEPT` |

A `FORWARD` szándékosan `ACCEPT`: az UFW a saját szabályait a Docker elé
szúrja be, és `DROP` mellett megvágná a konténerek forgalmát. Az izolációt
továbbra is a Docker `DOCKER-USER`/`DOCKER-FORWARD` láncai végzik.

**Amit ki kell mondani:** a Docker publikált portjai megkerülik az UFW `INPUT`
láncát (a `DOCKER-USER` lánc üres volt). **Az UFW tehát nem tudta volna
lezárni a 3000-est** — azt a NET-02 zárta le. Az UFW itt mélységi védelem: egy
jövőbeli, véletlenül kifelé kötött host-szolgáltatás nem lesz elérhető.

**Kizárás elleni védelem:** a bekapcsolás előtt beállítottam egy
`systemd-run --on-active=8min` időzítőt, ami magától kikapcsolta volna az
UFW-t. Csak azután állítottam le, hogy három külső csomópont visszaigazolta a
22-es elérhetőségét.

### NET-02 — a yonagi 3000-es portja

**Állapot:** ✅ kész, külső gépekről igazolva.

A `yonagi-app` a `0.0.0.0:3000`-re kötött, vagyis az alkalmazás közvetlenül
kiszolgált az internetről — TLS, biztonsági fejlécek, sebességkorlát és a
fordított proxy megkerülésével.

Változtatás előtt ellenőrizve:

| | eredmény |
|---|---|
| Caddy → app a Docker-hálózaton | **HTTP 200** (`http://yonagi-app-1:3000/`) |
| HTTPS-oldal | 200 |
| HTTP → HTTPS átirányítás | 308 |
| WebSocket-útvonal | nincs a Caddyfile-ban |
| egészségjelző | konténeren belüli (`127.0.0.1:3000/api/health`) |

Tehát a host-port fölösleges volt. A változtatás egyetlen sor:

```yaml
-      - '${APP_PORT:-3000}:3000'
+      - '${APP_BIND:-127.0.0.1}:${APP_PORT:-3000}:3000'
```

Loopback az alapértelmezés, de `APP_BIND=0.0.0.0`-val visszanyitható — a
fejlesztői `docker compose up` + `localhost:3000` munkamenet így sértetlen.

**Külső ellenőrzés** (check-host.net, négy csomópont):

| csomópont | eredmény |
|---|---|
| at1 (Ausztria) | Connection refused |
| hk1 (Hongkong) | Connection refused |
| ir2 (Irán) | Connection refused |
| nl1 (Hollandia) | Connection timed out |

Kontroll: a 443 ugyanezekről a csomópontokról **nyitva**.

**Kiesés:** ~3,5 másodperc (7 × 502 a konténercsere alatt, 117 sikeres kérés
mellett).

### VPS-03 — swap

**Állapot:** ✅ kész, újraindítás nélkül.

| | előtte | utána |
|---|---|---|
| swap | **nincs** | 2,0 GiB (`/swapfile`) |
| `vm.swappiness` | 60 | **10** |
| tartósság | — | `/etc/fstab` + `/etc/sysctl.d/99-yume-swap.conf` |
| jogosultság | — | `600 root:root` |

Az `fstab`-sort nem hittem el, hanem **kipróbáltam**: `swapoff /swapfile`,
majd `swapon -a` — pontosan az, amit a boot csinál. Visszakapcsolta.

### DB-02 — PostgreSQL hangolás

**Állapot:** ✅ kész — és az egyik javasolt érték **mérés alapján elvetve**.

Mérés hangolás előtt:

| | érték |
|---|---|
| adatbázis mérete | 1 107 MB |
| `shared_buffers` | 128 MB |
| `work_mem` | 4 MB |
| gyorsítótár-találat | 98,14% |
| ideiglenes fájlok | 391 db, **2 531 MB** |
| kapcsolatok | 12 (6 tétlen, 1 aktív), a korlát 100 |
| app + worker készlete | 20 + 20 |
| konténer memóriahasználat | 210 MiB, korlát nélkül |

Alkalmazott beállítások:

| beállítás | előtte | utána | indok |
|---|---|---|---|
| `shared_buffers` | 128 MB | **2 GB** | a teljes adatbázis elfér benne |
| `effective_cache_size` | 4 GB | **6 GB** | a gazdagépen 6,7 GB a lapcache |
| `work_mem` | 4 MB | **16 MB** | felső korlát: 40 kapcsolat × 16 MB ≈ 1,3 GB csúcs |
| `maintenance_work_mem` | 64 MB | **512 MB** | vacuum és indexépítés |
| `autovacuum_work_mem` | (örökölt) | **256 MB** | 3 munkás × 512 MB már nem elhanyagolható |
| `shm_size` | 64 MB | **1 GB** | a párhuzamos lekérdezések munkásai innen dolgoznak |
| konténer memóriakorlát | nincs | **4 GB** | egy elszabadult lekérdezéssor ne vigye el a gépet |

**A `random_page_cost`-ot NEM alkalmaztam**, pedig a terv része volt.
Beállítottam 1,1-re (a szokásos SSD-tanács), aztán megmértem — tizenöt-tizenöt
mintán, a két érték között váltogatva, hogy a bemelegedés egyiknek se
kedvezzen:

| `random_page_cost` | medián | átlag |
|---|---|---|
| **1.1** | 109,2 ms | 150,5 ms |
| **4** (alapértelmezett) | **68,9 ms** | **112,8 ms** |

A YUME keresése GIN trigram-indexeken fut, és a bitmap-olvasás után sok
jelöltet dob el a visszaellenőrzés (`kimetsu`: 1 531 jelöltből 1 502). Az
alacsony érték túlságosan indexpártivá teszi a tervezőt, és pont a
legdrágább lekérdezésünket lassítja. **Visszaállítva 4-re.**

A `work_mem`-ről is őszintén: a felhasználói rendezések 3 MB-ban elférnek
(`Sort Method: quicksort Memory: 3087kB`), tehát a 16 MB rájuk nem hat. A
2 531 MB kiömlés a kötegelt importokból származik — ott számít.

Végpontok, bemelegítve, hangolás előtt/után:

| | előtte | utána |
|---|---|---|
| `/v1/health` | 29,8 ms | 30,4 ms |
| `/v1/config` | 31,5 ms | 31,6 ms |
| `/v1/anime?limit=20` | 28,7 ms | 32,7 ms |
| `search?q=naruto` | 47,8 ms | **44,7 ms** |
| `search?q=kimetsu` | 128,3 ms | **117,6 ms** |
| `search?q=demon` | 62,2 ms | **58,3 ms** |
| `search?q=attack on titan` | 52,7 ms | **47,7 ms** |
| `search?q=támadás` | 81,0 ms | **75,4 ms** |

Az ékezetsemleges keresés szimmetriája megmaradt: `tamadas` és `támadás` is
11 találat, `orult` és `őrült` is 1.

**Kiesés:** a mérőszonda szerint a négy újraindításból az utolsó kettő alatt
**nulla** sikertelen kérés; az elsőnél 1, a másodiknál 4 (500-as).

### MON-01 — a fordított proxy monitorozása

**Állapot:** ✅ kész.

Az audit egy valódi kiesést bizonyított, amit a monitorozás nem látott: az
`app` minden jelzője zöld volt, az `api.latency_ms` rendben, és közben a
látogatók harminc másodpercig 503-at kaptak. Minden szonda **belülről** nézett.

Most a worker percenként **kívülről** kéri le a `/v1/health`-et, a Caddyn
keresztül, és megkülönbözteti a hiba fajtáját:

| kimenetel | mikor |
|---|---|
| `healthy` | 2xx |
| `http_4xx`, `http_5xx` | a kiszolgáló válaszolt, de rosszul |
| `timeout` | nem érkezett válasz időben |
| `dns_failure` | `ENOTFOUND`, `EAI_AGAIN` |
| `tcp_failure` | `ECONNREFUSED`, `EHOSTUNREACH`, `ECONNRESET` |
| `tls_failure` | tanúsítvány- és kézfogáshibák |
| `unknown` | minden más, a hibaszöveggel |

Mérőszámok: `edge.status` (0/1), `edge.latency_ms`, `edge.down_streak`.

**A riasztás sorozatra szól, nem egyetlen mintára** (figyelmeztetés 2, kritikus
5 egymás utáni hibánál). Egy elbukott szonda lehet egy eldobott csomag; ha arra
riasztanánk, a harmadik hamis riasztás után senki nem nézné őket.

Élesben mért értékek: az első minta 1 140 ms (hidegindulás: DNS + TLS
kézfogás), a beállt érték **105 ms** — jóval az 1 000 ms-os figyelmeztetési
küszöb alatt. A curl 30 ms-ához képesti különbség a valódi út ára: a
konténerből kifelé, majd a proxyn át vissza.

A szonda **nem kap biztonsági kivételt**: ugyanazon a sebességkorláton és
ugyanazon az élen megy át, mint bárki más. Ez szándékos — ha a saját védelmünk
kizárná a saját oldalunkat, azt is meg kell tudnunk. Csak a böngészőazonosítója
nevezi meg magát a naplóban.

---

## Összefoglaló táblázat

| ID | Probléma | Előtte | Utána | Ellenőrzés | Státusz |
|---|---|---|---|---|---|
| **SSH-01** | root + jelszavas SSH, kulcs nélkül | `authorized_keys` 1 bájt | **változatlan** | `sshd -T`, 29 675 sikertelen próbálkozás/24h, fail2ban aktív | ⚠️ **nyitva** |
| **NET-01** | nincs host tűzfal | UFW `inactive`, `INPUT ACCEPT` | UFW aktív, 22/80/443 | 3 külső csomópont: 22 nyitva; konténerhálózat ép | ✅ |
| **NET-02** | a yonagi 3000-es portja publikus | `0.0.0.0:3000` → 200 | `127.0.0.1:3000` | 4 külső csomópont: zárva; 443 nyitva; oldal 200 | ✅ |
| **VPS-03** | nincs swap | 0 B, swappiness 60 | 2 GiB, swappiness 10 | `swapon -a` próba, `free -h` | ✅ |
| **DB-02** | hangolatlan PostgreSQL | 128 MB puffer, 4 MB work_mem | 2 GB / 16 MB, `rpc` alapértelmezetten | keresés 128→118 ms, 15+15 mintás összehasonlítás | ✅ |
| **MON-01** | a proxy egészségét semmi nem mérte | nincs külső szonda | `edge.status`, `edge.latency_ms`, `edge.down_streak` | élesben rögzülő minták, 105 ms | ✅ |
| **APP-02** | egy DB-újraindítás megölte az appot és a workert | 2 összeomlás újraindításonként | 0 összeomlás | 4 újraindítás, 183 kérés, 0 hiba | ✅ (nem volt a listán) |

---

## Kiesés

| esemény | kiesés |
|---|---|
| yonagi-app újralétrehozás | ~3,5 s (7 × 502) |
| UFW bekapcsolás | **0** |
| swap | **0** (nem igényelt újraindítást) |
| PostgreSQL 1. újraindítás | 1 sikertelen kérés (kapcsolatbontás) |
| PostgreSQL 2. újraindítás | 4 × 500 (~4 s) |
| PostgreSQL 3–5. újraindítás | **0** |

## Visszaállítás

| változtatás | visszaállítás |
|---|---|
| UFW | `ufw disable`; `/etc/default/ufw` mentése a scratchpadben, teljes `iptables-save` is |
| yonagi 3000 | a `docker-compose.yml` mentése a scratchpadben; vagy `APP_BIND=0.0.0.0` a `.env`-be |
| swap | `swapoff /swapfile && rm /swapfile`, az `fstab`-sor törlése |
| PostgreSQL hangolás | a compose `command:` blokkjának törlése, `docker compose up -d postgres` |
| kód (készlet, worker, sor, szonda) | `git revert 80354a7c` |

## Ami nyitva maradt

1. **SSH-01** — a legfontosabb. Kulcs, majd jelszavas belépés kikapcsolása.
2. **Az origin megkerülhető** — a `83.229.82.185` közvetlenül elérhető; a
   Cloudflare-re költözés után ez lesz aktuális (a `domain.md` írja le).
3. **A `/interactions` útvonal 502** — a `yume-bot` nincs telepítve.
4. **Két halott index** (`anime_synonyms_lower_idx`, `anime_titles_lower_idx`,
   ~20 MB) — a DB-03 tétel.
5. **A YUME elérhetősége a yonagi Caddyfile-ján múlik** — a saját `caddy`
   szolgáltatása készen áll, de nem fut.

A yonagi `docker-compose.yml` változtatása a lemezen van, **commitolatlanul**:
az a projekt nem a miénk, és nem akartam a nevükben verziózni. Mentés:
`…/scratchpad/yonagi-compose.backup.yml`.
