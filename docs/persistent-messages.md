# Tartós Discord-üzenetek

**Egy üzenet, ami frissül — nem szaporodik.**

---

## 1. Mi ez

A bot minden guildben és üzenettípusonként **egyetlen** üzenetet tart kint, és
azt **szerkeszti** újra. Nem új üzenetet küld: a csatorna nem telik meg
ugyanannak a statisztikának ezer példányával.

Nyolc típus:

| Típus | Mit mutat | Honnan |
|---|---|---|
| `yume_statistics` | katalógus, mai forgalom | saját DB |
| `latest_releases` | legfrissebb epizódok | saját DB |
| `provider_status` | szolgáltatók 24 órája | `provider_metrics_daily` |
| `system_health` | komponensállapot | `service_status` |
| `server_statistics` | a Discord-szerver számai | Discord REST + saját DB |
| `anime_schedule` | következő epizódok | `anime.next_airing_at` |
| `popular_anime` | legnézettebb címek | `anime_stats_daily` |
| `bot_status` | a tartós üzenetek állapota | saját DB |

## 2. A tartalom ujjlenyomata — és miért ez a lényeg

Minden renderelés után **hash**-t képezünk a tartalomból. Ha egyezik a
legutóbbival, **meg sem szólítjuk a Discordot**.

Ez nem elméleti szépség. **Mért hiba, élesben:** eredetileg minden embed
`timestamp: new Date()` mezőt kapott, amitől a tartalom minden renderelésnél
másnak látszott. A napló csupa `edited` volt, egyetlen `skipped` nélkül:
három üzenet, percenkénti kör, **naponta 4320 fölösleges Discord-hívás** —
pontosan az a forgalom, ami ellen az ujjlenyomat készült. Minden teszt zöld
volt, az embed helyesnek látszott, és a szám mégis ment.

Ebből három szabály következik, és mindhárom mért hibából:

1. **Nincs rendereléskori időbélyeg.** A frissesség nem vész el: a Discord
   maga jelzi a „szerkesztve" bélyeggel.
2. **A késleltetés tízre kerekítve.** A `service_status` századmásodpercre
   pontos értéket tárol, és az percenként ingadozik (28,9 → 3,2 → 11,4 ms).
   Ez valódi változás, tehát az ujjlenyomat is más lett — napi 1440 hívás egy
   szám remegése miatt.
3. **Determinisztikus rendezés.** Azonos `created_at` esetén a Postgres
   sorrendje nem determinisztikus; egy tömeges importnál több száz epizód kap
   ezredmásodpercre azonos időbélyeget.

Ugyanezért kerekítjük az **online létszámot** tízre a `server_statistics`-ben,
és ezért **nincs időpont** a `bot_status`-ban: az az üzenet a saját
frissítéseiről számol be, tehát egy „utoljára frissítve" mezőtől minden körben
megváltozna — **önmagát hajtaná, percenként, örökké**.

## 3. A motor

```
esedékes?  →  zár  →  render  →  hash egyezik?  →  IGEN: skipped
                                      │
                                      NEM
                                      ▼
                            van üzenetazonosító?
                              │              │
                             NEM            IGEN
                              ▼              ▼
                            send           edit
                                             │
                                      „nincs meg" (10008)?
                                             ▼
                                        újra létrehoz
```

**Elosztott zár Postgresen**, egyetlen `UPDATE ... WHERE locked_until < now()`
utasítással. Két egyidejű worker közül pontosan az egyik dolgozik rajta —
mérve, valódi átfedéssel (nem két egymás utáni futással: az semmit nem
bizonyítana).

**Csak a törölt üzenet vezet újralétrehozáshoz.** Ha egy jogosultsági hibát is
ide engednénk, a rendszer percenként küldene egy újat, és a csatorna megtelne.
A besorolás a Discord **kódjára** épül (10003, 10008, 50001, 50013), nem a
hibaüzenet szövegére: egy szöveges összehasonlítás a Discord egyetlen
szövegváltoztatásával elromlik, és némán rossz ágra visz.

**Visszalépés:** exponenciális, a `retry_after` felülírja a becslést, és öt
kudarc után a rekord megáll. Egy nem újrapróbálható hiba (nincs jog) azonnal
kimeríti a számlálót — nincs értelme ötször nekifutni.

## 4. Kézi műveletek

| Művelet | Mit csinál |
|---|---|
| **Frissítés most** | kihagyja az esedékességet és a hash-t, szerkeszt |
| **Újra kiküldés** | **törli** a régit, és újat küld a csatorna aljára |
| **Előnézet** | megmutatja, mi menne ki — **a Discordot meg sem szólítja** |
| **Előzmény** | mikor ment, mikor nem, és miért |
| **Letiltás** | nem frissül; a kint lévő üzenet marad, ahogy van |
| **Törlés** | a **nyilvántartást** törli; a Discord-üzenet a csatornában marad |

**Az újraküldés előbb töröl, aztán küld**, és ez a sorrend a lényeg. Fordítva
— vagy a törlés kihagyásával — pontosan az jönne létre, ami ellen az egész
modul készült: **két** üzenet ugyanarról. A nyilvántartás akkor is elengedi a
régi azonosítót, ha a küldés elhasal: különben a következő kör egy már nem
létező üzenetet próbálna módosítani.

**A törlés nem tünteti el a Discord-üzenetet.** Egy nyilvántartás törlése nem
jogosít fel arra, hogy idegen csatornából eltüntessünk valamit — azt az
üzemeltető törli, ha akarja. A felület ezt ki is mondja a megerősítésben.

## 5. Az előzmény olvasása

A `skipped` sorok a **legfontosabbak**, pedig azok tűnnek a legunalmasabbnak:
azok mutatják, hogy a tartalom nem változott, tehát a bot **nem küldött**
felesleges kérést.

**Ha ezek eltűnnek a listából, valami minden körben módosul** — és az napi
több ezer hívás. Ez az egyetlen hely, ahol egy ilyen hiba látszik: minden
teszt zöld marad közben.

| Esemény | Mit jelent |
|---|---|
| `created` | most jött létre |
| `edited` | módosult a tartalom |
| `skipped` | **nem változott — ez a jó jel** |
| `recreated` | törölték, visszahoztuk |
| `recreate_requested` | kézi újraküldés |
| `failed` | hiba, a részlettel |
| `locked_out` | egy másik példány épp dolgozott rajta |

## 6. Beállítás

Egy guildben egy típusból **egy aktív** üzenet lehet — ezt részleges egyedi
index kényszeríti ki, nem egy előzetes lekérdezés: két egyidejű kérés a
„megnézem, van-e már" mintával mindkettőnek azt mondaná, hogy nincs.

A csatorna cseréje **új üzenetet** igényel: a régi azonosító a régi csatornára
mutat, és ott már nem módosítható. A felület ezt előre kiírja.

Mentés előtt a **csatorna ellenőrizhető** (`diagnose`): enélkül a jogosultsági
hiba csak percekkel később derülne ki, egy `failure_count`-ban, amit senki nem
néz.

## 7. Élesben mérve

Az első üzemi kör (2026-09-21) és az új típus bekapcsolása (2026-09-22):

```
created (4433 ms) → edited (271 ms) → skipped (1 ms, „a tartalom nem változott")
```

Egy üzenet a csatornában, nem három. A `skipped` az első változatlan körnél
megjelent — ez az, ami a napi több ezer hívást megspórolja.
