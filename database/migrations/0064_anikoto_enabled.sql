-- Az Anikoto szolgáltató bekapcsolása, KIFEJEZETT SORRAL.
--
-- MIÉRT KELL EZ A SOR. Az adapter mostantól `defaultEnabled: false`, mert
-- minden feloldásnál idegen kiszolgálót hív, és a katalógusindexhez 180 lapot
-- kér le. Sor nélkül tehát minden telepítés — és minden tesztfuttatás —
-- forgalmat küldene egy harmadik félnek pusztán attól, hogy a kód frissült.
-- Mérve: a teljes API-tesztkészlet élő kéréseket indított az anikotoapi.site
-- felé, és egy kikapcsolt szolgáltatót mérő teszt emiatt bukott el.
--
-- Ez a sor a MEGLÉVŐ ÉLES VISELKEDÉST tartja meg: az Anikoto eddig is a
-- láncban volt (sor hiányában, alapértelmezés szerint bekapcsolva), és az is
-- marad — csak most már kiírva, láthatóan, az adminfelületen kapcsolhatóan.
--
-- Kikapcsolás: az adminfelület szolgáltatótáblájában, vagy
--   UPDATE providers SET enabled = false WHERE slug = 'anikoto';

INSERT INTO providers (slug, label, enabled, priority)
VALUES ('anikoto', 'Anikoto', true, 700)
ON CONFLICT (slug) DO NOTHING;
