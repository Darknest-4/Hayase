# Discord — telepítés és üzemeltetés

A Yume Discord szerverét nem kézzel kell összekattintani. Van egy **blueprint**
(`bot/src/blueprint.ts`), ami leírja a teljes struktúrát — rangok, kategóriák,
csatornák, jogosultságok, slowmode-ok, webhookok —, és egy **provisioner**, ami
ezt ráilleszti egy Discord szerverre.

Két tulajdonság, ami miatt ez nem egy egyszeri script:

- **Újrafuttatható.** Ami már létezik, azt megkeresi és felhasználja. Nem hoz
  létre duplikátumot, és **soha nem töröl semmit**.
- **Visszaigazítja az elcsúszást.** Ha valaki kikapcsolta a slowmode-ot vagy
  kitörölte egy csatorna témáját, a következő setup visszaállítja. A blueprint
  nem csak az első nap írja le a szervert.

---

## Amit előre tudni kell

**A bot soha nem kér Discord jelszót, és nem kezel felhasználói tokent.**
Egyetlen hitelesítő adata a bot token, ami kizárólag környezeti változóban él.

**A bot nem kap Administrator jogot.** A meghívó link pontosan azt a 13
jogosultságot kéri, ami a munkához kell. Meghíváskor látod, mihez járulsz hozzá.

**Szervert bot nem tud létrehozni.** Ez a Discord korlátja, nem a miénk. A
szervert magad hozod létre a kliensben; a provisioner berendezi.

---

## 1. Discord alkalmazás

1. <https://discord.com/developers/applications> → **New Application**
2. **Bot** → **Reset Token** → ez a `DISCORD_BOT_TOKEN`.
   > Teljes értékű fiók-hitelesítő. Úgy kezeld, mint a `JWT_SECRET`-et.
3. **General Information** → **Application ID** → `DISCORD_APP_ID`
4. Ugyanott **Public Key** → `DISCORD_PUBLIC_KEY`

Ha **welcome üzenetet** is akarsz belépéskor, itt kapcsold be:
**Bot → Privileged Gateway Intents → Server Members Intent**. Enélkül a
kapcsolat felépül, minden egészségesnek látszik, és soha egyetlen welcome sem
fut le — a bot ezt ki is mondja a logban, nem próbálkozik csendben tovább.

## 2. Szerver és meghívás

Hozd létre a szervert a Discord kliensben (**+ → Create My Own**), majd:

```sh
docker compose --profile discord run --rm discord-setup invite
```

Nyisd meg a kiírt URL-t, válaszd ki a szervert, hagyd jóvá.

A szerver azonosítójához: Discord → **Beállítások → Speciális → Fejlesztői mód**,
majd jobb klikk a szerver ikonján → **Azonosító másolása**. Ez a
`DISCORD_GUILD_ID`.

## 3. `.env`

```dotenv
DISCORD_BOT_TOKEN=...
DISCORD_APP_ID=...
DISCORD_PUBLIC_KEY=...
DISCORD_GUILD_ID=...

# Az API és a bot közti megosztott titok. Nem felhasználói hitelesítő.
YUME_SERVICE_TOKEN=<openssl rand -base64 48>
YUME_SITE_URL=https://yumee.duckdns.org

# Welcome belépéskor (a Server Members Intent kell hozzá)
DISCORD_WELCOME=true
# És adja meg a Member rangot is? Külön kapcsoló, mert ez moderációs döntés.
WELCOME_ROLE=false
```

## 4. Előnézet — ez semmit nem ír

```sh
docker compose --profile discord run --rm discord-setup plan
```

Kiírja, mit hozna létre **és mit igazítana vissza**. Semmit nem változtat. Ez az
alapértelmezett parancs, szándékosan.

## 5. Élesítés

```sh
docker compose --profile discord run --rm discord-setup provision
```

A végén kiírja a webhook URL-eket:

```
Webhook URLs — copy these into .env now, they are shown only once:

  DISCORD_SECURITY_WEBHOOK=https://discord.com/api/webhooks/...
  ...
```

> **Ezek hitelesítő adatok.** Aki birtokolja őket, korlátlanul posztolhat abba a
> csatornába. Ezért nem kerülnek adatbázisba, és a Discord sem mutatja meg őket
> újra. Másold be őket a `.env`-be **most**.

Ugyanez a futás kiposztolja a `#welcome`, `#rules` és `#faq` tartalmát is.

## 6. Slash parancsok

```sh
docker compose --profile discord run --rm discord-setup deploy-commands
```

`DISCORD_GUILD_ID`-vel a parancsok **azonnal** megjelennek; nélküle globálisan
regisztrálódnak, és a Discord akár egy órát késleltethet.

## 7. Interactions végpont

