-- ============================================================================
-- 0071 — Discord OAuth: CSRF-állapotok
-- ============================================================================
-- MIÉRT KELL A `state`. Enélkül egy támadó a SAJÁT Discord-fiókjának
-- engedélyezési kódjával nyithatná meg az áldozat visszairányítási címét — és
-- onnantól az áldozat YUME-fiókjához a TÁMADÓ Discord-fiókja lenne kötve.
-- Az áldozat a saját guildjeit látná, de a támadó nevében.
--
-- NEM NYERSEN TÁROLJUK. A `state` hash-e kerül ide: egy adatbázis-kiolvasás
-- így sem ad használható kulcsot. Ugyanaz az elv, mint a jelszavaknál.
--
-- A SOR EGYSZER HASZNÁLHATÓ: a beváltás `DELETE … RETURNING`, egyetlen
-- utasításban. Egy „megnézem, majd törlöm" minta versenyben kétszer is
-- beváltható kódot adna.
-- ============================================================================

CREATE TABLE IF NOT EXISTS discord_oauth_states (
  state_hash  text        PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A takarításhoz: a lejárt sorok kiválasztása.
CREATE INDEX IF NOT EXISTS discord_oauth_states_expires_idx
  ON discord_oauth_states (expires_at);

-- Egy felhasználónak több nyitott folyamata is lehet (két fül), de a régieket
-- érdemes látni — ezért nincs egyedi megszorítás a `user_id`-n.
CREATE INDEX IF NOT EXISTS discord_oauth_states_user_idx
  ON discord_oauth_states (user_id);
