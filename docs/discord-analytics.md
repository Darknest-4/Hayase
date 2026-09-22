# Discord-integráció és statisztikai rendszer — üzemeltetői leírás

Ez a dokumentum azt írja le, ami **elkészült és mérve van**, és külön azt,
ami **nincs kész**. A kettőt nem keverem: egy „majdnem kész" funkció
üzemeltetői szempontból nem kész.

---

## 1. Mi működik ma, élesben

| | |
|---|---|
| Bot | `Yume#8619` (alkalmazás `1545630785447661588`) |
| Szerver | `Yume` (`1545633725130473494`) |
| Tartós üzenetek | 3 db, élő adattal |
| Frissítés | a worker `discord` sorában, percenként egy kör |

**Élő üzenetek:**

| típus | csatorna | tartalom |
|---|---|---|
| `yume_statistics` | `#daily-stats` | animék, epizódok, felhasználók, mai munkamenet és oldalletöltés |
| `system_health` | `#service-health` | komponensenkénti állapot, kerekített késleltetéssel |
| `provider_status` | `#system-metrics` | szolgáltatói kérések az elmúlt 24 órából |

A negyedik típus (`latest_releases`) készen áll, de nincs beállítva —
szándékosan: a friss epizódokat ma a **webhook-rendszer** küldi, és a kettő
együtt ugyanazt jelentené kétszer.

---

## 2. A tartós üzenet: mit jelent, és mit nem

Egy üzenet **egyszer megy ki, utána módosul**. Ez négy dolgot követel, és
mind a négy mérve van:

1. **Nincs felesleges módosítás.** A kirenderelt tartalom ujjlenyomatát
   összevetjük a tárolttal; egyezésnél a Discordot meg sem szólítjuk.
   Élesben mérve: `skipped → skipped → skipped`.
2. **Nincs duplikáció.** Elosztott zár az adatbázisban (egyetlen `UPDATE`,
   a feltétel a `WHERE`-ben), és részleges egyedi index guildre + típusra.
3. **Nincs végtelen próbálkozás.** A nem újrapróbálható hiba (jogosultság,
   hiányzó csatorna) azonnal kimeríti a számlálót; az átmeneti hiba
   exponenciálisan visszalép, és a Discord saját `retryAfter` ideje
   elsőbbséget élvez.
4. **A törölt üzenet visszajön — kontrolláltan.** Csak a „nincs ilyen
   üzenet" hiba vezet újralétrehozáshoz. Élesben végigpróbálva:
   `created → skipped → edited → recreated`, és a csatornában
   **egyetlen** üzenet maradt.

### Amit a tartalom NEM tartalmazhat

Rendereléskori időbélyeget, ingadozó számot vagy nem determinisztikus
sorrendet. Mindhárom azt okozza, hogy a tartalom minden körben „változottnak"
látszik — élesben mérve ez napi **4320 fölösleges Discord-hívás** volt. A
frissesség nem vész el: a Discord maga jelzi a „szerkesztve" bélyeggel.

---

## 3. Végpontok

Mind `/v1/discord` alatt, mind hitelesítést és **guild-szintű** jogosultságot
kíván. A prefix nem `/v1/admin`: a hozzáférést nem a YUME adminisztrátori
szerepe adja, hanem a Discord guild-jogosultsága.

```
GET    /status                                        a bot be van-e kötve
GET    /guilds/:guildId/persistent-messages           a guild üzenetei
POST   /guilds/:guildId/persistent-messages           új üzenet
PATCH  /guilds/:guildId/persistent-messages/:id       módosítás
DELETE /guilds/:guildId/persistent-messages/:id       nyilvántartásból törlés
POST   /guilds/:guildId/persistent-messages/:id/resync   kézi frissítés
GET    /guilds/:guildId/persistent-messages/:id/preview  ELŐNÉZET — nem küld
GET    /guilds/:guildId/persistent-messages/:id/history  frissítési előzmény
GET    /guilds/:guildId/channels/:channelId/diagnose     bot jogosultságai
```

### Hozzáférés

Két út vezet be:

1. **YUME `discord.manage` jogosultság** — az oldal üzemeltetőjének, Discord-fiók
   kötése nélkül. **Ez az az út, ami ma működik.**
2. **Discord guild-jogosultság** összekötött fiókon át — ehhez Discord OAuth
   kell, ami **nincs bekötve**; a `discord_links` tábla üres, tehát ezen az
   úton ma senki nem jut be. Ez helyes viselkedés: inkább senki, mint
   tévesen valaki.

A tárolt guild-tagság **öt perc után lejár**, és a lejárt adat nem jogosít.