A slash parancsokat a Discord **HTTP-n** hívja meg — ehhez el kell érnie egy
URL-t. A `Caddyfile`-ba, a meglévő `reverse_proxy` **elé**:

```caddyfile
	handle /discord/interactions {
		reverse_proxy bot:4100
	}
```

Majd a fejlesztői portálon **General Information → Interactions Endpoint URL**:

```
https://a-domained.hu/discord/interactions
```

Mentéskor a Discord szándékosan küld **érvénytelen aláírású** kérést is, és csak
akkor fogadja el a végpontot, ha azt elutasítjuk. Rossz `DISCORD_PUBLIC_KEY`
esetén itt derül ki — ez a helyes sorrend.

---

## Egy paranccsal

Ha a `.env` kész:

```sh
docker compose up -d --build
```

Ez felhozza a `postgres`, `app`, `worker`, `caddy`, `backup` **és `bot`**
service-t. A `discord-setup` a `discord` profilban van, tehát normál indításkor
nem fut.

---

## Slowmode — magától, és magától vissza is állítja

A blueprint mondja meg, melyik csatornán mennyi:

| Csatorna | Slowmode | Miért |
|---|---|---|
| `#general`, `#anime-chat`, `#off-topic` | 2 mp | Láthatatlan annak, aki mondatot gépel, és tönkreteszi a ciklusban posztoló scriptet |
| `#bot-commands` | 3 mp | A legjobban nyomott csatorna; a bot válasza is tovább tart ennél |
| `#memes`, `#help`, `#recommendations`, `#watch-together` | 5 mp | Képes csatornákra jön a leggyorsabb spam |
| `#bug-reports`, `#feature-requests` | 30 mp | Ide megfontolt bejegyzés való |
| `#staff-chat`, `#mod-log`, `#security-alerts` | **nincs** | A stáb egymással beszélgetése nem spam, és incidenskezelésnél valódi időbe kerülne |

Ezt a **setup állítja be**, és minden későbbi futás visszaigazítja:

- kikapcsolta valaki → visszakapcsolja
- feltekerte valaki 10 percre → visszaviszi a blueprint értékére
- a blueprint **nem** mond róla semmit (pl. `#manga`) → **hozzá sem nyúl**

Az utolsó sor szándékos: a hallgatás azt jelenti, „nem az én dolgom", nem azt,
hogy „nullának kell lennie". Különben minden setup felülírná a moderátorok
döntését.

Ugyanígy visszaáll a kitörölt csatorna-téma is. A `plan` megmutatja ezeket
előre, `channel.update` sorként, indoklással.

---

## Welcome

Ha `DISCORD_WELCOME=true`, a bot nyit egy gateway kapcsolatot **egyetlen
eseményre**: valaki belépett.

Ilyenkor a `#welcome` csatornába ír, megemlítve az új tagot, és linkeli a
`#rules`, `#general`, `#faq` csatornákat. `WELCOME_ROLE=true` esetén megadja a
🌸 Member rangot is.

**Amit szándékosan nem tesz:**

| Nem csinálja | Miért |
|---|---|
| Nem küld privát üzenetet | Egy bot kéretlen DM-je megkülönböztethetetlen a csalásoktól, amiket a Discord-felhasználók ignorálni tanultak |
| Nem ír fiókadatot | Belépéskor a bot egy Discord azonosítót ismer és semmi mást. Nincs mit leírnia, és egy „nincs összekötve" sor mindenkinek csak zaj |
| Nem köszönti a botokat | Egy webhook-integráció üdvözlése attól látszik, hogy a szervert nem figyeli senki |
| Nem pingel senki mást | A ping engedélylistás: csak az új tag. Enélkül egy `@everyone`-t tartalmazó felhasználónév elég lenne az egész szerver megemlítéséhez |

A kapcsolat újracsatlakozik, ha megszakad — előbb **resume**-mal (így nem
vesznek el a közben történt események), exponenciális visszalépéssel, és
felismeri a „nyitva van, de a másik oldal halott" állapotot is. Két hibát
viszont nem próbál újra, mert azok nem hálózati problémák: hiányzó Server
Members Intent (4014) és rossz token (4004). Mindkettőt kiírja, mit kell tenni.

---

## Automatikus üzenetek — egyszer posztol, utána szerkeszt

Minden kezelt üzenetnek van kulcsa, és a bot megjegyzi, melyik Discord üzenet
tartozik hozzá.

| Eset | Mit tesz |
|---|---|
| Nincs róla feljegyzés | Kiposztolja, elmenti az azonosítót |
| Van, tartalom ugyanaz | **Semmit.** Nem szerkeszt, nem hív API-t. |
| Van, tartalom változott | **Szerkeszti** azt az üzenetet |
| Van, de törölték | Újraposztolja, az új azonosítót jegyzi meg |

