# Megőrzés

## Az elv

**A nyers sorok elmennek, az összesítők maradnak.**

Ettől marad megválaszolható, hogy „mennyien jártak itt tavaly", anélkül hogy
bárkiről tárolnánk bármit egy éve.

## A táblázat

| adat | tábla | meddig | mi történik utána | env |
|---|---|---:|---|---|
| oldalletöltés | `page_views` | 90 nap | törlés | `ANALYTICS_RAW_RETENTION_DAYS` |
| látogatói munkamenet | `analytics_sessions` | 90 nap | törlés | `ANALYTICS_SESSION_RETENTION_DAYS` |
| **nyers** keresőkifejezés | `search_stats.query` | 30 nap | **kiürül**, a sor marad | `ANALYTICS_SEARCH_RAW_DAYS` |
| normalizált keresőkifejezés | `search_stats.normalized` | — | marad | |
| fiókesemény | `account_events` | 365 nap | törlés | `ACCOUNT_EVENT_RETENTION_DAYS` |
| napi só | `analytics_salt` | 2 nap | törlés | |
| nyers rendszermetrika | `system_metrics` | 7 nap | törlés | `METRICS_RETENTION_DAYS` |
| órás rendszermetrika | `system_metrics_hourly` | 365 nap | törlés | `METRICS_HOURLY_RETENTION_DAYS` |
| hibanapló | `error_logs` | havi partíció | a karbantartó ejti | |
| **nyers IP** a biztonsági naplóban | `security_logs.ip` | 30 nap | **kiürül**, a sor marad | `SECURITY_LOG_IP_DAYS` |
| biztonsági napló (a sor maga) | `security_logs` | 365 nap | törlés | `SECURITY_LOG_RETENTION_DAYS` |
| adminisztrátori napló | `audit_logs` | havi partíció, megtartva | — | |
| **napi összesítők** | `analytics_daily`, `analytics_breakdown`, `anime_stats_daily`, `episode_stats_daily` | **korlátlan** | — | |

Az összesítők azért maradhatnak korlátlanul, mert nincs bennük személyes adat:
számok egy napra, nem sorok egy emberről.

## Miért két nap a só

A napi só az, ami a látogatói kulcsot visszafejthetetlenné teszi. Ha a sót
megtartanánk, a kulcs újraszámolható lenne egy adott IP-re — és ezzel a
pszeudonimizálás megszűnne. Két nap azért kell, mert az éjfél körül kezdődő
munkamenetek átnyúlnak, és az összesítés a következő nap fut rájuk.

## Az adminisztrátori napló

Ezt **nem** ejtjük automatikusan:

* `audit_logs` — „ki adott ennek a fióknak adminisztrátori jogot, és mikor" egy
  olyan kérdés, ami évekkel később is felmerülhet, és nincs benne más, mint
  hogy egy operátor mit csinált a saját rendszerén;
A `security_logs` **már nem** kivétel. Két lépcsőben takarítódik, mert két
különböző kérdést szolgál ki:

* **„honnan próbálkoztak"** — ez napokban érdekes. Egy incidens felderítése a
  friss sorokból megy, és harminc nap után a cím már nem nyom, hanem teher: a
  szolgáltatók újraosztják a címeket, és ami ma egy támadóhoz vezetne, holnap
  valaki máshoz. Harminc nap után a **cím** eltűnik, a sor marad.
* **„mi történt ezzel a fiókkal"** — ez hónapokban. Az esemény maga (belépés,
  sikertelen belépés, kijelentkeztetés) cím nélkül is teljes válasz, és egy
  évvel később is fel szokták tenni. Egy év után a sor is elmegy.

Mindkét határidő környezeti változóval állítható, és mindkettőt teszt őrzi: a
régi sor elveszti a címét de megmarad, a friss sor megtartja.

## Hol fut

Az `analytics` feladatsor `prune: true` kérése, naponta egyszer, a worker
óránkénti ütemezéséből (`workers/index.ts`). A futás kiírja, hány sort ejtett
melyik táblából:

```
analytics retention: {"page_views":12043,"analytics_sessions":388,
                      "account_events":0,"search_query_anonymised":517,
                      "analytics_salt":1}
```

## Amit kézzel kell megtenni

Egy adattörlési kérésre (GDPR 17. cikk) a fiók törlése a helyes válasz:
`DELETE /v1/auth/me`, vagy az adminisztrátori felületről. Ez elviszi a
fiókeseményeket (`CASCADE`) és a látogatásokat névtelenné teszi (`SET NULL`).

A `security_logs` sorai `ON DELETE SET NULL`-lal kapcsolódnak: az esemény
megmarad, a fiókhoz kötése elmúlik. Ez szándékos — egy törölt fiók sem
tüntetheti el egy incidens nyomait —, de ha a kérés kifejezetten erre
vonatkozik, azokat a sorokat kézzel kell törölni.
