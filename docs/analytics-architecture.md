# A statisztikai rendszer felépítése

**Egy szabály tartja össze:** *a panel soha nem olvas nyers eseménytáblát.*

Egy „hány látogató volt 90 napja" kérdés nyersen több millió sor
végigolvasása, és a panel minden frissítésnél újra kifizetné. Napi
összesítőből ugyanez **90 sor**. Ez a különbség az, ami miatt egy
látogatottsági rendszer vagy elfér ugyanazon a Postgresen, vagy nem.

---

## 1. Az út, amit egy esemény bejár

```
   böngésző                 kiszolgáló                    adatbázis
   --------                 ----------                    ---------
   POST /v1/analytics/view  →  collector.ts (MEMÓRIA)
                                  │  kötegelve, a kérési úton KÍVÜL
                                  ▼
                               page_views, analytics_sessions   (NYERS)
                                  │
                                  │  worker, óránként + éjfél után
                                  ▼
                               analytics_daily                  (NAPI)
                                  │
                                  │  ugyanaz a futás
                                  ▼
                               analytics_periods                (HETI/HAVI)
                                  │
   admin panel  ◄─────────────────┘   csak innen olvas
```

**A gyűjtő nincs a kérési úton.** A mérés nem lehet a lassulás oka: a
`collector.ts` memóriában gyűjt, és kötegben ír. Egy összeomlás néhány
másodpercnyi statisztikát visz el — ez a helyes csere.

**A puffer a kiírás ELŐTT ürül.** Ha az írás elhasal, a köteg elveszik, de nem
íródik ki kétszer. *A duplázás rosszabb hiba, mint a hiányzás: egy hiányzó
köteg csak pontatlan, egy duplázott hazudik.*

## 2. A táblák

### Nyers (nyesődik)

| Tábla | Mit tárol | Particionált |
|---|---|---|
| `page_views` | oldalletöltés, út-sablonra normalizálva | — |
| `analytics_sessions` | munkamenet, napi látogatói kulccsal | — |
| `search_stats` | keresés | havonta |
| `account_events` | fiókesemény | havonta |
| `security_logs` | biztonsági esemény, IP-vel | — |
| `performance_metrics` | API-válaszidő | havonta |
| `watch_history` | nézési előzmény | havonta |
| `audit_logs` | admin művelet | havonta |

### Összesítő (marad)

| Tábla | Bontás | Ki írja |
|---|---|---|
| `analytics_daily` | nap | `rollup.ts` |
| `analytics_periods` | ISO-hét, hónap | `rollup.ts` |
| `analytics_breakdown` | nap × dimenzió | `rollup.ts` |
| `anime_stats_daily` | nap × cím | `rollup.ts` |
| `episode_stats_daily` | nap × epizód | `rollup.ts` |
| `provider_metrics_daily` | nap × szolgáltató × kimenet | `providers/metrics.ts` |
| `provider_latency_daily` | nap × szolgáltató × **vödör** | `providers/metrics.ts` |
| `discord_message_stats_daily` | nap × guild × csatorna | gateway |
| `discord_member_stats_daily` | nap × guild | gateway |
| `system_metrics_hourly` | óra | worker |

## 3. Kétféle összesítő, kétféle szabállyal

Ez a rendszer legkönnyebben elrontható pontja, ezért külön ki kell mondani.

**Újraszámoló** (`rollup.ts`): a forrás a nyers tábla, a beszúrás
`ON CONFLICT DO UPDATE SET <a frissen számolt értékre>`. **Idempotens**: egy
félbeszakadt futás megismételhető, és egy kétszer lefutott nap nem duplázza a
számokat.

**Hozzáadó** (`providers/metrics.ts`, gateway): a forrás a memóriában gyűlt
**delta**, a beszúrás `count + excluded.count`. Itt az ismételt kiírás
**duplázna** — ezért ürül a puffer a kiírás előtt.

A kettőt összekeverni csendes adathibát ad: az első esetben elveszne az
összeadódás, a másodikban duplázódna.

## 4. Ami nem összeadódó

| Mennyiség | Miért nem | Mit csinálunk helyette |
|---|---|---|
| egyedi látogató, heti | a napi só miatt a kulcs naponta más | `visitor_days` = a napi egyediek összege, más néven |
| bejelentkezett egyedi | ez összevonható, mert a `user_id` állandó | `unique_users`, a nyers munkamenetből |
| taglétszám | állapot, nem esemény | a nap utolsó pillanatképe **felülír** |
| késleltetés maximuma | `GREATEST`, nem `+` | `latency_ms_max` |
| percentilis | átlagból nem áll elő | vödrös eloszlás, `provider_latency_daily` |

## 5. A percentilis

Az átlag és a maximum **együtt sem** mondja meg, milyen egy szolgáltató: száz
kérésből kilencvenkilenc 200 ms alatt és egy tíz másodpercben ugyanazt az
átlagot adja, mint a mind-300-ms-körül. Az elsőt a néző észre sem veszi, a
másodiknál minden epizódnál vár.

Az eloszlást **vödrökben** tároljuk (12 vödör: 10, 25, 50, 100, 250, 500,
1000, 2000, 5000, 10 000, 30 000, 60 000 ms), szolgáltatónként és naponként
legföljebb 12 sor. A percentilis ebből a vödör felső határának pontosságával
adható meg — **ezért ír a panel „≤"-t**. Egy pontosnak látszó `487 ms` itt
találgatás lenne.

## 6. A látogatói identitás

Lásd `docs/analytics-privacy.md`. Röviden: napi sóval képzett hash, a só
naponta cserélődik, sütit nem használunk, nyers IP a látogatottsági táblákba
nem kerül.

## 7. Ütemezés

| Feladat | Mikor | Hol |
|---|---|---|
| napi + heti/havi összesítés | óránként a mai napra, éjfél után a tegnapira | `analytics` sor |
| megőrzési nyesés | naponta | `analytics` sor, `prune: true` |
| szolgáltatói mérőszámok kiírása | 15 mp vagy 200 kulcs | memóriából |
| gateway kiírás | 30 mp | memóriából |
| Discord tartós üzenetek | percenként | `discord` sor |
| rendszerállapot-szondák | percenként | worker |

A sor **Postgres-alapú** (`QueueName` zárt unió), nincs Redis. A tartós
üzenetek elosztott zárja is Postgresen van, egyetlen `UPDATE ... WHERE`
utasítással.

## 8. Ahol a lánc elszakadhat

| Tünet | Valószínű ok | Hol látszik |
|---|---|---|
| a panel üres, de a nyers táblák nőnek | az összesítő nem fut | Adatminőség → „hiányzó napok" |
| egy nap hiányzik | leállt worker | Adatminőség |
| a számok „beragadtak" | az összesítő fut, a gyűjtő nem | nyers sorok utolsó időpontja |
| a Discord-üzenet percenként módosul | a tartalom rendereléskor változik | a frissítési előzményben nincs `skipped` |
| a gateway `ready`, de nincs adat | lefagyott folyamat | `last_event_at` régi → a szonda sárga |
