-- ============================================================================
-- 0075 — Egységes eseményséma
-- ============================================================================
-- A PROBLÉMA. Ma minden eseményfajtának SAJÁT TÁBLAALAKJA van: a
-- `page_views`-nak útvonala, a `search_stats`-nak kifejezése, az
-- `account_events`-nek fiókja. Ez a meglévő tábláknál helyes — egy szűk,
-- indexelhető alak gyorsabb, mint egy általános —, de két dolgot lehetetlenné
-- tesz:
--
--   1. ÚJ eseményfajtát csak új táblával lehet felvenni, tehát a legkisebb
--      mérés is migrációt kér;
--   2. nincs KÖZÖS azonosító és nincs közös deduplikáció, tehát két
--      eseményfajta között nem lehet összefüggést nézni.
--
-- A MÁSODIKRA VAN KONKRÉT PÉLDA, és ez a tábla elsősorban miatta született: a
-- „keresés → megnyitás" arány. A keresést mérjük, a megnyitást is, de a KETTŐ
-- KÖZTI kapcsolatot nem — pedig egy katalógusnál ez az egyik legfontosabb
-- szám: megtalálják-e, amit keresnek.
--
-- A MEGLÉVŐ TÁBLÁKAT NEM ÍRJUK ÁT. Ez a tábla az ÚJ eseményeké, meg azoké,
-- amiknek ma nincs otthonuk. Egy működő, indexelt, összesített rendszert
-- átköltöztetni egy általános alakra kockázat haszon nélkül: ugyanazok a
-- számok jönnének, lassabban.
--
-- A DEDUPLIKÁCIÓ KULCSA IDŐABLAKOS. Egy tartósan egyedi kulcs azt jelentené,
-- hogy ugyanaz a felhasználó ugyanazt SOHA többé nem csinálhatja — pedig egy
-- címet kétszer is meg lehet nyitni. A kulcsban ezért benne van egy
-- időszelet: ugyanaz az esemény ugyanabban a tíz másodpercben egy, két perc
-- múlva viszont másik esemény. Ez pontosan az a viselkedés, amit az
-- oldalletöltés-gyűjtő memóriában már csinál — itt tartósan, több példány
-- között is.
-- ============================================================================

CREATE TABLE IF NOT EXISTS analytics_events (
  -- Az esemény saját azonosítója. A hívó is megadhatja (idempotens
  -- újraküldéshez); ha nem, a Postgres ad.
  event_id   uuid        NOT NULL DEFAULT gen_random_uuid(),
  -- Pont-elválasztott, zárt szótár a kódban (`analytics/events.ts`). NEM
  -- szabad szöveg: egy elgépelt típusnév némán új eseményfajtát hozna létre,
  -- és a kimutatásból pont az hiányozna, amit mérni akartunk.
  event_type text        NOT NULL,
  -- Ki. A bejelentkezett felhasználó, VAGY a napi látogatói kulcs — soha nem
  -- mindkettő, és soha nem IP. A látogatói kulcs naponta cserélődik (lásd
  -- `analytics/visitor.ts`), tehát napokon átívelő követésre alkalmatlan.
  user_id    uuid        REFERENCES users(id) ON DELETE SET NULL,
  visitor_key text,
  -- Mire vonatkozik: anime, epizód, keresőkifejezés — típusfüggő.
  subject_type text,
  subject_id   text,
  -- Minden más, ami az adott típushoz tartozik. Kis, zárt objektum: ide NEM
  -- kerül szabad felhasználói szöveg és semmi, ami egy embert azonosít.
  metadata   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Az időablakos deduplikációs kulcs. Lásd a fejlécet.
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, created_at)
) PARTITION BY RANGE (created_at);

-- A LEKÉRDEZÉS ALAKJA: „ebből a típusból mi volt ebben az időszakban".
CREATE INDEX IF NOT EXISTS analytics_events_type_idx
  ON analytics_events (event_type, created_at DESC);

-- „Mi történt ezzel a címmel" — a keresés→megnyitás összekötéshez.
CREATE INDEX IF NOT EXISTS analytics_events_subject_idx
  ON analytics_events (subject_type, subject_id, created_at DESC)
  WHERE subject_id IS NOT NULL;

/*
 * A DEDUPLIKÁCIÓ EGYEDI INDEXE.
 *
 * Particionált táblán az egyedi index MINDEN partícióra külön érvényes, és
 * tartalmaznia kell a particionáló oszlopot. Ez elég: a deduplikációs ablak
 * (10 másodperc) sosem lép át hónaphatárt úgy, hogy az számítana — két
 * ugyanolyan esemény a hónapforduló két oldalán két esemény.
 */
CREATE UNIQUE INDEX IF NOT EXISTS analytics_events_dedupe_idx
  ON analytics_events (dedupe_key, created_at)
  WHERE dedupe_key IS NOT NULL;

-- Az első partíciók. A továbbiakat a `partitions.ts` hozza létre — lásd ott,
-- hogy miért nem elég a migrációba beírni őket.
CREATE TABLE IF NOT EXISTS analytics_events_2026_09 PARTITION OF analytics_events
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS analytics_events_2026_10 PARTITION OF analytics_events
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

-- A keresés→megnyitás arányához a napi összesítőben is kell egy oszlop.
ALTER TABLE analytics_daily
  ADD COLUMN IF NOT EXISTS search_result_opens integer NOT NULL DEFAULT 0;
