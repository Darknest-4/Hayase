-- ============================================================================
-- 0046 — a kapcsolók neve is magyarul, mert magyar felületen látszanak
-- ============================================================================
-- A `feature_flags` sorainak `label` és `description` mezője az adminfelület
-- Beállítások képernyőjén jelenik meg, egyenként egy kapcsoló mellett. A
-- felület időközben magyar lett, ezek viszont angolul maradtak — és épp ezek
-- mondják meg, mit kapcsol ki az ember.
--
-- A `key` nem változik: azt a kód olvassa (`page.home`, `feature.comments`),
-- és a panel ki is írja a név alá, hogy egy hibajelentésben hivatkozni
-- lehessen rá.
--
-- Nem seed: ezek a sorok élnek, és az üzemeltető átírhatja őket a panelen.
-- Ezért `UPDATE`, kulcs szerint, és csak azokon, amiket még nem írtak át
-- kézzel — aki magyarra cserélte a sajátját, annak a szövege marad.

UPDATE feature_flags SET label = 'Fórum',            description = 'Beszélgetőtáblák, amiket bárki nyithat'                    WHERE key = 'feature.forum'          AND label = 'Forum';
UPDATE feature_flags SET label = 'Élő csevegés',     description = 'Nyilvános csevegőszobák'                                    WHERE key = 'feature.chat'           AND label = 'Live chat';
UPDATE feature_flags SET label = 'Hozzászólások',    description = 'Hozzászólások animékhez, epizódokhoz és klipekhez'          WHERE key = 'feature.comments'       AND label = 'Comments';
UPDATE feature_flags SET label = 'Közös nézés',      description = 'A közös nézés ablak a lejátszón'                            WHERE key = 'feature.watch_together' AND label = 'Watch Together';
UPDATE feature_flags SET label = 'Képkeresés',       description = 'Anime keresése egy videókocka alapján (trace.moe)'          WHERE key = 'feature.image_search'   AND label = 'Image search';
UPDATE feature_flags SET label = 'Előzetesek',       description = 'Előzetes lejátszása (kiemelés, gyorsnézet, ablak)'          WHERE key = 'feature.trailers'       AND label = 'Trailers';
UPDATE feature_flags SET label = 'Gyorsnézet',       description = 'A kártyák fölé húzva megjelenő panel'                       WHERE key = 'feature.hover_preview'  AND label = 'Hover previews';

UPDATE feature_flags SET label = 'Fejlesztési napló', description = 'Mi készült el, és mi jön'                                  WHERE key = 'page.changelog'         AND label = 'Development log';
UPDATE feature_flags SET label = 'Főoldal',           description = 'Kezdőlap kiemeléssel és sorokkal'                          WHERE key = 'page.home'              AND label = 'Home';
UPDATE feature_flags SET label = 'Áttekintés',        description = 'Testreszabható widgetes áttekintő'                         WHERE key = 'page.dashboard'         AND label = 'Dashboard';
UPDATE feature_flags SET label = 'Keresés',           description = 'Teljes szöveges és képi keresés'                           WHERE key = 'page.search'            AND label = 'Search';
UPDATE feature_flags SET label = 'Menetrend',         description = 'Heti adásrend'                                             WHERE key = 'page.schedule'          AND label = 'Schedule';
UPDATE feature_flags SET label = 'Közös nézés',       description = 'Szinkronizált nézőszobák'                                  WHERE key = 'page.w2g'               AND label = 'Watch Together';
UPDATE feature_flags SET label = 'Közösség',          description = 'Élő beszélgetésfolyam'                                     WHERE key = 'page.community'         AND label = 'Community';
UPDATE feature_flags SET label = 'Könyvtár',          description = 'Személyes animekönyvtár'                                   WHERE key = 'page.list'              AND label = 'Library';
UPDATE feature_flags SET label = 'Értesítések',       description = 'Értesítési lista'                                          WHERE key = 'page.notifications'     AND label = 'Notifications';
UPDATE feature_flags SET label = 'Profil',            description = 'Profil (statisztika, elemzés, eredmények, előzmények)'     WHERE key = 'page.profile'           AND label = 'Profile';
UPDATE feature_flags SET label = 'Beállítások',       description = 'A kliens beállításai'                                      WHERE key = 'page.settings'          AND label = 'Settings';
UPDATE feature_flags SET label = 'Admin',             description = 'Adminisztrációs felület'                                   WHERE key = 'page.admin'             AND label = 'Admin';
UPDATE feature_flags SET label = 'Anime adatlap',     description = 'Az animék részletoldala'                                   WHERE key = 'page.anime'             AND label = 'Anime detail';
UPDATE feature_flags SET label = 'Lejátszó',          description = 'A videólejátszó oldalai'                                   WHERE key = 'page.watch'             AND label = 'Watch';
