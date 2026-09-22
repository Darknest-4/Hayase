# Slash parancsok és a köszöntő

---

## 1. A parancsok a gatewayen érkeznek

A Discord kétféleképpen kézbesíti az interakciókat: egy **nyilvános
HTTP-végpontra** (amit Ed25519-aláírással kell hitelesíteni), vagy a már
meglévő **WebSocket-kapcsolaton**. Mivel a gateway úgyis fut, a második a
helyes választás: nincs új nyilvános végpont, nincs aláírás-ellenőrzés, és
nincs egy újabb támadási felület.

**Három másodperc.** A Discord ennyit vár a válaszra, utána a felhasználónak
azt írja ki, hogy a bot nem válaszolt — akkor is, ha a válasz később
megérkezik. Ezért minden ág ad választ, a hibás is, és a lekérdezések napi
összesítőkből olvasnak, nem nyers eseményből.

## 2. A parancsok

| Parancs | Mit ad |
|---|---|
| `/help` | a parancsok listája |
| `/status` | a rendszer és a gateway állapota |
| `/stats` | a YUME számokban |
| `/anime search` | keresés cím szerint |
| `/anime info` | egy cím adatai |
| `/anime latest` | a legfrissebb epizódok |
| `/anime schedule` | a következő adások |
| `/anime random` | egy véletlen cím |
| `/profile` | a YUME-fiókod |
| `/link`, `/unlink` | fiók-összekötés (a vezérlőpultra küld) |
| `/watchlist` | a könyvtárad |
| `/notifications` | értesítési rang |
| `/setup`, `/config`, `/logs` | állapot — **admin** |
| `/announce` | bejelentés egy csatornába — **admin** |

**Az adminparancsokat a kiszolgáló is ellenőrzi.** A Discord
`default_member_permissions` mezője csak **elrejti** a parancsot — a kliens
megkerülhető, a kiszolgáló nem. Aki csak az elrejtésre hagyatkozik, az egy
`curl`-lel kinyitható adminfelületet épít.

**A `/setup` nem hajt végre veszélyes műveletet.** Csak állapotot mutat, és a
vezérlőpultra küld: egy visszafordíthatatlan törlés nem indulhat egy
chatablakból.

**A `/link` nem tesz úgy, mintha össze tudna kötni.** A folyamathoz böngésző
kell (a Discord engedélyezési lapja) és YUME-oldali bejelentkezés is.

### Korlátok

* **cooldown**: parancsonként és felhasználónként 3 másodperc;
* **a jogosulatlan hívás nem kap cooldownt** — abból ki lehetne olvasni, hogy
  a parancs létezik-e;
* **egyetlen válasz sem említ senkit** (`allowed_mentions.parse = []`), akkor
  sem, ha a felhasználói bemenetben `@everyone` szerepel.

### Statisztika

A használat a **meglévő eseménysémába** megy
(`analytics_events`, `discord.command.use`), nem külön táblába: ugyanolyan
„ki, mit, mikor" esemény, mint a többi, és a deduplikáció is kell rá, mert a
Discord ismételhet.

### Regisztráció

**Guild szintű**, nem globális: a globális parancsok akár egy órát is
késhetnek, a guild szintűek azonnal megjelennek. A vezérlőpulton a
**Parancsok feltöltése** gomb tölti fel; a `PUT` a teljes listát cseréli,
tehát ez egyben a „töröld a régieket" művelet is.

---

## 3. A köszöntő

Új tag érkezik → a gateway megkapja a `GUILD_MEMBER_ADD` eseményt → a
`welcome` modul dönt.

### Duplikációvédelem

A gateway egy újracsatlakozás után **megismételheti** az eseményeket, és egy
tag két köszöntője rosszabb, mint egy sem: az első kellemes, a második azt
üzeni, hogy a bot hibás. A védelem az **adatbázisban** van, nem a memóriában
— több példány között is működnie kell.

### A sablon

Változók: `{user}`, `{username}`, `{server_name}`, `{member_count}`,
`{rules_channel}`, `{welcome_channel}`, `{yume_url}`.

**Zárt lista.** Ismeretlen változónál a mentés **hibát ad**, nem csendes
elhagyást — és a hiba megmondja, melyik változó rossz.

**Az `@everyone` és az `@here` tiltott** a sablonban: minden új tagnál
felverné az egész szervert. Ez nem funkció, hanem baleset.

**Az említés az üzenet törzsében megy**, nem az embedben: a Discord az
embedben lévő említésre nem küld értesítést, és a tag nem venné észre.

### Ami nem buktatja meg

A **rang** és a **privát üzenet** hibája nem buktatja meg a köszöntőt: ha az
üzenet kiment, a lényeg megtörtént.

### Ami hiányzik, azt naplózza

Minden ág naplóz — a „nem küldtünk" is válasz. A felület ebből tudja
megmondani, hogy a köszöntő azért maradt el, mert ki van kapcsolva, vagy mert
nincs jogunk írni a csatornába.

### Próbaköszöntő

A hívó **saját** Discord-fiókjára megy, nem egy tetszőleges azonosítóra — egy
„küldj köszöntőt ennek a felhasználónak" végpont zaklatásra volna jó.

## 4. Hol van

| Mi | Hol |
|---|---|
| Parancsok | `apps/api/src/modules/discord/commands.ts` |
| Köszöntő | `apps/api/src/modules/discord/welcome.ts` |
| Gateway-bekötés | `apps/api/src/modules/discord/gateway-main.ts` |
| Felület | `apps/discord/src/setup.js` → Köszöntő |
| Tesztek | `test/discord-commands.test.ts`, `test/discord-welcome.test.ts` |
