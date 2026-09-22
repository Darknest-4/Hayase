-- ============================================================================
-- 0070 — `discord.manage` jogosultság
-- ============================================================================
-- MIÉRT SAJÁT JOGOSULTSÁG. A Discord vezérlőpulton kétféle úton lehet bejutni
-- egy guildhez: a Discord saját guild-jogosultságával (a összekötött fiókon
-- át), vagy az OLDAL ÜZEMELTETŐJEKÉNT. A második út ez.
--
-- A kettő nem ugyanaz, és nem is helyettesíti egymást: egy szerver
-- tulajdonosa a saját guildjét kezelheti anélkül, hogy a YUME-ban bármilyen
-- adminisztrátori joga lenne — és fordítva, az oldal üzemeltetőjének nem kell
-- Discord-fiókot kötnie ahhoz, hogy hibát keressen.
--
-- A `roles.ts` invariánsa szerint az `admin` szerep MINDEN jogosultságot
-- birtokol, ezért a kiosztás is itt van.
-- ============================================================================

INSERT INTO permissions (slug, "group", description, status) VALUES
  ('discord.manage', 'system',
   'A Discord vezérlőpult és a tartós üzenetek kezelése minden guildben', 'active')
ON CONFLICT (slug) DO UPDATE SET status = 'active', description = excluded.description;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.slug = 'admin' AND p.slug = 'discord.manage'
ON CONFLICT DO NOTHING;
