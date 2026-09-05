# Discord — telepítés és üzembe helyezés

A Yume Discord szerverét nem kézzel kell összekattintani. Van egy **blueprint**
(`bot/src/blueprint.ts`), ami leírja a teljes struktúrát — rangok, kategóriák,
csatornák, jogosultságok, webhookok —, és egy **provisioner**, ami ezt
ráilleszti egy Discord szerverre.

A provisioner **újrafuttatható**. Ami már létezik, azt megkeresi és
felhasználja; nem hoz létre duplikátumot, és **soha nem töröl semmit**.

---

## Amit előre tudni kell

**A bot soha nem kér Discord jelszót, és nem kezel felhasználói tokent.**
Egyetlen hitelesítő adata a bot token, ami kizárólag környezeti változóban él.

**A bot nem kap Administrator jogot.** A meghívó link pontosan azt a 13
jogosultságot kéri, ami a munkához kell — a `ManageRoles`, a `ManageChannels`
és a `ManageWebhooks` végzi az érdemi részt. Meghíváskor látod, mihez járulsz
hozzá.

---

## 1. Discord alkalmazás létrehozása

1. Nyisd meg: <https://discord.com/developers/applications> → **New Application**
2. **Bot** fül → **Reset Token** → másold ki. Ez a `DISCORD_BOT_TOKEN`.
   > Ez teljes értékű fiók-hitelesítő. Úgy kezeld, mint a `JWT_SECRET`-et. Ha
   > kiszivárog, a fejlesztői portálon kell újragenerálni.
3. **General Information** → **Application ID** → ez a `DISCORD_APP_ID`.
4. Ugyanott a **Public Key** → ez a `DISCORD_PUBLIC_KEY`.

## 2. Szerver létrehozása és a bot meghívása

A Discord API-val **nem lehet** szervert létrehozni bot néven — ez a Discord
korlátja, nem a miénk. A szervert magad hozod létre a Discord kliensben
(**+ → Create My Own**), a provisioner pedig berendezi.

A meghívó linket a rendszer állítja elő:

```sh
docker compose --profile discord run --rm discord-setup invite
```

Nyisd meg a kiírt URL-t, válaszd ki a szervered, és hagyd jóvá.

Ezután a szerver azonosítója kell: Discord → **Beállítások → Speciális →
Fejlesztői mód** bekapcsol, majd jobb klikk a szerver ikonján → **Azonosító
másolása**. Ez a `DISCORD_GUILD_ID`.

## 3. `.env`

A meglévő `.env`-be, a `JWT_SECRET` és a `POSTGRES_PASSWORD` mellé:

```dotenv
DISCORD_BOT_TOKEN=...
DISCORD_APP_ID=...
DISCORD_PUBLIC_KEY=...
DISCORD_GUILD_ID=...

# Az API és a bot közti megosztott titok. Nem felhasználói hitelesítő.
YUME_SERVICE_TOKEN=<openssl rand -base64 48>
YUME_SITE_URL=https://yumee.duckdns.org
```

## 4. Előnézet — ez semmit nem ír

```sh
docker compose --profile discord run --rm discord-setup plan
```

Kiírja, mit hozna létre. **Semmit nem változtat.** Ez az alapértelmezett
parancs, szándékosan.

## 5. Élesítés

```sh
docker compose --profile discord run --rm discord-setup provision
```

A végén kiírja a webhook URL-eket:

```
Webhook URLs — copy these into .env now, they are shown only once:

  DISCORD_SECURITY_WEBHOOK=https://discord.com/api/webhooks/...
  DISCORD_SYSTEM_WEBHOOK=https://discord.com/api/webhooks/...
  ...
```

> **Ezek hitelesítő adatok.** Aki birtokolja őket, korlátlanul posztolhat abba
> a csatornába. Ezért nem kerülnek adatbázisba, és a Discord sem mutatja meg
> őket többé. Másold be őket a `.env`-be **most**.

