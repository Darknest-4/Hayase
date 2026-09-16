-- ============================================================================
-- 0047 — a jogosultságok leírása magyarul, ahol ma tényleg jogosultság
-- ============================================================================
-- A Szerepkörök képernyőn ezek a mondatok mondják meg, mit ad az ember annak,
-- akire rábízza a szerepkört. Angolul álltak egy magyar felületen, pontosan
-- ott, ahol egy félreolvasás jogosultságot ad valakinek, akinek nem kellene.
--
-- Csak a 36 érvényesített sor. A tábla 363-at tart nyilván, de 327 „planned":
-- olyan modulokhoz katalogizálva, amik még nem léteznek. Lefordítani több száz
-- mondatot egy nem létező funkcióról nem munka, hanem szöveg — és amikor egy
-- modul elkészül, a hozzá tartozó sor úgyis átkerül `active`-ba, és akkor kap
-- magyar leírást. A panel amúgy is külön jelzi a kettőt („Ma már útvonal
-- érvényesíti" / „Egy későbbi modulhoz katalogizálva").
--
-- A `slug` nem változik: azt a kód ellenőrzi (`requirePermission('anime.edit')`),
-- és a panel ki is írja a leírás mellé.
--
-- `WHERE status = 'active'` a feltétel része, nem csak szűrő: ha egy sor időközben
-- visszakerült tervezettbe, nem írjuk felül a szövegét.

UPDATE permissions SET description = 'Platform-statisztikák megtekintése'                                                                     WHERE slug = 'admin.analytics.view'    AND status = 'active';
UPDATE permissions SET description = 'Felhasználók megtekintése, felfüggesztése és kitiltása'                                                 WHERE slug = 'admin.users.manage'      AND status = 'active';
UPDATE permissions SET description = 'Kimenő webhookok létrehozása és beállítása'                                                             WHERE slug = 'admin.webhooks.manage'   AND status = 'active';
UPDATE permissions SET description = 'Az egész oldalra szóló hírek írása és kiadása'                                                          WHERE slug = 'announcement.manage'     AND status = 'active';
UPDATE permissions SET description = 'Fejlesztési napló bejegyzéseinek írása és kiadása'                                                      WHERE slug = 'changelog.manage'        AND status = 'active';

UPDATE permissions SET description = 'Anime metaadatainak szerkesztése'                                                                       WHERE slug = 'anime.edit'              AND status = 'active';
UPDATE permissions SET description = 'Anime létrehozása'                                                                                      WHERE slug = 'anime.create'            AND status = 'active';
UPDATE permissions SET description = 'Anime törlése'                                                                                          WHERE slug = 'anime.delete'            AND status = 'active';
UPDATE permissions SET description = 'Duplikált anime-bejegyzések összevonása'                                                                WHERE slug = 'anime.merge'             AND status = 'active';
UPDATE permissions SET description = 'Anime megtekintése (a rejtetteket is)'                                                                  WHERE slug = 'anime.view'              AND status = 'active';
UPDATE permissions SET description = 'Epizód létrehozása'                                                                                     WHERE slug = 'episode.create'          AND status = 'active';
UPDATE permissions SET description = 'Epizód törlése'                                                                                         WHERE slug = 'episode.delete'          AND status = 'active';
UPDATE permissions SET description = 'Epizód adatainak szerkesztése, publikálása és forrásai'                                                 WHERE slug = 'episode.edit'            AND status = 'active';

UPDATE permissions SET description = 'Csevegés moderálása'                                                                                    WHERE slug = 'chat.moderate'           AND status = 'active';
UPDATE permissions SET description = 'Tartalom elrejtése és törlése, bejelentések elbírálása'                                                 WHERE slug = 'community.moderate'      AND status = 'active';
UPDATE permissions SET description = 'Bejegyzések, témák és hozzászólások írása'                                                              WHERE slug = 'community.post'          AND status = 'active';
UPDATE permissions SET description = 'Fórum létrehozása'                                                                                      WHERE slug = 'forum.create'            AND status = 'active';
UPDATE permissions SET description = 'Fórum törlése'                                                                                          WHERE slug = 'forum.delete'            AND status = 'active';
UPDATE permissions SET description = 'Fórum szerkesztése'                                                                                     WHERE slug = 'forum.edit'              AND status = 'active';
UPDATE permissions SET description = 'Bejegyzés írása'                                                                                        WHERE slug = 'post.create'             AND status = 'active';
UPDATE permissions SET description = 'Bejegyzés törlése'                                                                                      WHERE slug = 'post.delete'             AND status = 'active';
UPDATE permissions SET description = 'Bejegyzés szerkesztése'                                                                                 WHERE slug = 'post.edit'               AND status = 'active';
UPDATE permissions SET description = 'Bejegyzés elrejtése'                                                                                    WHERE slug = 'post.hide'               AND status = 'active';
UPDATE permissions SET description = 'Téma (fórumtéma) létrehozása'                                                                           WHERE slug = 'topic.create'            AND status = 'active';
UPDATE permissions SET description = 'Téma törlése'                                                                                           WHERE slug = 'topic.delete'            AND status = 'active';
UPDATE permissions SET description = 'Téma lezárása'                                                                                          WHERE slug = 'topic.lock'              AND status = 'active';
UPDATE permissions SET description = 'Téma kitűzése'                                                                                          WHERE slug = 'topic.pin'               AND status = 'active';

UPDATE permissions SET description = 'Színtémák kiadása a látogatóknak'                                                                       WHERE slug = 'theme.publish'           AND status = 'active';

UPDATE permissions SET description = 'A vészkapcsolók használata: csak olvasható mód, külső szinkron, kimenő webhookok, minden munkamenet érvénytelenítése' WHERE slug = 'security.manage' AND status = 'active';

UPDATE permissions SET description = 'A kódaudit jelentésének olvasása: észrevételek, súlyosságok, és hogy melyik fájlra mutatnak'            WHERE slug = 'audit.read'              AND status = 'active';
UPDATE permissions SET description = 'Szerepkör kiosztása'                                                                                    WHERE slug = 'role.assign'             AND status = 'active';
UPDATE permissions SET description = 'Szerepkörök kiosztása és a jogosultságaik szerkesztése'                                                 WHERE slug = 'roles.manage'            AND status = 'active';
UPDATE permissions SET description = 'Rendszerbeállítások módosítása'                                                                         WHERE slug = 'settings.system'         AND status = 'active';
UPDATE permissions SET description = 'Kontrollált kiszolgáló-diagnosztikák futtatása'                                                         WHERE slug = 'system.diagnostics.run'  AND status = 'active';
UPDATE permissions SET description = 'A kiszolgáló állapotának és mérőszámainak megtekintése'                                                 WHERE slug = 'system.metrics.view'     AND status = 'active';

UPDATE permissions SET description = 'Munkamenet érvénytelenítése'                                                                            WHERE slug = 'session.revoke'          AND status = 'active';
