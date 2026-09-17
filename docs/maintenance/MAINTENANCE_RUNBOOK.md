# Karbantartási mód — üzemeltetési forgatókönyvek

## Tervezett telepítés, kiesés nélkül

```
1. Admin → Karbantartás
2. Mód: Csak olvasható · Hatókör: global · Bekapcsolva
3. Mentés
4. → telepítés, áttérés
5. Mód: Kikapcsolva · Mentés
```

A látogatók végig böngészhetnek; csak az írásokat nem fogadjuk.

## Tervezett teljes karbantartás, előre bejelentve

```
1. Mód: Teljes · Kezdés: holnap 02:00 · Befejezés: holnap 04:00
2. Cím és üzenet kitöltve
3. Bekapcsolva · Mentés
```

Mostantól a látogatók **visszaszámlálót látnak**, de minden működik. Kettőkor
magától elindul, négykor magától véget ér.

## Adatbázis-áttérés, futó munkamenetekkel

```
1. Mód: Teljes · „A bent lévők maradhatnak" · Kiürítési idő: 300
2. Bekapcsolva · Mentés
3. Várj öt percet — a bent lévők befejezik
4. → áttérés
5. Kikapcsolva
```

## Vészhelyzet — most, azonnal

```
1. ELŐBB adj ki magadnak jegyet (Mentességi jegyek → Új jegy), és másold ki
2. Mód: Vészhelyzet · Bekapcsolva · Mentés · megerősítés
```

**A sorrend nem felcserélhető.** Vészhelyzetben a sima admin szerep nem enged
be; a jegy és a helyreállítási útvonalak a két út. A jegy nélkül is ki tudod
kapcsolni (a `/v1/admin/maintenance` mindig nyitva), de a többi képernyőhöz
nem férsz hozzá.

Kilépés:

```
Mód: Kikapcsolva · Mentés
```

## Ha az admin felület nem érhető el

A kikapcsolás közvetlenül az adatbázisból:

```sql
INSERT INTO maintenance_configs (mode, scope, enabled, title, public_message)
VALUES ('OFF', 'global', false, 'Karbantartás', '');
SELECT pg_notify('yume_maintenance_changed', 'manual');
```

A `pg_notify` nélkül is életbe lép — legfeljebb 30 másodperccel később, a
lejárati idő letelte után.

## Ha nem tudod, mi van most

```bash
curl -s https://yumee.duckdns.org/v1/status | jq
```

Ez **mindig** válaszol, karbantartás alatt is.

## Ha egy példány nem frissült

Nézd meg a gyorsítótár korát az admin képernyőn. Ha nagyobb 30 másodpercnél,
a beolvasás hasal el — az „Utolsó hiba" mező megmondja, miért.

A LISTEN kapcsolat elvesztése **nem** végzetes: a lejárati idő behozza a
változást. Az újracsatlakozás után a feliratkozások is helyreállnak.

## Ellenőrzőlista bekapcsolás után

```bash
# a látogató 503-at kap
curl -s -o /dev/null -w '%{http_code}\n' -H 'accept: application/json' https://yumee.duckdns.org/v1/anime

# az egészségjelző él
curl -s -o /dev/null -w '%{http_code}\n' https://yumee.duckdns.org/v1/health

# a státusz mondja, mi van
curl -s https://yumee.duckdns.org/v1/status | jq '.mode, .estimatedEnd'
```

Ha az elsőre nem 503 jön, nézd meg, hogy a kérésed nem a **saját
hálózatunkról** indul-e: onnan nincs karbantartás.
