# YUME Edge — üzemeltetés

## Az első hét: száraz üzem

Az él **bekapcsolva, de szárazon** indul. Ez azt jelenti:

* minden kérést kiértékel,
* minden nem-átengedett döntést naplóz,
* és **semmit nem utasít vissza** — a kézi tiltásokat kivéve.

Ez nem félmegoldás, hanem az üzembe helyezés helyes első lépése. Egy kockázati
réteg küszöbeit nem lehet előre eltalálni: a helyes értékek attól függenek,
milyen a te forgalmad. Egy hét száraz üzem után a `Él` képernyő megmutatja,
kit fogott volna meg — és abból már lehet dönteni.

**Élesre váltás:**

`Adminfelület → Üzemeltetés → Él` — vagy közvetlenül:

```
PATCH /v1/admin/edge/config
{ "reason": "egy hét megfigyelés után", "dryRun": false }
```

Előtte nézd meg a „Legutóbbi döntések" listát. Ha van benne olyan sor, amit
ismersz — a saját felügyeleti szkripted, egy kolléga —, azt előbb rendezd el.

## Mit nézz, amikor baj van

| kérdés | hol |
|---|---|
| mi támad most? | `Él` → „Amit az él látott", 24 óra |
| honnan? | „Ahonnan jött" — a cím mellett az ASN, a szolgáltató és a jelzők |
| mire ütközött? | „Mire ütközött" — WAF-szabályonként |
| miért lett blokkolva EZ a kérés? | „Legutóbbi döntések" — a jelek pontszámaikkal |
| mit tiltottunk ki? | „Élő tiltások" |
| mi van egy adott címmel? | `GET /v1/admin/edge/ip/<cím>` |

## Ha valakit tévesen fog meg

1. **Old fel a tiltást** (`Él` → Élő tiltások → Feloldás, indoklással). Azonnal
   hat: a gyorsítótár tíz másodpercig él.
2. **Nézd meg, melyik jel adta a pontot** — a döntés sora megmondja.
3. **Ha egy WAF-szabály a hibás**, kapcsold ki:
   ```
   PATCH /v1/admin/edge/config
   { "reason": "hamis találat a keresésen", "disabledRules": ["xss.handler"] }
   ```
4. **Ha a küszöb túl szoros**, emeld:
   ```
   PATCH /v1/admin/edge/config
   { "reason": "túl sok ártatlan fennakadt", "thresholds": { "block": 120 } }
   ```

Minden változás naplózódik (`edge.config` az auditban), indoklással.

## Vészhelyzet: kapcsold ki az egészet

```
PATCH /v1/admin/edge/config
{ "reason": "incidens, az él gyanúsítható", "enabled": false }
```

Ettől egyetlen kérést sem vizsgál. A meglévő sebességkorlát és a többi védelem
változatlanul működik — az él nem váltotta le őket, mellettük él.

## Beállítások

| változó | alap | mire |
|---|---|---|
| `EDGE_IP_CACHE_MS` | 300000 | meddig él egy IP-adat a memóriában |
| `EDGE_BAN_CACHE_MS` | 10000 | meddig él a tiltás-pillanatkép |
| `EDGE_COUNTER_KEYS` | 50000 | hány számlálókulcsot tartunk |
| `EDGE_EVENT_BUFFER` | 500 | hány esemény után ürül a puffer |
| `EDGE_EVENT_FLUSH_MS` | 5000 | milyen gyakran ürül |
| `EDGE_DECISION_RETENTION_DAYS` | 30 | meddig élnek a nyers döntések |
| `EDGE_INTEL_INTERVAL_MS` | 300000 | milyen gyakran frissülnek az IP-adatok |

A súlyok, küszöbök és szabályok **nem** környezeti változók: azokat a panelről
kell állítani, futásidőben. Egy védelem, amihez újraindítás kell, nem védelem,
hanem terv.

## Ami hiba esetén történik

Az él **fail-open** alapból: ha egy ellenőrzés elhasal, a kérés átmegy. Egy
biztonsági réteg hibája ne legyen kiesés.

Két kivétel, és ott **fail-closed**: `/v1/auth` és `/v1/admin`. Ott az a
rosszabb kimenetel, ha egy bizonytalan ellenőrzés átengedi a kérést. A lista
beállítás (`failClosed`), tehát szűkíthető vagy bővíthető.

## Ismert korlátok

* **Hálózati elárasztás ellen nem véd.** Ez a réteg az alkalmazáson belül fut;
  ami idáig eljut, azt már fogadtuk. Volumetrikus támadás ellen a szolgáltató
  és a tűzfal a válasz.
* **Egy példány.** A számlálók és a gyorsítótárak folyamaton belüliek. Két
  app-példánynál a számlálás megduplázódna — ekkor kell a `counters.ts`-t
  Redisre cserélni, és a `docs/redis.md` leírja, mikor.
* **Nincs VPN-adatbázis.** A helyi provider a fordított névből következtet, és
  a `confidence` kimondja, mennyire bízunk benne. Külső adatforrás hozzáadása
  egy `IpProvider` implementálása.
* **A `challenge` fokozat ma nem állít akadályt** — megjelöl és naplóz. Lásd
  ARCHITECTURE.md, „Amit szándékosan nem építettünk".
