# Karbantartási mód — audit

Ez a lap a **kiindulás**: mi van ma, mit lehet újrahasználni, és mit kell
megírni. Az 1. pont kifejezetten ezt kéri, mielőtt bármi módosul.

## A legfontosabb megállapítás

**Nincs karbantartási mód.**

Van egy `apps/api/src/infrastructure/maintenance.ts`, de az **nem ez**: az az
adatbázis házimunkája — partíciókat hoz létre, lejárt sorokat töröl, a
„következő adás" mezőt vezeti le. A név ütközik, a fogalom nem.

Ez a modul marad, ahol van, és **nem nyúlunk hozzá**. Az új alrendszer külön
névtérbe kerül (`modules/maintenance/`), hogy a kettő ne keveredjen.

## Ami a karbantartási módhoz legközelebb áll ma

Egyetlen dolog van: a **csak olvasható üzemmód**.

```
apps/api/src/app.ts — globális onRequest hook
  ha a kérés írás (POST/PUT/PATCH/DELETE)
  és /v1 vagy /graphql alatt van
  és nem kivételezett (/v1/auth, /v1/admin/{config,security,backups})
  és siteSettings.readOnly()
  → 503 + Retry-After: 120 + problem+json
```

Ez **jó alap, de kevés**: egyetlen logikai kapcsoló, nincs hatóköre, nincs
ütemezése, nincs mentessége, nincs felülete, és a látogató egy nyers JSON-t
kap. A hatókör-kivételek egy reguláris kifejezésben ülnek.

**Marad, és beleolvad**: a `READ_ONLY` állapot pontosan ezt a viselkedést
jelenti majd, ugyanazokkal a kivételekkel. A régi kapcsoló nem tűnik el, hanem
az új állapotgép egyik bemenete lesz — így egy meglévő telepítés viselkedése
nem változik meg csendben.

## Amit újra kell használni, nem újraírni

| ami van | hol | mire kell |
|---|---|---|
| `site_settings` + 30 mp-es gyorsítótár, `invalidate()` | `modules/settings/site-settings.ts` | minta a konfiguráció-gyorsítótárhoz |
| `feature_flags` tábla, hozzáférési szintek | `0011_site_config.sql` | a karbantartás kapcsolói |
| **`audit_logs`** — particionált, `before`/`after`, `actor_id`, `ip` | `0015_monitoring.sql` | a 6. pont `maintenance_events` táblája **nem kell**: ez pontosan azt tudja |
| **LISTEN/NOTIFY** — `listenForJobs`, újracsatlakozással | `infrastructure/queue/wake.ts` | a 7. pont gyorsítótár-érvénytelenítése |
| `security_logs`, kockázati motor, WAF, tiltások | `modules/edge/` | a 28. pont biztonsági integrációja |
| sebességkorlát + belső mentesség | `middleware/` | a karbantartás nem foghatja meg a saját rendszerünket |
| **HTML státuszoldal** | `infrastructure/http/status-page.ts` | a 14. pont oldalának alapja — most készült a 429-hez |
| egészségjelzők | `/v1/health` | a 26. pont: soha nem terelhetők |
| **Player 2.0** — mag, motor, felület szétválasztva | `apps/web/src/features/player2/` | a 16. pont karbantartás-lejátszójának mintája |
| `jobs` sor + ütemezés | `infrastructure/queue/` | a 9. pont háttérfeladatai |
| tervezési tokenek, reszponzív rács | `apps/web/css/` | a 14. és 34. pont |

## Amit meg kell írni

Minden más. Nevesítve, hogy a jelentés végén számon kérhető legyen:

- állapotgép (`OFF`/`SCHEDULED`/`ACTIVE`/`DEGRADED`/`READ_ONLY`/`EMERGENCY`);
- hatókörrendszer és útvonal-illesztés;
- központi döntéshozó (policy resolver);
- gyorsítótár utolsó-jó-állapottal és TTL-lel;
- `maintenance_configs` tábla, verziózva;
- rövid életű, aláírt, visszavonható mentességi jegyek;
- ütemezés időzónával;
- szerveroldali köztesréteg;
- publikus státusz-végpont;
- karbantartási oldal (HTML, a YUME arculatával);
- videófelismerő és karbantartás-lejátszó;
- admin felület, előnézettel.

## Két dolog, amit az audit ELŐRE eldönt

**A `maintenance_events` tábla nem készül el.** A 6. pont kéri, de az
`audit_logs` particionált, indexelt, `before`/`after` mezős, és már ma is ezt
használja a biztonsági beállítások és az alapítói könyvtár minden
módosítása. Egy második, majdnem ugyanolyan tábla párhuzamos rendszer lenne —
amit a 3. pont kifejezetten tilt.

**A LISTEN/NOTIFY nem új csatornát kap kapcsolatostul.** A `wake.ts` már tart
egy újracsatlakozó figyelő kapcsolatot a `yume_jobs` csatornára. A karbantartás
egy MÁSODIK CSATORNÁT kap ugyanazon a kapcsolaton — nem egy második kapcsolatot.
