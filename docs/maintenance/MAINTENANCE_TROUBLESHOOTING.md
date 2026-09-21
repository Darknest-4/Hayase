# Karbantartási mód — hibakeresés

## Először: mi van most?

```bash
curl -s https://yumee.duckdns.org/v1/status | jq
```

Ez **mindig** válaszol, karbantartás alatt is. Ha ez sem megy, a baj nem a
karbantartással van.

## „Bekapcsoltam, de nem történt semmi"

**1. A `Bekapcsolva` pipa be van téve?** A mód önmagában csak szándék; az
`enabled` az, ami hat.

**2. Az ablakon belül vagyunk?** Ha megadtál kezdést, előtte `SCHEDULED` van —
a látogatók visszaszámlálót látnak, de minden működik. Az admin képernyőn az
„Érvényes mód" sor ezt megmutatja.

**3. A hatókör érinti azt, amit próbálsz?** Egy `player` hatókörű karbantartás
a keresést nem fogja meg. A hatókörök listája a
[beállításnál](MAINTENANCE_CONFIGURATION.md).

**4. A saját hálózatodról próbálod?** Onnan **nincs** karbantartás — a worker
és a bot karbantartás alatt is futnak. Kívülről ellenőrizd.

**5. Van üzemeltetői jogosultságod?** A személyzet bemegy (vészhelyzet
kivételével). Ez nem hiba, ez a 13. pont.

## „Kikapcsoltam, de még mindig karbantartás van"

Nézd meg a **gyorsítótár korát** az admin képernyőn:

| amit látsz | mi az |
|---|---|
| 0–30 mp | rendben, a következő olvasás behozza |
| 30 mp fölött | a beolvasás hasal el — lásd az „Utolsó hiba" mezőt |

A böngésződ is cache-elhet: a 503 `Cache-Control: no-store`-ral megy, de egy
közbeiktatott proxy nem feltétlenül tartja be. Próbáld friss ablakban.

## „Kizártam magam"

**Nem lehetséges** — de ha úgy érzed:

1. `/v1/admin/maintenance` **mindig** nyitva, minden módban;
2. `/v1/auth/login` és `/v1/auth/refresh` **vészhelyzetben is** nyitva;
3. legrosszabb esetben az adatbázisból:

```sql
INSERT INTO maintenance_configs (mode, scope, enabled, title, public_message)
VALUES ('OFF', 'global', false, 'Karbantartás', '');
SELECT pg_notify('yume_maintenance_changed', 'manual');
```

## „A mentességi jegyem nem működik"

| tünet | ok |
|---|---|
| azonnal elutasítja | elgépelt vagy meghamisított jegy (az aláírás nem stimmel) |
| „ismeretlen jegy" | más példányon/adatbázison adták ki |
| „lejárt jegy" | a jegy rövid életű — 15 perc az alap, 24 óra a plafon |
| „visszavont jegy" | valaki visszavonta; a visszavonás azonnal hat |
| „a jegy hatóköre nem erre szól" | szűkebb hatókörrel adták ki |
| vészhelyzetben sem enged be | az adatbázis nem elérhető — ilyenkor a jegy **szándékosan** érvénytelen |

Az utolsó a legfontosabb: a jegy visszavonhatósága csak akkor jelent bármit,
ha a visszavonás állapotát meg tudjuk nézni. A helyreállítási útvonalak jegy
nélkül is nyitva vannak.

**Az URL-be ne tedd.** Fejlécben (`x-yume-maintenance-bypass`) vagy sütiben
(`yume_maintenance_bypass`) utazik.

## „A karbantartási oldalon nincs videó"

1. van fájl az `apps/web/assets/videos` könyvtárban?
2. a kiterjesztése `.mp4`, `.webm` vagy `.m3u8`?
3. nem ponttal kezdődik a neve?
4. **mozgásmentes módban a háttérvideó szándékosan nincs ott.**

Az admin képernyő alján látod, mit talált a felismerő. Ha ott üres, akkor a
fájl nem felel meg valamelyik feltételnek.

## „Az Újratöltés gomb nem csinál semmit"

Ez egy **valódi hiba volt**, és böngésző találta meg: a beágyazott szkriptet a
saját biztonsági szabályzatunk tiltotta, csendben.

Az oldal azóta szkript nélkül működik — a gomb egy hivatkozás. Ha mégis
tétlen, nézd meg a konzolt: ha ott `Content Security Policy` hiba van,
visszakerült egy beágyazott szkript valahova.

## „Egy példány nem frissült"

A LISTEN kapcsolat elvesztése nem végzetes: a **30 másodperces lejárat**
behozza a változást. Az újracsatlakozás után a feliratkozások is helyreállnak
— minden regisztrált csatornára újra kimegy a `LISTEN`.

A naplóban ez látszik:

```
a feladatsor hallgatója elvesztette a kapcsolatot: …
```

Ha ez ismétlődik, a kapcsolat maga a baj, nem a karbantartás.

## Naplók

```bash
docker compose logs app --since 10m | grep -i 'karbantartás\|maintenance'
```

Amit keresel:

| sor | mit jelent |
|---|---|
| `karbantartás: kérés visszautasítva` | a hook fogta meg, és megmondja a módot, a hatókört és az okot |
| `karbantartási jegy elutasítva` | volt jegy, de nem érvényes — az ok is ott van |
| `a karbantartás kiértékelése elhasalt` | a hook hibázott, és **átengedte** a kérést |

Az utolsó a legfontosabb: a saját hibánk nem zárhat ki senkit.
