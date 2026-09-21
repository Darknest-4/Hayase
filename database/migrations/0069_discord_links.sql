-- ============================================================================
-- 0069 — YUME-fiók ↔ Discord-fiók összerendelés, és a guild-tagság gyorsítótára
-- ============================================================================
-- MIÉRT KELL. A vezérlőpulton egy szerver adminja csak a SAJÁT guildjét
-- láthatja. Ehhez tudni kell, hogy a bejelentkezett YUME-felhasználó melyik
-- Discord-fiók, és annak milyen jogai vannak abban a guildben.
--
-- A YUME-FIÓK AZ ELSŐDLEGES IDENTITÁS (7.1. pont). A Discord-fiók ehhez
-- KAPCSOLÓDIK, nem helyettesíti: a bejelentkezés a meglévő YUME
-- session-rendszeren megy, ez a tábla csak a hozzárendelést tartja.
--
-- A DISCORD USER ID AZ AZONOSÍTÓ, NEM A FELHASZNÁLÓNÉV. A Discord
-- felhasználóneve megváltoztatható; az azonosító nem. Egy névre épülő
-- összerendelés a következő névváltásnál idegen fiókot engedne be.
-- ============================================================================

CREATE TABLE IF NOT EXISTS discord_links (
  user_id          uuid        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Snowflake, szövegként: 64 bites egész, a JSON-szám nem bírja el.
  discord_user_id  text        NOT NULL,
  -- Megjelenítéshez. NEM azonosításra — lásd fent.
  discord_username text,
  linked_at        timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- EGY DISCORD-FIÓK EGY YUME-FIÓKHOZ. Enélkül két YUME-fiók ugyanarra a
-- Discord-azonosítóra hivatkozhatna, és a jogosultság-ellenőrzés
-- megkerülhető lenne egy második fiók létrehozásával.
CREATE UNIQUE INDEX IF NOT EXISTS discord_links_discord_user_uniq
  ON discord_links (discord_user_id);

-- ============================================================================
-- A guild-tagság GYORSÍTÓTÁRA — és a hangsúly a gyorsítótáron van.
-- ============================================================================
-- A 7.2. pont kimondja: „Ne támaszkodj kizárólag a korábban elmentett
-- permission adatokra." Ez a tábla ezért nem IGAZSÁGFORRÁS, hanem egy
-- lejáró másolat: a Discord oldalán bármikor elvehetik a jogot, és egy
-- örökre eltárolt „ő admin" sor onnantól hazudik.
--
-- A `fetched_at` alapján a hívó dönti el, elég friss-e; érzékeny műveletnél
-- friss lekérdezés kell.
CREATE TABLE IF NOT EXISTS discord_guild_members (
  discord_user_id text        NOT NULL,
  guild_id        text        NOT NULL,
  guild_name      text,
  owner           boolean     NOT NULL DEFAULT false,
  -- A jogosultsági bitmező SZÖVEGKÉNT: 64 bites, és a `bigint` a kliens felé
  -- úgyis sztringgé válna. Így sehol nem kell visszaalakítani.
  permissions     text        NOT NULL DEFAULT '0',
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (discord_user_id, guild_id)
);

CREATE INDEX IF NOT EXISTS discord_guild_members_guild_idx
  ON discord_guild_members (guild_id);