---

## 4. Beállítás

### Környezeti változók

| változó | kötelező | mit csinál |
|---|---|---|
| `DISCORD_BOT_TOKEN` | nem | a bot tokenje. Enélkül a frissítés azonnal visszatér és megmondja, miért — **nem büntet**, a kudarcszámlálók nem nőnek |
| `DISCORD_SYNC_INTERVAL_MS` | nem | a frissítő kör üteme (alap: 60 000) |
| `DISCORD_PM_MIN_INTERVAL_MS` | nem | két frissítés közti minimum rekordonként (alap: 45 000) |
| `DISCORD_PM_MAX_FAILURES` | nem | ennyi egymás utáni kudarc után leáll (alap: 5) |
| `DISCORD_PM_BATCH` | nem | hány üzenet egy körben (alap: 25) |
| `DISCORD_PM_EVENT_DAYS` | nem | a frissítési előzmény megőrzése (alap: 30 nap) |

A tokent a `docker-compose.yml` adja tovább az `app` és a `worker`
szolgáltatásnak. **A `.env`-ben él, és sehol máshol**: nem kerül a repóba, a
naplóba, a válaszba és a hibaüzenetbe sem.

### A bot meghívása

```
https://discord.com/oauth2/authorize?client_id=<ALKALMAZÁS_ID>&scope=bot&permissions=84992
```

A `84992` pontosan négy jog: `VIEW_CHANNEL`, `SEND_MESSAGES`, `EMBED_LINKS`,
`READ_MESSAGE_HISTORY`. Ennél többet ne adj: amit nem kérünk, azt nem is
tudjuk elrontani.

### Áttérések

| | |
|---|---|
| `0067_provider_metrics.sql` | szolgáltatói mérőszámok, napi bontásban |
| `0068_persistent_messages.sql` | a tartós üzenetek nyilvántartása és előzménye |
| `0069_discord_links.sql` | YUME-fiók ↔ Discord-fiók, és a tagság gyorsítótára |
| `0070_discord_permission.sql` | a `discord.manage` jogosultság |

Mind additív (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`), destruktív lépés
nélkül. Élesen lefuttatva.

---

## 5. Ismert korlátozások

**1. Nincs gateway, tehát nincs guild-statisztika.** A bot REST-en dolgozik,
állandó WebSocket-kapcsolat nélkül. Ez elég a tartós üzenetekhez, de **nem**
elég a 8.2–8.6. és 9. ponthoz: taglétszám alakulása, üzenetszám,
csatornaaktivitás, parancshasználat — ezek mind gateway-eseményekből
jönnének. Ehhez külön szolgáltatás kell, saját életciklussal.

**2. Nincs Discord OAuth.** A `discord_links` tábla megvan, de nincs, ami
feltöltse. Guild-tulajdonosok ma nem tudnak bejelentkezni a vezérlőpultra;
csak a YUME `discord.manage` jog működik.

**3. Nincs guild-lista végpont.** A felület bekéri a szerver azonosítóját.
A bot guildjeinek lekérdezése külön kör lenne.

**4. Nincs Redis.** A 15. pont elosztott lockját **Postgres-zárral**
oldottam meg — működik és mérve van, de nem Redis.

**5. Az `analytics_daily` fiatal.** A 90 napos grafikonok jó darabig „nincs
elegendő történelmi adat" állapotot mutatnak. Ez a 8.3. pont szerinti
helyes viselkedés, nem hiba.

---

## 6. Hibakeresés

| tünet | hol nézd |
|---|---|
| nem megy ki üzenet | `GET /v1/discord/status` → `configured` |
| „nincs jogosultság" | `GET …/channels/:id/diagnose` megmondja, melyik bit hiányzik |
| ismétlődő hiba | `GET …/:id/history` — eseményenként, okkal |
| minden körben `edited` | a tartalomban ingadozó érték vagy időbélyeg van (lásd 2. pont) |
| a rekord „megállt" | `failure_count` elérte a korlátot; a felületen kapcsold ki-be |

A worker naplója körönként egy sort ír:
`[discord] tartós üzenetek: {"skipped":2,"edited":1}`

---

## 7. Következő lépések

1. **Discord OAuth** (`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
   redirect URI) — ez nyitja meg a guild-tulajdonosoknak a hozzáférést.
2. **Gateway-szolgáltatás** a tagstatisztikához. Külön konténer, külön
   életciklus: egy bot-újraindítás nem állíthatja meg a weboldalt.
3. **`discord.animehub.hu`** — ha külön néven kell a vezérlőpult, ahhoz
   DNS-rekord és Caddy-blokk kell.
