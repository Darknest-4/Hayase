-- ============================================================================
-- 0055 — a katalógus képeinek tükre
-- ============================================================================
-- A YUME mind az 57 012 borítóját, bannerét és háttérképét IDEGEN kiszolgálóról
-- hotlinkeli: 30 377 az `s4.anilist.co`-ról, 16 663 az `artworks.thetvdb.com`-
-- ról, 9 794 a `cdn.myanimelist.net`-ről. Az `object_key` oszlop nem tárolási
-- kulcsot tartalmaz, hanem a szolgáltató teljes CDN-URL-jét, és a kliens
-- közvetlenül azt teszi az `<img src>`-be.
--
-- Ennek EGY előnye van és egy kockázata. Az előny, hogy a képek nem kerülnek
-- sávszélességbe: a látogató böngészője tölti őket. A kockázat, hogy a
-- katalógus kinézete három olyan cégen múlik, amelyikkel nincs szerződés — ha
-- bármelyik letiltja a hotlinkelést vagy sebességkorlátoz (ez rendszeresen
-- megtörténik), a YUME egyik napról a másikra képek nélkül marad, és akkor már
-- letükrözni sem lehet őket.
--
-- Ezért ez a migráció NEM VÁLTOZTAT azon, honnan szolgáljuk ki a képeket. Csak
-- helyet csinál a másolatnak:
--
--   mirror_key      a tárhelybeli kulcs, ha már letükröztük
--   mirrored_at     mikor
--   mirror_attempts hányszor próbáltuk sikertelenül — egy véglegesen halott
--                   URL-t nem kell minden futásban újra megkísérelni
--
-- A kiszolgálás átkapcsolása külön, egyetlen beállításon múlik
-- (`media_mirror_serve`), és alapból ki van kapcsolva. Amit itt megnyerünk, az
-- az, hogy a másolat MEGVAN, mire szükség lesz rá.

ALTER TABLE anime_images
  ADD COLUMN IF NOT EXISTS mirror_key text,
  ADD COLUMN IF NOT EXISTS mirrored_at timestamptz,
  ADD COLUMN IF NOT EXISTS mirror_attempts smallint NOT NULL DEFAULT 0;

-- A tükrözendő sorok keresése: aminek van forrása, még nincs tükre, és nem
-- bukott el háromszor. Részleges index, mert a kész sorok (előbb-utóbb a
-- túlnyomó többség) nem tartoznak a kérdéshez, és nem kell helyet foglalniuk.
CREATE INDEX IF NOT EXISTS anime_images_unmirrored_idx
  ON anime_images (kind, id)
  WHERE mirror_key IS NULL AND mirror_attempts < 3;

-- A kiszolgáláshoz: kulcsról vissza a sorra. Egyedi, mert egy tárhelykulcs egy
-- képet jelent — a kulcs a forrás-URL tartalomcímzett hasítása.
CREATE UNIQUE INDEX IF NOT EXISTS anime_images_mirror_key_idx
  ON anime_images (mirror_key) WHERE mirror_key IS NOT NULL;
