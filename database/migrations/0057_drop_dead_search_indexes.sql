-- ============================================================================
-- 0057 — két index, amit soha senki nem olvasott
-- ============================================================================
-- Az audit DB-03 tétele. Mindkettő `lower()` kifejezésre épül, és mindkettő
-- `idx_scan = 0` az adatbázis létrehozása óta:
--
--     anime_synonyms_lower_idx   15 MB
--     anime_titles_lower_idx    4,6 MB
--
-- Az ok nem az, hogy a keresés nem használ kis-nagybetű-független
-- összehasonlítást — használ. De a `lower()` a RANGSOROLÓ `CASE`-ben van, nem
-- a `WHERE`-ben: a jelölteket a trigram-indexek választják ki, a `CASE` pedig
-- soronként fut a már kiválasztott halmazon. A tervező ezért sosem nyúl
-- hozzájuk.
--
-- Amiért érdemes eldobni őket: nem a húsz megabájt, hanem az ÍRÁSI KÖLTSÉG.
-- Az `anime_synonyms` 224 347 soros, és a katalógus-importok kötegelten írják;
-- minden beszúrás és módosítás karbantartja ezt a két indexet is, fedezet
-- nélkül.
--
-- A TÖBBI nulla olvasású indexet SZÁNDÉKOSAN meghagyom. Kicsik (1 MB alatt),
-- és ritkán használt admin-jelentéseket szolgálhatnak, amiket egyszerűen még
-- senki nem nyitott meg — ott a nulla nem bizonyíték a feleslegességre.
--
-- Visszaállítás, ha mégis kellenének:
--   CREATE INDEX anime_synonyms_lower_idx ON anime_synonyms (lower(synonym));
--   CREATE INDEX anime_titles_lower_idx ON anime_titles (lower(title));

DROP INDEX IF EXISTS anime_synonyms_lower_idx;
DROP INDEX IF EXISTS anime_titles_lower_idx;
