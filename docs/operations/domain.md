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

## Lépések

### 1. A domain a Cloudflare-re (a tulajdonos dolga)

1. Cloudflare → **Add a site** → `animehub.hu` → **Free**
2. Két `A` rekord, mindkettő **Proxied** (narancssárga felhő):

   | Type | Name | Tartalom | Proxy |
   |---|---|---|---|
   | A | `@` | `83.229.82.185` | Proxied |
   | A | `www` | `83.229.82.185` | Proxied |

3. A Cloudflare által kiírt két névkiszolgáló beállítása **a regisztrátornál**
4. **SSL/TLS → Overview → `Full (strict)`**. A „Flexible" titkosítatlanul
   továbbítana az origin felé, és átirányítási hurkot okoz.

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

### 5. `media.animehub.hu` — a képtükör kifizetődése

A képek ma az R2-ben vannak, de a látogató még az eredeti CDN-ről kapja őket.
Saját domainnel az R2 közvetlenül szolgálhat ki, **nulla kimenő díjjal**, a
látogatóhoz legközelebbi Cloudflare él-szerverről:

1. Cloudflare → **R2 → yume-media → Settings → Custom Domains → Connect Domain**
   → `media.animehub.hu`
2. A DNS-rekord automatikusan elkészül
3. A katalógus lekérdezései a `mirror_key`-t adják vissza `object_key` helyett,
   `https://media.animehub.hu/<kulcs>` alakban

A harmadik lépés kódváltozás, és külön, visszavonható lépésnek való: addig a
képek az eredeti forrásról jönnek, ahogy eddig.

## Ami az átállás után is nyitva marad

A `83.229.82.185` továbbra is elérhető, tehát aki megtalálja az origin IP-t,
megkerülheti a Cloudflare-t — és egy Cloudflare-címről (például WARP-ról)
közvetlenül érkező hívás fejlécét a bizalmi lista el is hiszi. Ezt nem a
`TRUST_PROXY` javítja, hanem az, ha az origin csak a Cloudflare tartományaiból
fogad kapcsolatot a 80/443-on. A gépen viszont ott a `yonagifansub.duckdns.org`
is ugyanazokon a portokon, ezért ez külön döntés — lásd az audit `NET-01`
tételét.
