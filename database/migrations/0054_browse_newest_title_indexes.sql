-- ============================================================================
-- 0054 — a „legújabb" és a „cím szerint" rendezés is kapjon indexet
-- ============================================================================
-- A 0049 három böngészési rendezéshez adott indexet, a `start_date`-et és a
-- `canonical_title`-t pedig SZÁNDÉKOSAN kihagyta, ezzel az indoklással:
--
--     „a keresőben választható, de a főoldal nem kéri, és egy index, amit
--      senki nem használ, írási költség fedezet nélkül. Ha egyszer forró útra
--      kerül, akkor kap."
--
-- Ez a migráció azt mondja: forró útra került. A katalógusoldal rendezőválasztója
-- mindkettőt felkínálja (`apps/web/src/entities/anime/catalogue.js`,
-- `START_DATE_DESC: 'newest'` és `TITLE_ROMAJI: 'title'`), tehát egy kattintás
-- választja el őket a főoldaltól.
--
-- ÉLESEN MÉRVE, index nélkül (EXPLAIN ANALYZE, 2026-09-16):
--
--     ORDER BY start_date DESC      Seq Scan 30 828 sor + top-N heapsort  31,3 ms
--     ORDER BY canonical_title ASC  Seq Scan 30 828 sor + top-N heapsort  34,0 ms
--
-- Végponton mérve ugyanez 56 ms volt, szemben a rendezés nélküli 31 ms-mal —
-- vagyis a válaszidő fele a rendezésre ment el.
--
-- Ugyanaz az alak, mint a 0049-ben: részleges index a publikus sorokra, és az
-- `id` a második oszlop, mert a kulcsos lapozás `(sort_value, id)` páron megy.
-- A `NULLS LAST` a `start_date`-nél azért kell, mert a katalógusban sok cím
-- kezdődátuma ismeretlen, és azok a lista VÉGÉRE valók, nem az elejére.
--
-- Az írási költség fedezete: az `anime` táblát kötegelt importok írják, nem
-- felhasználói forgalom — két további részleges B-fa körülbelül egy-egy
-- megabájt, és az import másodpercei közül nem visz el észrevehetőt.
--
-- CONCURRENTLY nélkül, a 0049 okából: a migrációs futó tranzakcióban dolgozik,
-- és harmincezer soron a zárolás ezredmásodpercekig tart.

CREATE INDEX IF NOT EXISTS anime_browse_newest_idx
  ON anime (start_date DESC NULLS LAST, id) WHERE visibility = 'public';

CREATE INDEX IF NOT EXISTS anime_browse_title_idx
  ON anime (canonical_title ASC, id) WHERE visibility = 'public';
