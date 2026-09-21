-- A forrásszolgáltatók nyilvántartása.
--
-- MIÉRT TÁBLA, ÉS NEM KÖRNYEZETI VÁLTOZÓ. A `video_sources` 0003 óta hordoz
-- egy `provider` oszlopot, de sehol nem volt olyan hely, ahol egy szolgáltató
-- LÉTEZIK: a kód regisztrálta magát, és kész. Emiatt nem lehetett
--
--   * kikapcsolni egyet anélkül, hogy hozzányúlnánk a kódhoz és újraindítanánk;
--   * sorrendet adni nekik;
--   * megmondani, mikor romlott el, és mióta.
--
-- Ez a tábla az a hely. A kód azt mondja meg, MIT TUD egy szolgáltató; ez a
-- tábla azt, hogy HASZNÁLJUK-E, és milyen sorrendben.
--
-- A SOR NEM HOZZA LÉTRE A SZOLGÁLTATÓT. Ha a kódból eltűnik egy adapter, a
-- sora itt maradhat — a beállítás akkor is megmarad, ha valaki ideiglenesen
-- kiveszi az adaptert, és nem kell újra beállítania. A regiszter azt tekinti
-- létezőnek, amihez van kód; a tábla csak a HOZZÁ tartozó döntéseket tárolja.

CREATE TABLE IF NOT EXISTS providers (
  -- Az adapter azonosítója a kódban (`AnimeProvider.id`). Nem uuid: ezt
  -- ember írja le egy adminfelületen és egy naplóban is, és a `yume-local`
  -- többet mond, mint egy véletlen szám.
  slug            text PRIMARY KEY,

  -- Emberi név. Az adapter ad egy alapértelmezést; ez felülírja, ha egy
  -- üzemeltető mást akar látni a panelen.
  label           text,

  -- A KAPCSOLÓ. Ez az egyetlen dolog, amit egy megszűnt szolgáltató
  -- eltávolításához el kell állítani.
  enabled         boolean     NOT NULL DEFAULT true,

  -- Kisebb szám = előbb próbáljuk. Azonos prioritásnál az egészség dönt.
  priority        smallint    NOT NULL DEFAULT 100,

  -- Adapterenkénti beállítás (alap-URL, régió, kulcs-azonosító). SOHA nem
  -- titok: a titkok a környezetben maradnak, ide csak az kerül, ami egy
  -- adminfelületen megjeleníthető.
  config          jsonb       NOT NULL DEFAULT '{}'::jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- A rangsor lekérdezése minden feloldásnál lefut.
CREATE INDEX IF NOT EXISTS providers_ranked_idx
  ON providers (enabled, priority) WHERE enabled;

-- ---------------------------------------------------------------------------
-- A szolgáltatók eseménynaplója — az egészség alapja.
--
-- MIÉRT NEM CSAK MEMÓRIÁBAN. A körkörös megszakító állapota lehet memóriában
-- (gyors, és egy újraindítás után tiszta lappal indulni helyes). Amit viszont
-- egy üzemeltetőnek látnia kell — „mióta romlik?", „melyik hiba jön vissza?"
-- —, az nem élhet túl egy telepítést egy processzen belüli számlálóban.
--
-- Ez a tábla RITKÁN ír: csak állapotváltozáskor (jó → rossz, rossz → jó) és
-- feloldási hibánál, nem minden kérésnél.
CREATE TABLE IF NOT EXISTS provider_events (
  id          bigserial   PRIMARY KEY,
  slug        text        NOT NULL,
  -- 'up' | 'down' | 'degraded' | 'error' | 'disabled' | 'enabled'
  event       text        NOT NULL,
  -- Egy mondat, ami megmagyarázza. Ez az, amit a panelen olvasni lehet.
  detail      text,
  -- Mérés, ha volt: hány ezredmásodperc, hány forrás jött vissza.
  latency_ms  integer,
  sources     integer,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_events_recent_idx
  ON provider_events (slug, at DESC);
