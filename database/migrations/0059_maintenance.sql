-- Karbantartási mód.
--
-- KÉT TÁBLA, és egy tudatos hiány.
--
-- A hiány: a leírás 6. pontja kér egy `maintenance_events` táblát az
-- auditáláshoz. Nem készül el. Az `audit_logs` particionált, indexelt, van
-- benne `actor_id`, `before`, `after`, `ip` és `created_at` — pontosan az,
-- amit az a pont felsorol —, és ma is ezt használja a biztonsági beállítások
-- és az alapítói könyvtár minden módosítása. Egy második, majdnem ugyanolyan
-- tábla párhuzamos rendszer lenne, amit a 3. pont kifejezetten tilt.
--
-- A karbantartás eseményei tehát ide mennek:
--   subject_type = 'maintenance', action = 'maintenance.activated' stb.

-- ---------------------------------------------------------------------------
-- A beállítás — VERZIÓZVA, nem felülírva
-- ---------------------------------------------------------------------------
--
-- Minden módosítás ÚJ SOR. Nem azért, hogy szép legyen: egy karbantartás
-- utólag mindig kérdés lesz („mikor kapcsoltuk be, ki, és mit mondtunk a
-- látogatóknak"), és egy felülírt sor erre nem tud válaszolni. A verziószám
-- egyben a gyorsítótár azonosítója is: a példányok ebből tudják, hogy amit
-- tartanak, az a legfrissebb-e.
CREATE TABLE IF NOT EXISTS maintenance_configs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version                bigint GENERATED ALWAYS AS IDENTITY,

  -- A SZÁNDÉK. Hogy ebből mi az érvényes MOST, azt az időablak dönti el
  -- futásidőben — lásd `modules/maintenance/schedule.ts`.
  mode                   text NOT NULL DEFAULT 'OFF',
  scope                  text NOT NULL DEFAULT 'global',
  enabled                boolean NOT NULL DEFAULT false,

  -- ABSZOLÚT PILLANATOK. A `timezone` mező kizárólag megjelenítésre való: így
  -- a nyári időszámítás nem tud elrontani egy határidőt.
  starts_at              timestamptz,
  ends_at                timestamptz,
  estimated_end_at       timestamptz,
  timezone               text NOT NULL DEFAULT 'Europe/Budapest',

  -- Amit a látogató lát. Nem tartalmazhat belső részletet — a szabályt a
  -- kiszolgáló oldalán is betartatjuk.
  title                  text NOT NULL DEFAULT '',
  public_message         text NOT NULL DEFAULT '',

  -- Kiürítés: a bent lévők kapnak-e még időt, és mennyit.
  allow_existing_sessions boolean NOT NULL DEFAULT false,
  drain_seconds          integer NOT NULL DEFAULT 0,

  -- Ki mehet be. Szabad alakú, hogy a szabályzat bővülhessen anélkül, hogy a
  -- séma változna — a kiértékelése a `policy.ts` dolga.
  bypass_policy          jsonb NOT NULL DEFAULT '{}'::jsonb,

  metadata               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT maintenance_mode_known CHECK (
    mode IN ('OFF', 'SCHEDULED', 'ACTIVE', 'DEGRADED', 'READ_ONLY', 'EMERGENCY')),
  CONSTRAINT maintenance_drain_sane CHECK (drain_seconds >= 0 AND drain_seconds <= 3600),
  -- Egy ablak, aminek a vége a kezdete előtt van, nem ablak. Adatbázisszinten
  -- fogjuk meg, mert a felület megkerülhető, a tábla nem.
  CONSTRAINT maintenance_window_ordered CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

-- A LEGFRISSEBB SOR az érvényes. Ez az index teszi olcsóvá a megtalálását —
-- ez a lekérdezés indulásonként és értesítésenként fut, nem kérésenként.
CREATE INDEX IF NOT EXISTS maintenance_configs_version_idx
  ON maintenance_configs (version DESC);

-- ---------------------------------------------------------------------------
-- Mentességi jegyek
-- ---------------------------------------------------------------------------
--
-- A jegy MAGA NINCS ITT, csak a lenyomata. Ugyanaz az elv, mint a
-- jelszavaknál: aki megszerzi az adatbázist, ne tudjon vele bemenni.
--
-- A `token_hash` a jegy SHA-256 lenyomata. A jegy aláírt, rövid életű, és
-- visszavonható — a visszavonás az, ami miatt egyáltalán tábla kell: egy
-- pusztán aláírt jegyet nem lehet a lejárata előtt érvényteleníteni.
CREATE TABLE IF NOT EXISTS maintenance_bypass_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL UNIQUE,
  label         text NOT NULL DEFAULT '',
  scope         text NOT NULL DEFAULT 'global',
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  use_count     integer NOT NULL DEFAULT 0,

  -- ÖRÖK JEGY NEM LÉTEZIK. A 12. pont kifejezetten kéri; adatbázisszinten
  -- tartatjuk be, mert egy elrontott felület ezt csendben megkerülné.
  CONSTRAINT maintenance_bypass_expires CHECK (expires_at > created_at),
  CONSTRAINT maintenance_bypass_not_eternal CHECK (expires_at <= created_at + interval '24 hours')
);

-- A keresés mindig az élő jegyeket kérdezi: hash szerint, lejárat és
-- visszavonás szűréssel.
CREATE INDEX IF NOT EXISTS maintenance_bypass_live_idx
  ON maintenance_bypass_tokens (token_hash)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Kiinduló sor
-- ---------------------------------------------------------------------------
--
-- KIKAPCSOLVA. Egy üres tábla is „nincs karbantartás"-t jelentene, de akkor a
-- verziószám nullán állna, és a gyorsítótár nem tudná megkülönböztetni a
-- „még nem olvastam" állapotot a „nincs semmi" állapottól.
INSERT INTO maintenance_configs (mode, scope, enabled, title, public_message)
SELECT 'OFF', 'global', false, 'Karbantartás', 'A YUME rövidesen újra elérhető lesz.'
WHERE NOT EXISTS (SELECT 1 FROM maintenance_configs);
