-- A komment törlése — a hiányzó fél.
--
-- A tábla 0004 óta készen áll rá: a `parent_id` és a `comment_likes` is
-- `ON DELETE CASCADE`, a `hidden_at` pedig a moderálás eszköze („a törzs
-- megmarad a fellebbezéshez"). Ami hiányzott, az a SZERZŐ saját törlése — és
-- vele az a megkülönböztetés, hogy egy komment azért nincs ott, mert a
-- szerzője levette, vagy mert egy moderátor elrejtette.
--
-- MIÉRT NEM ELÉG A SOR ELDOBÁSA. A `parent_id` cascade-je a válaszokat is
-- elvinné — vagyis egy szálindító törlése MÁSOK hozzászólásait törölné.
-- Ezért: levél komment esetén a sor tényleg eltűnik, szál esetén sírkő marad.
--
-- A `body` NEM marad meg. A séma `CHECK (length(body) BETWEEN 1 AND 10000)`
-- miatt nem lehet üres, ezért egy rövid jelölő kerül a helyére; az eredeti
-- szöveg elvész, és ez a szándék.

ALTER TABLE comments
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMENT ON COLUMN comments.deleted_at IS
  'A szerző (vagy egy moderátor) levette. Sírkő: a sor csak a szál alakját tartja, a törzs elveszett.';

-- A listázás a `hidden_at IS NULL` részleges indexen megy. A sírkövek
-- LÁTSZANAK — különben a szál szétesne —, tehát az index feltétele nem
-- változik; ez az index csak azért kerül ide, hogy a „mit törölt a szerző"
-- kérdés se legyen teljes táblaolvasás.
CREATE INDEX IF NOT EXISTS comments_deleted_idx
  ON comments (deleted_at) WHERE deleted_at IS NOT NULL;
