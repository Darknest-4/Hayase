-- A Discord-vezérlőpult nem nyilvános: belépni csak külön jogosultsággal lehet.
--
-- EDDIG KÉT ÚT VEZETETT BE: a YUME `discord.manage` jogosultsága (az
-- üzemeltető, minden szerverhez), VAGY a Discordon meglévő „Szerver kezelése"
-- jog egy összekötött fiókon át — YUME-jogosultság nélkül. Az utóbbi azt
-- jelentette, hogy bárki, aki bármelyik, a botot használó szerveren admin,
-- belépett a vezérlőpultba. A tulajdonos kérésére (2026-09-29) ez megszűnik:
-- a belépéshez a `discord.dashboard` YUME-jogosultság kell. A szerverenkénti
-- jog ezután is számít — aki bejutott, az továbbra is csak azokat a
-- szervereket kezelheti, amelyekhez a Discordon joga van (vagy mindet, ha
-- `discord.manage`-e van).
--
-- Aki ma a `discord.manage`-et birtokolja, megkapja az újat is: az üzemeltető
-- nem zárhatja ki magát egy frissítéssel.

INSERT INTO permissions (slug, description, "group", status)
VALUES ('discord.dashboard',
        'Belépés a Discord-vezérlőpultba. A szerverenkénti jogot ezen felül is ellenőrzi: a Discordon „Szerver kezelése" jog kell, vagy a discord.manage.',
        'system', 'active')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, (SELECT id FROM permissions WHERE slug = 'discord.dashboard')
  FROM role_permissions rp
  JOIN permissions p ON p.id = rp.permission_id
 WHERE p.slug = 'discord.manage'
ON CONFLICT DO NOTHING;

-- A FIÓK-ÖSSZEKÖTÉS a főoldalról is indulhat, nem csak a vezérlőpultról. A
-- Discord mindig ugyanarra a visszahívási címre hoz vissza; hogy onnan hová
-- menjen tovább, azt a kiszolgáló a SAJÁT, induláskor eltárolt értékéből
-- tudja — zárt listából, nem a címsorból (az nyitott átirányítás volna).
ALTER TABLE discord_oauth_states
  ADD COLUMN IF NOT EXISTS return_to text NOT NULL DEFAULT 'dashboard'
    CHECK (return_to IN ('dashboard', 'site'));
