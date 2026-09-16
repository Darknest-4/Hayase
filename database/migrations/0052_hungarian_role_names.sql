-- ============================================================================
-- 0052 — a szerepkörök neve magyarul
-- ============================================================================
-- A `roles.name` és `.description` operátornak szóló szöveg: a Szerepkörök
-- képernyőn ez áll a rál oszlopában, és ez kerül a felhasználó lapjára is,
-- amikor szerepkört adsz vagy veszel el. Egy magyar panelen hat angol
-- szerepkörnév azt jelenti, hogy a legfontosabb fogalom — ki mit csinálhat —
-- az egyetlen, amit nem fordítottunk le.
--
-- A `slug` NEM változik: az a kód és a jogosultságellenőrzés kulcsa
-- (`requirePermission`, `user_roles`, a vetőszkriptek), és egy lefordított
-- kulcs az a fajta változtatás, ami hónapokkal később egy jogosultsági
-- ellenőrzésben bukik ki.
--
-- A „developer" szerepkör a bővítményplatformhoz tartozott, amit a 0031
-- migráció eltávolított. A nevét a mai állapotához igazítjuk, ahelyett hogy
-- egy nem létező boltra hivatkozna.

UPDATE roles SET name = 'Adminisztrátor',    description = 'Teljes hozzáférés a platform minden beállításához' WHERE slug = 'admin';
UPDATE roles SET name = 'Elemző',            description = 'Kimutatások megtekintése és exportálása'          WHERE slug = 'analyst';
UPDATE roles SET name = 'Fejlesztő',         description = 'Fejlesztői hozzáférés; ma nincs hozzá saját felület' WHERE slug = 'developer';
UPDATE roles SET name = 'Katalóguskezelő',   description = 'A katalógus és a videóforrások kezelése'           WHERE slug = 'editor';
UPDATE roles SET name = 'Moderátor',         description = 'Közösségi moderálás: bejelentések, hozzászólások'  WHERE slug = 'moderator';
UPDATE roles SET name = 'Felhasználó',       description = 'Minden regisztrált fiók alapértelmezett szerepköre' WHERE slug = 'user';