A harmadik sor a lényeg, a **második** teszi használhatóvá: a táblák percenként
újrarajzolódnak, és a legtöbb ciklusban semmi nem változik. Hash-ellenőrzés
nélkül minden perc egy API-hívás lenne, és minden üzenetre rákerülne a
`(szerkesztve)` jelölés. Így egy csendes óra **nulla** Discord-kérés.

| Kulcs | Csatorna | Mikor változik |
|---|---|---|
| `static:welcome`, `static:rules`, `static:faq` | #welcome, #rules, #faq | Ha a repóban változik a szöveg |
| `board:status`, `board:blueprint` | #server-status | Ha egy szolgáltatás vagy a blueprint változik |
| `board:video` | #video-monitor | Ha egy szolgáltató állapota változik |
| `release:<id>` | #new-releases | Ha az adott epizód adata változik |

A `release:<id>` miatt **ugyanaz az epizód mindig ugyanarra az üzenetre kerül**.
Ha kap 1080p-t, vagy „feldolgozás alatt"-ból „elérhető"-be lép, a meglévő poszt
módosul — nem jelenik meg másodszor.

**Egyik üzenet törzsében sincs időbélyeg.** A hash a kirajzolt tartalomból
készül, tehát egy „frissítve: most" sor minden percben más hasht adna, és az
üzenet örökké újraírná magát. A Discord amúgy is kiírja a szerkesztés idejét.

```dotenv
# Milyen gyakran nézze meg, változott-e valami. Alap: 60 mp, alsó korlát 15 mp.
SYNC_INTERVAL_MS=60000
```

Ha egy kezelt üzenetet újra akarsz kezdetni: töröld Discordban, a következő
ciklusban újraposztolja.

---

## Ellenőrzés

```sh
docker compose ps bot
docker compose logs -f bot
```

| Parancs | Mit csinál |
|---|---|
| `/yume verify` | Összeveti a szervert a blueprinttel — nem ír semmit |
| `/yume setup` | Ugyanaz, terv formájában |
| `/yume setup mode:apply` | Alkalmazza a tervet |
| `/yume health` | Yume rendszerállapot |
| `/status`, `/search`, `/anime`, `/schedule`, `/releases`, `/watch` | Katalógus |
| `/warn`, `/timeout`, `/kick`, `/ban`, `/purge`, `/slowmode` | Moderáció, auditálva |

Minden moderációs művelet a Yume **`audit_logs`** táblájába kerül, ugyanoda,
ahová az admin felületről végzettek — mert két audit-nyom az annyi, mint nulla.

---

## Ha valami nem megy

**78-as kilépési kód** — hiányzik egy kötelező változó; a log megmondja, melyik.
Nem összeomlás: a `restart: on-failure` miatt a konténer megáll, nem pörög.

**„missing Discord permissions"** — kevesebb joggal lett meghívva. Futtasd újra
az `invite`-ot és hívd meg újra; a Discord frissíti a meglévő tagságot.

**A parancsok nem jelennek meg** — `deploy-commands` nem futott, vagy globálisan
regisztrált és még nem terjedt el. Adj meg `DISCORD_GUILD_ID`-t és futtasd újra.

**„The application did not respond"** — a Discord nem éri el az interactions
URL-t, vagy az aláírás-ellenőrzés bukik. `docker compose logs bot`: ott látszik,
adtunk-e vissza 401-et.

**Nincs welcome** — a Server Members Intent nincs bekapcsolva. A bot ezt
kiírja: `gateway refused: the Server Members Intent is not enabled`.

**A webhook már létezik, de nincs meg az URL-je** — a Discord csak létrehozáskor
mutatja meg. Töröld a csatorna beállításaiban, és futtasd újra a provisioninget.

---

## Ami tudatosan nincs benne

| Funkció | Miért |
|---|---|
| Anti-spam | A slowmode és a Discord saját AutoMod-ja fedi a gyakori eseteket. Egy saját, üzenet-alapú rendszer a `MessageContent` privilegizált intentet kérné — több adat, mint amennyit ez a bot indokoltan láthat |
| Discord ↔ Yume fiókösszekötés (OAuth2) | Külön munka; a terv a `docs/discord-bot.md` §3. A bot ma **egyetlen** felhasználói tokent sem kezel, és ez így is marad |
| Admin panel „Sync Discord Server" gomb | A provisioner hívható, a felület nincs meg |
| Videó-szolgáltató tábla valós adattal | A szolgáltatók állapota a kliens kiegészítő-gazdájában él, amit a bot nem lát. A tábla ezért azt írja, hogy nincs adat — nem talál ki zöld pipákat |

Ami nincs kész, arról nincs gomb sem.
