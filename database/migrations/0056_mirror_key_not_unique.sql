-- ============================================================================
-- 0056 — a tükörkulcs nem egyedi, és ez nem elnézés
-- ============================================================================
-- A 0055 egyedi indexet tett az `anime_images.mirror_key`-re, abból a
-- feltételezésből, hogy „egy kulcs egy kép". A tárhelyen ez igaz is: a kulcs a
-- forrás URL-jének hasítása, tehát egy URL egy objektum.
--
-- A KATALÓGUSBAN viszont TÖBB SOR mutathat UGYANARRA a forrás-URL-re — ugyanaz
-- a borító két bejegyzéshez, egy helyettesítő kép, egy duplikált import. Ezek
-- a sorok mind ugyanazt a kulcsot kapják, és a második beszúrás elhasal.
--
-- Mérve, éles tükrözés közben: 3 624 letükrözött borítóból 119 bukott el
-- `duplicate key value violates unique constraint` hibával — a kép egyébként
-- megérkezett a tárhelyre, csak a sor nem tudta feljegyezni. Az R2 is
-- panaszkodott ugyanerre („Reduce your concurrent request rate for the same
-- object"), mert két szál egyszerre írta ugyanazt a kulcsot.
--
-- A keresésnek (kulcsról a sorra) továbbra is kell index, csak nem egyedi.
DROP INDEX IF EXISTS anime_images_mirror_key_idx;

CREATE INDEX IF NOT EXISTS anime_images_mirror_key_idx
  ON anime_images (mirror_key) WHERE mirror_key IS NOT NULL;

-- Akiket emiatt adtunk fel, azok kapjanak új esélyt: a kép valójában ott van,
-- csak a sor nem tudta feljegyezni.
UPDATE anime_images SET mirror_attempts = 0
 WHERE mirror_key IS NULL AND mirror_attempts >= 3;
