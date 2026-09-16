-- ============================================================================
-- 0049 — a böngészés ne olvassa végig a katalógust harminc sorért
-- ============================================================================
-- A főoldal tíz sort kér egyszerre, és mindegyik ugyanannak a lekérdezésnek egy
-- változata: szűrés `visibility = 'public'`-ra, rendezés egy oszlop szerint,
-- LIMIT 30. Mérve, index nélkül:
--
--     ORDER BY popularity    Parallel Seq Scan 30 756 sor + rendezés
--     ORDER BY trending      Seq Scan 32 462 sor        ~31 ms
--     ORDER BY average_score Seq Scan 32 462 sor        ~31 ms
--
-- A meglévő `anime_browse_idx (status, season_year DESC, popularity DESC)` ezt
-- nem tudja kiszolgálni: `status`-szal kezdődik, tehát csak akkor használható,
-- ha a kérés állapotra is szűr. A főoldal négy sora nem szűr.
--
-- Egy főoldal-betöltés így hat teljes tábla-olvasást jelentett, egyenként
-- harminc ezredmásodperc körül.
--
-- Három index, három ténylegesen használt rendezéshez. A `start_date`
-- („legújabb") és a `canonical_title` szándékosan kimarad: a keresőben
-- választható, de a főoldal nem kéri, és egy index, amit senki nem használ,
-- írási költség fedezet nélkül. Ha egyszer forró útra kerül, akkor kap.
--
-- Részleges index `WHERE visibility = 'public'`-ra: a katalógus 32 390 sorából
-- ma mind publikus, de a rejtett címek nem tartoznak a böngészésbe, és a
-- feltétel a lekérdezésben is ott van.
--
-- Az `id` a második oszlop, mert a kulcsos lapozás `(sort_value, id)` páron
-- megy: enélkül a rendezés stabil, de a lapozás nem.
--
-- CONCURRENTLY nélkül: a migrációs futó tranzakcióban dolgozik, és ez a tábla
-- harmincezer soros — a zárolás ezredmásodpercekig tart, nem percekig.

CREATE INDEX IF NOT EXISTS anime_browse_popularity_idx
  ON anime (popularity DESC NULLS LAST, id) WHERE visibility = 'public';

CREATE INDEX IF NOT EXISTS anime_browse_trending_idx
  ON anime (trending DESC NULLS LAST, id) WHERE visibility = 'public';

CREATE INDEX IF NOT EXISTS anime_browse_score_idx
  ON anime (average_score DESC NULLS LAST, id) WHERE visibility = 'public';
