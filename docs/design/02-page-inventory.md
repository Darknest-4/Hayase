# 02 — Oldalleltár

18 kliens útvonal és 16 admin szekció. A `#/` hash-forma az elsődleges; az
`/anime/:id` útvonalat a szerver is kiszolgálja saját `<head>`-del a
megoszthatóság miatt (`modules/seo/routes.ts`).

## Kapuzás

A `require_login` beállítás (jelenleg **be van kapcsolva**) minden útvonalat
bejelentkezés mögé tesz, kivéve a `settings` és a `landing` útvonalat. Az
API-oldalon ugyanez: csak a `/v1/health`, `/v1/config` és `/v1/auth` marad
nyitva — azok, amik ahhoz kellenek, hogy valaki *ne* legyen kijelentkezve.

---

## `#/landing` — Kezdőképernyő
**Cél:** megmondani, mi ez az oldal, és fiókot nyitni.
**Felépítés:** átlátszó sticky fejléc (márka balra, profil-ikon jobbra) →
hero (óriás display cím gradienssel az első szón, kontúros wordmark-vízjel,
két CTA) → hat funkcióblokk → záró CTA → lábléc.
**Mobil:** **nincs alsó sáv** — saját fejléce van. A fejléc középső linksora
720px alatt eltűnik.
**Interakció:** a profil-ikon kijelentkezve belépő popupot nyit (Belépés /
Regisztráció fülekkel), belépve a profilra visz. A fejléc görgetésre
betömörödik.
**Katalógusadat: nincs.** Szándékos: élő borítókat mutatni kijelentkezett
látogatóknak szabályzati döntés, nem oldalszerkesztés.
**Ismert korlát:** kijelentkezve az onboarding felugró **e fölé** kerül, amíg
végig nem megy rajta.

## `#/home` — Főoldal
**Felépítés:** spotlight (véletlen cím bannerrel) → vízszintes sorok
(`C.section`), soronként 8 skeleton-kártya betöltés közben.
**Mobil:** a sorok vízszintesen görögnek, a következő kártya félig látszik.

## `#/search` — Keresés és böngészés
**Felépítés:** összecsukható szűrőpanel (`<details>`, 560px alatt csukva
indul) → eredményrács → „Load more".
**Szűrők:** hét tengely **rácsban** (`repeat(auto-fit, minmax(9rem, 1fr))`) —
korábban tördelődő flex-sor volt, ahol a keresőmező felszívta a maradékot és a
Sort egyedül maradt egy sorban.
**Ismert hiány:** hét tengely; a referencia tizenkettőt mutat (kulcsszó,
stúdió, hang, eredet, korhatár, animelista).

## `#/anime/:id` — Adatlap
**Felépítés:** banner a lap mögött → borító + kettős cím (eredeti halványan,
megjelenítendő vastagon) → csillagsor → chipek → **gradienssel elhalványuló
leírás**, rajta az „Olvass többet" gomb → akciósor → műfaj-chipek → fülek
(Epizódok / Kapcsolódó / Karakterek / Hozzászólások / Ajánlott) → oldalsó
infópanel.
**Kiemelés:** a borító domináns színéből.
**Fontos döntés:** az infópanel **nem ismétli** a chipeket. Formátum,
epizódszám, státusz és évad korábban kétszer szerepelt egy képernyőn.

## `#/watch/:id` — Lejátszó
**Felépítés:** fejléc (vissza a sorozathoz, epizódszámláló) → lejátszó vagy
forrásválasztó → akciók (megnézve, következő, forrás) → hozzászólások |
jobbra epizód-rail.
**Epizód-rail:** 100 epizód fölött **tartomány-chipekkel lapozva**, a
jelenlegi epizódot tartalmazó blokkon nyitva. Korábban minden epizódot
kirajzolt: a ONE PIECE 1168 részénél 5879 DOM-node, most 552.
**Kiemelés:** a cím színéből, mint az adatlapon.

## `#/list` · `#/profile` · `#/dashboard` · `#/notifications` · `#/schedule` · `#/community` · `#/changelog` · `#/settings` · `#/themes` · `#/w2g`
Könyvtár, profil (al-fülekkel: statisztika, előzmények, eredmények),
áttekintő, értesítések, vetítési naptár, közösség (chat/fórum), fejlesztési
napló (adatbázisból, `is_public` szűréssel), beállítások, témák, közös nézés.

## `#/admin/:section` — Admin panel
Saját héj, saját rail, 16 szekció négy csoportban:

```
INSIGHT   overview · errors · audit-log
PEOPLE    users · roles · reports
CONTENT   catalogue · metadata · translations
SYSTEM    monitoring · announcements · webhooks · themes · security · audit · config
```

Minden szekció mögött külön jogosultság; jogosultság híján **404**, nem 403 —
egy olyan felületnél, aminek a *létezése* az információ, a 404 az őszinte
válasz.

`admin.js` 4211 sor, az oldalkód 52%-a. A 2026-09 audit bejelentkezve
megvizsgálta: nincs túlcsordulás, nincs `<table>` elem, a gombok a közös
`.btn`-t használják. Kódmennyiségben a legnagyobb, látható hibában nem.
