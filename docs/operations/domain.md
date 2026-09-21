# Saját domain alá költözés — `animehub.hu`

Ez a leírás az `yumee.duckdns.org` → `animehub.hu` átállást írja le, Cloudflare
proxyval. A sorrend számít, és minden lépésnek van ellenőrzése.

## Miért nem lehetett előbb

A `duckdns.org` zóna nem a miénk (a névkiszolgálói `ns5/7/8.duckdns.org`), tehát
nem lehetett Cloudflare mögé tenni. Ezért nem volt CDN, DDoS-elnyelés, és az
R2-vödör sem kaphatott saját domaint. A saját domain ezt mind kinyitja.

## A veszélyes rész: ki a látogató?

A lánc ma:

    látogató → Caddy (172.20.0.6) → app

és a Cloudflare bekapcsolása után:

    látogató → Cloudflare → Caddy → app

A Cloudflare beírja a látogató címét az `X-Forwarded-For`-ba, a Caddy pedig
hozzáfűzi a saját peer-jét — vagyis a Cloudflare él-szerverének címét. Ha a
`TRUST_PROXY` csak a Docker-hálózatot ismeri, az app jobbról balra haladva a
Cloudflare címénél megáll, és onnantól **minden látogató ugyanaz a cím**.

Mérve, a régi beállítással szimulált Cloudflare-lánccal:

    request.ip = 172.70.130.45      ← a Cloudflare él-szervere

A sebességkorlát ettől nem hibázik el: tovább „működik", csak az egész
internetet egy vödörbe teszi, és mindenkit együtt zár ki. Kivételt nem dob,
naplót nem ír. Ezt a `cloudflare-chain.test.ts` méri, mindkét irányban — hogy a
látogatót felismerjük, és hogy egy közvetlen kapcsolatból beírt fejlécet ne
higgyünk el.

## AMI VALÓJÁBAN TÖRTÉNT — 2026-09-17

Az átállás megtörtént. Ez a szakasz azt rögzíti, ami a tervhez képest MÁSKÉNT
sült el, mert a tanulság a következő domainnél is érvényes lesz.

### A tanúsítvány tyúk-tojás problémája

A terv szerint a Caddy egyszerűen kért volna Let's Encrypt-tanúsítványt. Nem
tudott, és a hibaüzenet a Cloudflare-től jött: **525 SSL Handshake Failed**.

Az ok nem nyilvánvaló:

```
curl http://animehub.hu/.well-known/acme-challenge/proba
  → 308, Server: cloudflare      ← az ÉLEN irányít át HTTPS-re
```

A Cloudflare a HTTP-kihívást átirányítja HTTPS-re; a Let's Encrypt követi az
átirányítást; a HTTPS-kapcsolat visszajön hozzánk — ahhoz viszont épp az a
tanúsítvány kellene, amit meg akarunk szerezni.

**A feloldás három lépésben:**

1. `tls internal` — a Caddy helyben aláírt tanúsítványt ad. A Cloudflare
   `Full` módban ezt elfogadja (titkosít, de nem hitelesít), tehát az
   origin-kapcsolat feláll;
2. ettől a kihívás útja járhatóvá válik. Mérve:
   `curl -L http://animehub.hu/.well-known/acme-challenge/proba-utvonal`
   → `elerheto`;
3. innentől kérhető valódi tanúsítvány. Meg is jött, mindkét névre:
   `certificate obtained successfully · issuer: letsencrypt`.

### A Caddy eldobta a látogató címét

Ez volt a legfontosabb felfedezés, és a `TRUST_PROXY` **önmagában nem oldotta
meg**. A Caddy 2.7 óta alapértelmezésben NEM hiszi el a beérkező
`X-Forwarded-For` fejlécet: felülírja a közvetlen peer címével. Ez helyes
védelem a hamisítás ellen — de a Cloudflare mögött pont a látogató címét
dobja el.

Mérve, a `.env` beírása UTÁN, a Caddy beállítása ELŐTT:

```
request.ip = 141.101.76.109 / 162.158.74.20 / 172.71.95.140
             └─ mind Cloudflare él-szerver, nem a látogató
```

A megoldás a Caddy globális blokkja:

```
{
	servers {
		trusted_proxies static <a Cloudflare tartományai>
	}
}
```