Írd be, majd:

```sh
docker compose up -d bot
```

## 6. Slash parancsok regisztrálása

```sh
docker compose --profile discord run --rm discord-setup deploy-commands
```

`DISCORD_GUILD_ID` megadásával a parancsok **azonnal** megjelennek. Nélküle
globálisan regisztrálódnak, és a Discord akár egy órát is késleltethet.

## 7. Az interactions végpont

A slash parancsok úgy működnek, hogy a Discord **HTTP-n hívja meg** a botot —
nincs állandó gateway kapcsolat. Ehhez a Discordnak el kell érnie egy URL-t.

A Caddyfile-ba, a meglévő `reverse_proxy` **elé**:

```caddyfile
	handle /discord/interactions {
		reverse_proxy bot:4100
	}
```

Majd a fejlesztői portálon: **General Information → Interactions Endpoint URL**:

```
https://a-domained.hu/discord/interactions
```

Mentéskor a Discord szándékosan küld egy **érvénytelen aláírású** kérést is, és
csak akkor fogadja el a végpontot, ha azt elutasítjuk. Ha a `DISCORD_PUBLIC_KEY`
hibás, itt derül ki — ez a helyes sorrend.

---

## Egy paranccsal

Ha a `.env` kész (a webhookok nélkül is elindul):

```sh
docker compose up -d --build
```

Ez felhozza a `postgres`, `app`, `worker`, `caddy`, `backup` **és `bot`**
service-t. A `discord-setup` a `discord` profilban van, tehát normál
indításkor nem fut.

## Ellenőrzés

```sh
docker compose ps bot
docker compose logs -f bot
```

Discordban:

| Parancs | Mit csinál |
|---|---|
| `/yume verify` | Összeveti a szervert a blueprinttel — nem ír semmit |
| `/yume setup` | Ugyanaz, terv formájában |
| `/yume setup mode:apply` | Alkalmazza a tervet |
| `/yume health` | Yume rendszerállapot |
| `/status` | Elérhető-e az API |

---

## Ha a bot nem indul

**78-as kilépési kód** — hiányzik egy kötelező változó. A log megmondja,
melyik. Ez nem összeomlás: a `restart: on-failure` miatt a konténer megáll,
nem pörög újra.

**„missing Discord permissions"** — a bot meghívása kevesebb joggal történt.
Futtasd újra az `invite` parancsot és hívd meg újra; a Discord frissíti a
meglévő tagságot.

**A parancsok nem jelennek meg** — `deploy-commands` nem futott, vagy globálisan
regisztrált és még nem terjedt el. Adj meg `DISCORD_GUILD_ID`-t és futtasd újra.

**A slash parancs „The application did not respond"** — a Discord nem éri el az
interactions URL-t, vagy az aláírás-ellenőrzés bukik. Nézd meg a
`docker compose logs bot` kimenetét: ott van, hogy 401-et adtunk-e vissza.

---

## Ami tudatosan nincs benne

| Funkció | Miért |
|---|---|
| Welcome üzenet belépéskor | Gateway (WebSocket) kapcsolat kell hozzá — a HTTP interactions modell nem kap tagbelépés-eseményt. A terv a `docs/discord-bot.md` §4-ben van. |
| Anti-spam | Ugyanaz: üzenet-eseményekre kell feliratkozni, ahhoz gateway kell. |
| Discord ↔ Yume fiókösszekötés (OAuth2) | Külön munka; a terv a `docs/discord-bot.md` §3. A bot ma **egyetlen** felhasználói tokent sem kezel, és ez így is marad — az összekötés OAuth2 code flow-val történne, szerveroldalon. |
| Admin panel „Sync Discord Server" gomb | A provisioner API-ként hívható, a felület nincs meg. |

Ezek hiányát a rendszer nem takarja el: ami nincs kész, arról nincs gomb sem.
