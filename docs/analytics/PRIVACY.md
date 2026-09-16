# Adatvédelem

Ez a dokumentum azt írja le, **mit gyűjtünk, miért, ki láthatja, és meddig
marad meg**. Nem jogi szöveg; ez az, ami a kódban tényleg történik.

## Az alapelv

Amit nem tárolunk, azt nem lehet kiszivárogtatni, nem lehet megkérni, és nem
kell megvédeni. A rendszer ezért **kevesebbet** tud, mint amennyit egy szokásos
látogatottsági eszköz tudna — és ez tervezési döntés, nem hiányosság.

## Nincs süti, nincs böngészőbeli azonosító

A látogatottsági méréshez nem tárolunk semmit a látogató böngészőjében. Nincs
süti, nincs `localStorage`-azonosító, nincs ujjlenyomat.

A munkamenet **számított**: a napi látogatókulcs + a harmincperces időablak. A
látogató semmit nem visz magával.

## A látogatói kulcs

```
visitor_key = sha256( napi_só | IP | user-agent )[0..32]
```

* a **napi só** véletlen, naponta cserélődik, és a kettőnél régebbi sorok
  törlődnek (`analytics_salt`);
* ezért **ugyanaz az ember holnap más kulcsot kap**;
* a kulcsból az IP nem nyerhető vissza, és só nélkül nem is újraszámolható.

Ennek az ára, hogy a **napokon átívelő követés nem lehetséges**. A „visszatérő
látogató" ezért csak a bejelentkezett felhasználóknál pontos, és a panel ezt ki
is írja. Ezt az árat szándékosan fizetjük meg.

## IP-cím

| hol | tárolunk IP-t? |
|---|---|
| látogatottság (`analytics_sessions`, `page_views`) | **nem** |
| fiókesemények (`account_events`) | **nem** |
| biztonsági napló (`security_logs`) | **igen** |

A biztonsági naplóban azért van, mert ott más a kérdés: nem az, hogy „hányan
jártak itt", hanem hogy „ki próbálkozott". Ehhez a cím maga kell — de csak
harminc napig. Utána a cím kiürül, az esemény marad, egy év után pedig a sor
is elmegy. Lásd [DATA_RETENTION.md](DATA_RETENTION.md).

Az IP **soha nem bizonyíték személyazonosságra**. Megosztott hálózat, NAT,
mobilszolgáltató, VPN — mindegyik mögött sok ember van ugyanazon a címen, és
ugyanaz az ember naponta más címen. A rendszer sehol nem kezeli
azonosítóként, és a VPN-használat önmagában nem gyanús jel.

## Keresőkifejezések

A `search_stats` két alakot tárol: a **nyerset** és a **normalizáltat**.

A nyers szöveg személyes adat lehet — valaki a saját nevére keres, vagy
véletlenül a vágólapját illeszti be. Ezért 30 nap után a nyers mező kiürül, a
normalizált marad. Így a „mire kerestek" kérdés megválaszolható marad, a „ki
mit gépelt be szó szerint" pedig elmúlik.

## Eszközadat

Kategóriát tárolunk, nem ujjlenyomatot:

* eszközosztály: `mobile` / `tablet` / `desktop` / `tv` / `bot` / `unknown`
* böngésző és operációs rendszer: név, verzió nélkül
* képernyő: **sáv** (`xs`…`xl`), nem pontos pixelméret — a pontos méret
  azonosít, a sáv tervez
* nyelv: csak a fő címke (`hu`), nem a teljes elfogadási lista

Amit nem ismerünk fel, az `unknown` marad. Nem tippelünk: egy rossz kategória
rosszabb, mint egy üres.

## Hivatkozó

Csak a **gazdagép** (`www.google.com`), az útvonal nélkül. Egy teljes hivatkozó
URL tartalmazhat keresőkifejezést, munkamenet-azonosítót vagy egy magánoldal
címét — a kérdés pedig, amire válaszolni akarunk, csak annyi, hogy „honnan
jönnek".

A saját oldalunkról érkező hivatkozás nem forrás, hanem navigáció: eldobjuk.

## Amit soha nem naplózunk

Jelszó, jelszókivonat, hozzáférési vagy frissítő token, süti, WebSocket-jegy,
API-kulcs, `Authorization` fejléc, só, egyszeri kód.

Ez nem udvariassági lista: a `sanitise()` függvény kiveszi őket a
fiókesemények kísérőadatából, akárhogy is kerültek bele — ez az utolsó védvonal
a „gyorsan belerakom a teljes kérés törzsét" ellen, ami minden ilyen naplóban
egyszer megtörténik. Teszt őrzi.

## Ki láthatja

| adat | jogosultság |
|---|---|
| látogatottság, címek, keresés, teljesítmény | `analytics.view` |
| **egy fiók** tevékenysége, munkamenetei, eszközei | `analytics.accounts` |
| kimutatás exportálása | `analytics.export` |
| biztonsági napló (IP-vel) | `security.manage` |
| adminisztrátori napló | `admin.users.manage` |

A fiókszintű nézet **rejtett**: akinek nincs jogosultsága, annak a végpont nem
létezik (404), nem tiltott (403). A tiltás maga is információ.

Az egy fiókra vonatkozó nézet **nem tartalmaz IP-t** — az a biztonsági
képernyőé. Teszt őrzi.

## Törlés

Fiók törlésekor (`DELETE /v1/auth/me`) a törlés puha: a moderációs előzmény és
a mások által olvasott tartalom megmarad, a személyes mezők elmennek. A
`account_events` sorok a felhasználóhoz `ON DELETE CASCADE` kötődnek, az
`analytics_sessions.user_id` pedig `ON DELETE SET NULL` — a látogatás megmarad
névtelenként, a személyhez kötése elmúlik.

## Megőrzés

Lásd [DATA_RETENTION.md](DATA_RETENTION.md).