A listát ugyanaz a szkript írja, ami a `.env`-be is:

```bash
scripts/cloudflare/trust-proxy.sh --caddy /opt/YonagiFansub/Caddyfile
```

### A becsatolt fájl és az inode

A szkript első változata `mv`-vel cserélte a Caddyfile-t. A Caddyfile **fájl
szinten** van becsatolva a konténerbe, és egy `mv` ÚJ INODE-ot hoz létre — a
becsatolás pedig a régit tartja. A konténer ezért egy láthatatlan, elavult
példányt olvasott:

```
gazdagép:  108 sor          konténer:  90 sor
caddy reload → "config is unchanged"
```

A szkript azóta **helyben ír**, és ezt a fájl is kimondja. Ha mégis előfordul:
`docker compose restart caddy` újraoldja a becsatolást.

### Az eredmény, mérve

```
a sebességkorlát számlálója három kérésre:  1199 → 1198 → 1197
hamisított X-Forwarded-For-ral:             1196 → 1195   (ugyanaz a vödör)
az origin tanúsítványa:                     CN=animehub.hu, Let's Encrypt
mind a négy cím:                            200
```

## Lépések

### 1. A domain a Cloudflare-re (a tulajdonos dolga)

1. Cloudflare → **Add a site** → `animehub.hu` → **Free**
2. Két `A` rekord, mindkettő **Proxied** (narancssárga felhő):

   | Type | Name | Tartalom | Proxy |
   |---|---|---|---|
   | A | `@` | `83.229.82.185` | Proxied |
   | A | `www` | `83.229.82.185` | Proxied |

3. A Cloudflare által kiírt két névkiszolgáló beállítása **a regisztrátornál**
4. **SSL/TLS → Overview → `Full`** az átállás idejére. A „Flexible"
   titkosítatlanul továbbítana az origin felé, és átirányítási hurkot okoz.

   **A `Full (strict)`-re a valódi tanúsítvány megszerzése UTÁN kell váltani** —
   előtte a saját aláírású tanúsítványt elutasítaná, és a 525 megmaradna. A
   `Full` titkosít, de nem hitelesíti az origint; a `Full (strict)` mindkettőt
   megteszi, és most már át lehet rá állni.

MX rekordot csak akkor, ha tényleg lesz levelezés `@animehub.hu` címre — egy
rossz MX rosszabb, mint a semmi.

**Ellenőrzés:**
```bash
dig +short NS animehub.hu        # cloudflare.com névkiszolgálókat kell adnia
dig +short A animehub.hu         # Cloudflare él-címeket, NEM 83.229.82.185-öt
```
A második azért nem az origin IP-je, mert a rekord proxyzott — ez a helyes.

### 2. `TRUST_PROXY`

```bash
scripts/cloudflare/trust-proxy.sh            # megnézni
scripts/cloudflare/trust-proxy.sh --write    # beírni a .env-be
docker compose up -d app worker
```

A lista a Cloudflare-től jön minden futáskor, nem kézzel bemásolva: a
tartományok időnként bővülnek, és egy elavult lista némán rontja el ugyanazt,
amit a beállítás megold.

**Ellenőrzés:** öt kérés hamisított `X-Forwarded-For`-ral — a sebességkorlát
számlálójának végig csökkennie kell, vagyis a valódi címhez tapadnia:
```bash
for i in 1 2 3 4 5; do
  curl -s -D- -o /dev/null -H "X-Forwarded-For: 203.0.113.$i" \
    https://animehub.hu/v1/config | grep -i ratelimit-remaining
done
```

### 3. Caddy

Az `animehub.hu` kap saját blokkot, a `yumee.duckdns.org` pedig **megmarad**
átirányítással — a régi linkek, könyvjelzők és a Discord-webhook címei ne
törjenek el.

### 4. `PUBLIC_URL`

```
PUBLIC_URL=https://animehub.hu
```
Ezt a SEO kanonikus URL-jei, az `og:url` és a webhook-üzenetek linkjei
használják. A Biztonság képernyő ellenőrzése figyelmeztet, ha üres vagy nem
egyezik.

### 5. A képtükör használatba vétele — **KÉSZ**

A képek a tükörből mennek ki. Ez a lépés megtörtént, és nem igényelt semmilyen
Cloudflare-beállítást.

