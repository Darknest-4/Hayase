-- ============================================================================
-- 0045 — a nyelvi házirend a példány beállítása, nem a néző ízlése
-- ============================================================================
-- Eddig a nyelv kizárólag nézőnkénti preferencia volt: az onboarding
-- megkérdezte, a beállítások átállította, és a példánynak nem volt beleszólása.
-- Egy magyar oldalon, ami magyar közönségre készül, ez fordítva van — az
-- üzemeltető dönti el, mi az alapértelmezés, és azt is, hogy egyáltalán van-e
-- mit választani.
--
-- Két beállítás, mert két külön kérdés:
--
--   default_language   mit kap valaki, aki még nem választott. Eddig a
--                      böngésző nyelvéből tippeltünk, ami egy magyar oldalon
--                      angolt ad egy angol rendszernyelvű magyar látogatónak.
--
--   language_switching  van-e választás egyáltalán. Kikapcsolva az onboarding
--                      nyelvi lépése és a beállítások nyelvválasztója eltűnik,
--                      és minden néző az alapértelmezést kapja. Nem elrejtés:
--                      a kliens a /v1/config-ból tudja meg, tehát az API is
--                      ugyanazt mondja.
--
-- Mindkettő a site_settings JSONB tárolóban, mint a require_login és a
-- registration_open — ugyanaz a gyorsítótárazott olvasó szolgálja ki, tehát a
-- gyakori eset egy map-keresés kérésenként, nem lekérdezés.
--
-- A kezdőérték szándékos: magyar, váltás kikapcsolva. Ez a mostani döntés,
-- nem örök szabály — az admin panelen bármikor átállítható.
-- ============================================================================

INSERT INTO site_settings (key, value)
VALUES ('default_language', '"hu"'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO site_settings (key, value)
VALUES ('language_switching', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;
