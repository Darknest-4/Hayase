-- ============================================================================
-- 0078 — Új epizód bejelentések
-- ============================================================================
-- MIÉRT KÜLÖN TÁBLA, ÉS MIÉRT NEM A TARTÓS ÜZENET.
--
-- A tartós üzenet EGY üzenetet tart kint, és azt szerkeszti. Az új epizód
-- bejelentése ennek az ellentéte: minden epizód KÜLÖN üzenet, ami kimegy
-- egyszer, és soha többé nem változik. A kettő összekeverése azt jelentené,
-- hogy vagy az epizódok írják felül egymást, vagy a statisztika szaporodik.
--
-- A DEDUPLIKÁCIÓ A KULCSBAN VAN, nem egy előzetes lekérdezésben. Az elsődleges
-- kulcs (guild + epizód) kizárja, hogy ugyanaz az epizód kétszer kimenjen —
-- akkor is, ha két worker egyszerre ébred, és akkor is, ha a feladat
-- újraindul. Egy „megnézem, ment-e már" minta mindkettőnek azt mondaná, hogy
-- nem.
--
-- A KÜLDÉS ELŐTT FOGLALUNK. A sor a küldés ELŐTT jön létre `message_id`
-- nélkül; ha a Discord-hívás elhasal, a sor `error`-ral marad, és nem
-- próbáljuk újra a végtelenségig. Fordított sorrendben egy elhasalt kiírás
-- után az epizód másodszor is kimenne.
-- ============================================================================

CREATE TABLE IF NOT EXISTS discord_episode_announcements (
  guild_id   text        NOT NULL,
  episode_id uuid        NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  channel_id text        NOT NULL,
  message_id text,
  error      text,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, episode_id)
);

CREATE INDEX IF NOT EXISTS discord_episode_announcements_at_idx
  ON discord_episode_announcements (guild_id, at DESC);