**Amit ez javított:** a tükrözés 56 997 képet másolt az R2-be, és utána **senki
nem használta** — a katalógus továbbra is az idegen CDN-re mutatott. A képek
ott voltak nálunk, és a látogató máshonnan töltötte le őket.

A döntés EGY helyen van (`modules/media/public-url.ts`), nem huszonhat
lekérdezésben szétszórva: egy elfelejtett lekérdezés csendben visszaesne az
idegen CDN-re, és semmi nem hibázna tőle.

Mérve, böngészőben, a főoldalon:

```
betöltött kép: 160 · saját tükörből: 160 · idegen CDN-ről: 0 · hibás: 0
cache-control: public, max-age=31536000, immutable
cf-cache-status: HIT          ← a Cloudflare már gyorsítótárazza
```

### 6. `media.animehub.hu` — **KÉSZ**

A kép ma a saját gépünkön megy át (`/media/…`), és a Cloudflare a saját élén
gyorsítótárazza. Ami még hátravan: a gyorsítótár-tévesztés is közvetlenül az
R2-ből menjen, a mi gépünk megkerülésével.

1. Cloudflare → **R2 → yume-media → Settings → Custom Domains → Connect
   Domain** → `media.animehub.hu`

   A DNS-rekord és a tanúsítvány automatikusan elkészül. Ez az EGYETLEN lépés,
   amit nem lehet innen elvégezni: az R2 vödör beállítása a Cloudflare
   REST API-ján megy, amihez a tárolókulcsok (S3) nem elegendők.

2. Ellenőrzés:

   ```bash
   dig +short media.animehub.hu
   curl -sI https://media.animehub.hu/media/cover/<bármelyik kulcs>.jpg
   ```

3. Átkapcsolás — **egy sor**:

   ```bash
   echo 'MEDIA_BASE_URL=https://media.animehub.hu' >> .env
   docker compose up -d app
   ```

4. Visszavonás, ha bármi gond van: vedd ki a sort, `docker compose up -d app`.
   A képek azonnal a saját `/media/` útvonalra esnek vissza, ami végig
   működik.

**Ez megvan.** A képek a `media.animehub.hu` címről mennek ki, a vödrön ott a
CORS-szabály (enélkül a lejátszó környezeti fénye csendben elmaradt), és a
karbantartási oldal háttérvideója is onnan jön. A részletek — a feltöltés, a
CORS, az objektumok eltávolítása, a költségek — külön lapon:
[`media.md`](media.md).

### 7. A Cloudflare megkerülése lezárva — **KÉSZ**

A `83.229.82.185` a világ elől nincs elrejtve, és aki megtudja, `--resolve`-val
közvetlenül idejöhet. Kipróbálva: **HTTP 200-at adott** — az ilyen kérés
kihagyta a WAF-ot, a DDoS-elnyelést és a gyorsítótárat.

A szokásos megoldás a tűzfalban zárná le a 80/443-at a Cloudflare
tartományaira, az viszont **eltörné a `yonagifansub.duckdns.org`-ot**, ami
ugyanazokon a portokon fut és nincs Cloudflare mögött. Ezért a szűrés
**nevenként** van: az `animehub.hu` blokk zár (`@nem_cloudflare` → 403), a többi
érintetlen. Mérve: a megkerülő kérés 403, a Cloudflare-en át 200, a másik két
gazda változatlan.

A lista generálva: `scripts/cloudflare/trust-proxy.sh --caddy /opt/YonagiFansub/Caddyfile --matcher`

## Ami az átállás után is nyitva marad

* **SSL/TLS mód.** Az origin ma valódi Let's Encrypt tanúsítványt hord, tehát a
  Cloudflare `Full (strict)`-re állítható — ez az egyetlen mód, amiben a
  Cloudflare hitelesíti is az origint. A `Full` titkosít, de nem ellenőriz. A
  kapcsoló a Cloudflare felületén van.
* **Az R2-token hatóköre** (`SEC-02`): fiókszintű, és két vödörre kellene
  szűkíteni.
* **Zóna-ürítés.** Nincs Cloudflare API-tokenünk, ezért a gyorsítótárat nem
  tudjuk parancsból üríteni — egy fejlécváltozás hatása a `max-age` lejártáig
  (ma négy óra) késik.
