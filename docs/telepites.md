# Telepítés Ubuntu VPS-re, Dockerrel

Ez a teljes stacket elindítja egy gépen: API + webkliens egy konténerben,
Postgres, háttérmunkás, HTTPS-terminátor és napi, **ellenőrzött** mentés.

A `docker-compose.yml` a forrás, ez a leírás csak elmagyarázza. Ha a kettő
eltér, a compose fájlnak van igaza.

---

## Mielőtt elkezded

| Kell | Miért |
|---|---|
| Docker + Compose v2 | `docker compose version` — ha ez válaszol, megvan |
| ~2 GB RAM | az app 768 MB-ra, a worker 512 MB-ra van korlátozva, plusz a Postgres |
| ~5 GB szabad hely | katalógus-seeddel és mentésekkel együtt |
| 80 és 443 port szabadon | a Caddy ezeken kér tanúsítványt; semmi más ne üljön rajtuk |
| *(HTTPS-hez)* egy domain | A/AAAA rekorddal **már erre a gépre** mutatva |

A domain nem kötelező, de nélküle a stack sima HTTP-t szolgál ki a 80-as
porton. Ott a jelszavak és a tokenek olvashatóan mennek át a hálózaton — ez
teszteléshez rendben van, valódi fiókokhoz nem.

---

## 1. A kód a gépre

```sh
sudo apt update && sudo apt install -y git
git clone https://github.com/Darknest-4/Hayase.git yume
cd yume
```

A `main` ágon van a legutóbb összefésült állapot. Ha a fejlesztői ágat akarod
(ott van minden, ami még nincs beolvasztva):

```sh
git checkout claude/hayase-repo-pull-gcq81x
```

## 2. `.env` — ez az egyetlen kézi lépés

Két titok kötelező, és egyiknek sincs alapértelmezése. Ez szándékos: egy
jelszó, ami egy nyilvános repóból jön, nem jelszó.

```sh
cp .env.example .env
```

Generáld le őket, és írd be a `.env`-be:

```sh
openssl rand -base64 48      # ez lesz a JWT_SECRET
openssl rand -base64 32      # ez lesz a POSTGRES_PASSWORD
```

```sh
nano .env
```

```dotenv
JWT_SECRET=<az első generált érték>
POSTGRES_PASSWORD=<a második generált érték>

# csak ha van domained:
YUME_DOMAIN=yume.pelda.hu
ACME_EMAIL=te@pelda.hu
```

> A `POSTGRES_PASSWORD` az adatbázis **létrehozásakor** rögzül. Utólag
> megváltoztatni csak a `pgdata` kötet eldobásával lehet — vagyis az adatok
> elvesztésével. Most döntsd el.

Zárd le a fájlt, mert titkok vannak benne:

```sh
chmod 600 .env
```

## 3. Indítás

```sh
docker compose up -d --build
```

Ez felhúzza: `postgres` → `app` → `worker` → `caddy` → `backup`.
Az `app` induláskor **magától** lefuttatja a migrációkat és publikálja a
beépített kiegészítőket — nincs külön migrációs lépés.

Az első build pár percig tart. Utána:

```sh
docker compose ps                    # mind "healthy"?
docker compose logs -f app           # mi történik indulás közben
```

Egészség-ellenőrzés. **Domainnel** a Caddy csak azt a hosztnevet szolgálja ki,
a `localhost` nem talál oldalt — ezért a domaint kell hívni:

```sh
curl -sf https://yume.pelda.hu/v1/health && echo OK      # domainnel
curl -sf http://localhost/v1/health && echo OK           # domain nélkül
```

Ha a DNS még nem terjedt el, a konténeren belülről is megnézheted:

```sh
docker compose exec app node -e \
  "fetch('http://127.0.0.1:4000/v1/health').then(r=>console.log(r.status))"
```

## 4. **Regisztrálj azonnal**

Nincs beépített fiók és nincs alapértelmezett jelszó. Helyette: **az első
fiók, ami egy adminisztrátor nélküli példányon regisztrál, adminisztrátor
lesz.** Amíg nem regisztrálsz, azé a rendszergazdai felület, aki megelőz.

Nyisd meg a böngészőben (`https://yume.pelda.hu`, vagy domain nélkül
`http://<a-vps-ip-címed>`), és regisztrálj. Vagy parancssorból:

```sh
curl -X POST https://yume.pelda.hu/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"te@pelda.hu","username":"te","password":"eleg-hosszu-jelszo-9"}'
```

(Domain nélkül `http://localhost/v1/auth/register`.)

Ellenőrizd, hogy tényleg admin lettél — a promóció naplózva van:

```sh
docker compose exec postgres psql -U yume yume -c \
  "SELECT u.username, r.slug FROM user_roles ur
     JOIN users u ON u.id = ur.user_id
     JOIN roles r ON r.id = ur.role_id;"
```

## 5. Katalógus (opcionális, de enélkül üres a kezdőlap)

~25 000 anime a hivatalos dumpból, epizódokkal együtt. Idempotens, kb. 2 perc:

```sh
docker compose --profile seed run --rm seed
```

Utána a borítók, leírások, pontszámok, stúdiók feltöltése AniListről. Ez
**sokáig tart** (a rate limit miatt), és futtatható később is:

```sh
docker compose --profile enrich run --rm enrich
```

---

## Ami magától megy

| Szolgáltatás | Mit csinál |
|---|---|
| `worker` | **Kötelező.** Létrehozza a következő havi partíciókat, kézbesíti a webhookokat, számolja a statisztikákat, gyűjti a VPS-metrikákat. Nélküle a particionált táblákba idővel nem lehet írni. |
| `caddy` | Let's Encrypt tanúsítvány, megújítással együtt. Nincs certbot, nincs cron, ami csendben leáll. |
| `backup` | Napi `pg_dump`, majd **visszatölti egy scratch adatbázisba** — egy ellenőrizetlen mentés csak reménykedés. Alapból 14 napot tart meg. |

A mentés a **saját lemezén** van. Egy lemezhiba így is véget vet a projektnek.
Állítsd be a `BACKUP_SYNC_CMD`-t a `.env`-ben, hogy máshová is átmásolja.

> A kiegészítők csomagbájtjai **nem az adatbázisban** vannak, hanem a
> `packages` kötetben. Egy adatbázis-mentés önmagában nem állítja vissza
> őket — lásd [`backup.md`](./backup.md).

---

## Hasznos parancsok

```sh
docker compose logs -f app worker       # naplók
docker compose restart app              # újraindítás
docker compose exec postgres psql -U yume yume     # adatbázis
docker compose run --rm backup db/backup.sh        # azonnali mentés
docker compose run --rm backup db/restore.sh --list
docker compose --profile extensions run --rm extensions   # kiegészítők újrapublikálása
```

Frissítés:

```sh
git pull
docker compose up -d --build            # a migrációk induláskor lefutnak
```

---

## Ha valami nem indul

**`set JWT_SECRET in .env`** — a `.env` nem a `docker-compose.yml` mellett van,
vagy üresen maradt a változó. A compose csak a saját könyvtárából olvassa.

**`app` folyamatosan újraindul** — `docker compose logs app`. A leggyakoribb ok
egy 32 karakternél rövidebb `JWT_SECRET`: éles módban a szerver szándékosan
megtagadja az indulást ilyenkor.

**A Caddy nem kap tanúsítványt** — a domain A rekordja nem erre a gépre mutat,
vagy a 80-as portot elveszi valami más (gyakran egy előre telepített nginx):

```sh
sudo ss -tlnp | grep -E ':80|:443'
sudo systemctl disable --now nginx apache2 2>/dev/null
```

**Üres az áruház** — a kiegészítők publikálása kihagyja magát, amíg nincs
adminisztrátor. Regisztrálj (4. lépés), majd:

```sh
docker compose --profile extensions run --rm extensions
```

**A magyar keresés nem talál ékezetes szavakat** — az adatbázis rossz
kódolással jött létre. A kódolás `initdb` után nem módosítható, csak
újratöltéssel. Ellenőrzés:

```sh
docker compose exec postgres psql -U yume yume -c 'SHOW server_encoding;'
```

`UTF8`-nak kell lennie. Ha `SQL_ASCII`, a `pgdata` kötet egy régebbi indításból
maradt: mentsd ki az adatokat, dobd el a kötetet, és indítsd újra.

---

## Amit ez nem old meg

A Yume magától **egyetlen videót sem játszik le** — a forrásokat kiegészítők
adják, azokat neked kell telepítened és beállítanod az áruházban. A telepítés
kész, a lejátszás ettől még nem az.
