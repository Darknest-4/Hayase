-- Az AnimeParadise szolgáltató felvétele.
--
-- KIKAPCSOLVA JÖN LÉTRE, és ez nem óvatoskodás. Az adapter
-- `defaultEnabled: false`, mert minden feloldásnál idegen kiszolgálót hív; a
-- sor viszont AKKOR IS kell, ha kikapcsolva marad, mert enélkül az
-- adminfelület kapcsolója nem tudna mit átállítani, és a szolgáltató
-- „láthatatlanul kikapcsolt" állapotban lenne.
--
-- Prioritás 600: a saját katalógusunk (`yume-local`, 10) elé semmi nem
-- mehet — az üzemeltető által kézzel felvett forrás erősebb állítás arról,
-- hogy ez a helyes videó, mint bármilyen külső találat.
--
-- Bekapcsolás: az adminfelület szolgáltatótáblájában, vagy
--   UPDATE providers SET enabled = true WHERE slug = 'animeparadise';

INSERT INTO providers (slug, label, enabled, priority)
VALUES ('animeparadise', 'AnimeParadise', false, 600)
ON CONFLICT (slug) DO NOTHING;
