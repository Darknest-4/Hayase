-- ============================================================================
-- 0067 — Szolgáltatói mérőszámok, napi bontásban
-- ============================================================================
-- MIÉRT KELL ÚJ TÁBLA. A `provider_events` már létezik, de az ÁLLAPOTVÁLTOZÁST
-- naplózza — „ez a szolgáltató most leesett", „most visszajött" —, nem a
-- kéréseket. Mérve, éles adatbázison: NULLA sor. Egy „hibaarány" vagy „átlagos
-- válaszidő" panel abból nem építhető, mert az adat nem létezik.
--
-- Amit a lánc viszont MÁR MOST kiszámol minden feloldásnál: a `Resolution.
-- attempts` tömböt, benne szolgáltatónként a kimenetet, a forrásszámot és az
-- eltelt időt. Ez eddig csak a válaszban utazott, és eldobódott. Ez a tábla
-- azt őrzi meg, összesítve.
--
-- NAPI ÖSSZESÍTŐ, NEM NYERS ESEMÉNY — a modul szabálya szerint: „a panel soha
-- nem olvas nyers eseménytáblát". Egy feloldás három kísérletet is jelenthet,
-- és forgalmas napon ez sok millió sor lenne; napi bontásban szolgáltatónként
-- és kimenetenként egy sor.
--
-- A SZÁMLÁLÓK ÖSSZEADÓDNAK (`count + excluded.count`), nem felülíródnak. Ez
-- szándékosan más, mint a `rollup.ts` újraszámoló összesítői: ott a forrás a
-- nyers tábla, itt a memóriában gyűlt DELTA. Egy köteg kétszeri kiírása
-- duplázna — ezért a kiírás a puffer ürítésével egy lépésben történik, és a
-- puffer a kiírás előtt ürül ki.
-- ============================================================================

CREATE TABLE IF NOT EXISTS provider_metrics_daily (
  day             date        NOT NULL,
  slug            text        NOT NULL,
  -- 'ok' | 'empty' | 'error' | 'timeout' | 'skipped' — a lánc saját szótára
  -- (`Resolution.attempts[].outcome`). Nem szűkítjük `CHECK`-kel: egy új
  -- kimenet bevezetése nem hasalhat el egy migráción.
  outcome         text        NOT NULL,
  attempts        integer     NOT NULL DEFAULT 0,
  -- Hány forrást adott összesen. Csak `ok` kimenetnél értelmes, de minden
  -- soron ott van, hogy az összegzés ne kelljen ágazzon.
  sources         integer     NOT NULL DEFAULT 0,
  -- Az átlagos válaszidő ebből és az `attempts`-ből számolható. Összeget
  -- tárolunk, nem átlagot: átlagok átlaga nem átlag.
  latency_ms_sum  bigint      NOT NULL DEFAULT 0,
  latency_ms_max  integer     NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, slug, outcome)
);

-- A panel „az elmúlt N nap, minden szolgáltató" alakban kérdez, tehát a nap a
-- vezető oszlop. Az elsődleges kulcs (day, slug, outcome) ezt már fedi;
-- a fordított irányra — „ennek a szolgáltatónak a története" — külön index.
CREATE INDEX IF NOT EXISTS provider_metrics_daily_slug_day_idx
  ON provider_metrics_daily (slug, day DESC);
