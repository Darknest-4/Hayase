-- A Discord-bot új funkciói (2026-09-29): szerverenkénti beállítások, DM-értesítés,
-- szerepkör-szinkron, animénként megszólítható rang, moderálás Discordból.
--
-- Minden tábla a guild azonosítójához (szöveg, a Discord snowflake-je) kötött;
-- a YUME-oldali kulcsok (felhasználó, anime, bejelentés) idegen kulccsal, hogy
-- egy törölt fiók, cím vagy bejelentés a Discord-oldali sorát is vigye.

-- ============================================================================
-- Szerverenkénti beállítások — a vezérlőpult Beállítások fülén.
-- ============================================================================
CREATE TABLE IF NOT EXISTS discord_guild_settings (
  guild_id              text        PRIMARY KEY,
  -- A SZERVERRE KIMENŐ üzenetek nyelve (hírfolyam, tartós üzenetek,
  -- moderálás): 'hu' | 'en' | 'auto' (= a Discord-szerver nyelve). Alapból
  -- magyar: a YUME magyar oldal, és egy új szerver alapnyelve a Discordon
  -- akkor is angol, ha a közössége magyar.
  language              text        NOT NULL DEFAULT 'hu' CHECK (language IN ('hu', 'en', 'auto')),
  -- A Discord-szerver nyelve, ahogy a gateway utoljára látta (GUILD_CREATE).
  preferred_locale      text,
  -- Az új epizódok hírfolyamának szűrői: üres = minden műfaj; igaz = csak az
  -- aktuális szezon címei.
  feed_genres           text[]      NOT NULL DEFAULT '{}',
  feed_current_season   boolean     NOT NULL DEFAULT false,
  -- Hova menjenek a YUME-bejelentések (moderálás). NULL = ki van kapcsolva.
  -- A csatornának PRIVÁTNAK kell lennie: a bejelentett tartalom részlete
  -- kerül bele.
  moderation_channel_id text,
  -- Az összekötött YUME-fiókú tagok rangja. NULL = nincs.
  linked_role_id        text,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- YUME-szerepkör → Discord-rang. A felsorolt Discord-rangokat a bot KEZELI:
-- aki a YUME-ban nem birtokolja a szerepkört, annak a rangot leveszi.
CREATE TABLE IF NOT EXISTS discord_role_mappings (
  guild_id        text NOT NULL,
  yume_role_slug  text NOT NULL REFERENCES roles(slug) ON DELETE CASCADE ON UPDATE CASCADE,
  discord_role_id text NOT NULL,
  PRIMARY KEY (guild_id, yume_role_slug)
);

-- A szinkron nyilvántartása: kinek, mikor, mivel. Aki kikerül az
-- összekötöttek közül, annak a kezelt rangjait innen tudjuk levenni.
CREATE TABLE IF NOT EXISTS discord_role_sync (
  guild_id        text        NOT NULL,
  discord_user_id text        NOT NULL,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  error           text,
  PRIMARY KEY (guild_id, discord_user_id)
);

-- Animénként megszólítható rang a hírfolyamban: az új rész bejelentése ezt a
-- rangot említi (és csak ezt — semmi mást).
CREATE TABLE IF NOT EXISTS discord_anime_mentions (
  guild_id        text NOT NULL,
  anime_id        uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  discord_role_id text NOT NULL,
  PRIMARY KEY (guild_id, anime_id)
);

-- ============================================================================
-- Személyes értesítés DM-ben — a felhasználó kapcsolja be a főoldalon.
-- ============================================================================
ALTER TABLE discord_links
  ADD COLUMN IF NOT EXISTS dm_new_episodes boolean NOT NULL DEFAULT false,
  -- Mikor kapcsolta be: csak az UTÁNA megjelent részekről szólunk — a
  -- bekapcsolás ne zúdítsa rá az elmúlt két nap összes részét.
  ADD COLUMN IF NOT EXISTS dm_enabled_at   timestamptz,
  -- Egymás utáni sikertelen kézbesítések. Háromnál a kapcsoló magától
  -- kikapcsol (a tag letiltotta a DM-et) — nem próbálkozunk a végtelenségig.
  ADD COLUMN IF NOT EXISTS dm_failures     integer NOT NULL DEFAULT 0;

-- Epizódonként egy DM felhasználónként: az elsődleges kulcs a deduplikáció.
CREATE TABLE IF NOT EXISTS discord_dm_deliveries (
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  episode_id uuid        NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  error      text,
  PRIMARY KEY (user_id, episode_id)
);

-- ============================================================================
-- Belépés Discorddal — csak már összekötött fiókba.
-- ============================================================================
-- Az állapot EGYSZER használható, lejár, és a kezdeményező BÖNGÉSZŐHÖZ kötött:
-- a `nonce_hash` egy HttpOnly süti hash-e. Enélkül egy támadó a saját Discord-
-- belépésének visszahívási címét nyittathatná meg az áldozattal, és az
-- áldozat a támadó fiókjába lépne be (login CSRF). Nyersen egyiket sem
-- tároljuk.
CREATE TABLE IF NOT EXISTS discord_login_states (
  state_hash  text        PRIMARY KEY,
  nonce_hash  text        NOT NULL,
  expires_at  timestamptz NOT NULL
);

-- ============================================================================
-- Moderálás Discordból — a bejelentések a moderátori csatornában.
-- ============================================================================
CREATE TABLE IF NOT EXISTS discord_moderation_messages (
  report_id     uuid        NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  guild_id      text        NOT NULL,
  channel_id    text        NOT NULL,
  message_id    text,
  error         text,
  posted_at     timestamptz NOT NULL DEFAULT now(),
  -- A bejelentés állapota, amit a Discord-üzenet utoljára mutatott: ha a
  -- YUME-ban (az adminfelületen) közben lezárták, az üzenet frissül.
  shown_status  text        NOT NULL DEFAULT 'open',
  PRIMARY KEY (report_id, guild_id)
);
