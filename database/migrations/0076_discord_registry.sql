-- ============================================================================
-- 0076 — Discord registry, setup-futások, megerősítések, welcome
-- ============================================================================
-- MIÉRT KELL REGISTRY. Egy automatikus setup két dolgot muszáj tudjon: mit
-- hozott létre ŐMAGA, és mit nem. Név alapján ezt eldönteni NEM lehet — egy
-- „📢・bejelentesek" csatornát más is létrehozhatott, és ha a takarítás a
-- nevet nézné, előbb-utóbb idegen tartalmat törölne. A registry a YUME saját
-- nyilvántartása: ami itt nincs benne, azt a rendszer SOHA nem módosítja és
-- nem törli.
--
-- A LOGIKAI KULCS a mi nevünk az objektumra (`channel:uj-epizodok`), a
-- `discord_object_id` pedig az, amit a Discord adott. A kettő közötti
-- leképezés az, amitől a setup IDEMPOTENS: második futáskor a logikai kulcs
-- már megvan, tehát nem hoz létre másodikat.
--
-- SOFT DELETE, mert a történet is válasz. Ha valaki kézzel törölt egy
-- csatornát a Discordban, a sor `deleted_at`-tel megmarad, és a javítás
-- tudja, hogy ez a MI objektumunk volt — nem egy ismeretlen.
-- ============================================================================

CREATE TABLE IF NOT EXISTS discord_registry (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id              text        NOT NULL,
  -- 'category' | 'channel' | 'role' | 'persistent_message'
  object_type           text        NOT NULL
    CHECK (object_type IN ('category', 'channel', 'role', 'persistent_message')),
  -- A MI nevünk az objektumra. Ez a setup-leírásból jön, nem a Discordtól.
  logical_key           text        NOT NULL,
  -- Amit a Discord adott. NULL, amíg nem hoztuk létre.
  discord_object_id     text,
  -- Kategória-csatorna kapcsolat: a szülő LOGIKAI kulcsa, nem a Discord-azonosítója.
  parent_key            text,
  -- Kezeli-e a YUME. Mindig igaz az itteni sorokra; oszlopként azért van,
  -- mert a lekérdezések így olvashatók.
  managed_by_yume       boolean     NOT NULL DEFAULT true,
  /*
   * MI HOZTUK LÉTRE, VAGY CSAK ÖRÖKBE FOGADTUK?
   *
   * EZ A KÜLÖNBSÉG DÖNTI EL, MIT SZABAD TÖRÖLNI. Ha a setup egy már létező,
   * azonos nevű csatornát talál, nem hoz létre másodikat — hanem attól
   * kezdve azt kezeli (`created_by_yume = false`). Ez kényelmes, és
   * biztonságos is, amíg a takarítás tudja, hogy azt a csatornát NEM Ő
   * csinálta: a factory reset kizárólag a `true` sorokat törli.
   *
   * Enélkül egy örökbe fogadott, évek óta használt `#altalanos` a
   * „gyári visszaállítás" gombra eltűnne a tartalmával együtt.
   */
  created_by_yume       boolean     NOT NULL DEFAULT true,
  -- Melyik setup-leírás hozta létre. Ebből derül ki, mit kell javítani.
  configuration_version int         NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);

/*
 * KÉT EGYEDI INDEX, MINDKETTŐ RÉSZLEGES.
 *
 * Az első: egy guildben egy logikai kulcs egyszer szerepelhet ÉLŐ sorként.
 * Ez az, ami a duplikált csatornát/rangot kizárja — nem egy előzetes
 * lekérdezés, amit két egyidejű setup mindkettőnek „nincs még"-gyel
 * válaszolna meg.
 *
 * A második: egy Discord-objektum egyszer szerepelhet. Enélkül két logikai
 * kulcs ugyanarra az objektumra mutathatna, és a törlés kétszer próbálná.
 */
CREATE UNIQUE INDEX IF NOT EXISTS discord_registry_logical_uniq
  ON discord_registry (guild_id, object_type, logical_key)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS discord_registry_object_uniq
  ON discord_registry (guild_id, discord_object_id)
  WHERE deleted_at IS NULL AND discord_object_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS discord_registry_guild_idx
  ON discord_registry (guild_id, object_type) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- A registry TÖRTÉNETE. Ki, mit, mikor, miért.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discord_registry_events (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id          text        NOT NULL,
  object_type       text        NOT NULL,
  logical_key       text        NOT NULL,
  discord_object_id text,
  -- 'created' | 'reused' | 'updated' | 'deleted' | 'orphaned' | 'failed' | 'skipped'
  action            text        NOT NULL,
  detail            text,
  -- Ki indította. NULL, ha a rendszer magától (ütemezett javítás).
  actor_id          uuid        REFERENCES users(id) ON DELETE SET NULL,
  run_id            bigint,
  at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discord_registry_events_guild_idx
  ON discord_registry_events (guild_id, at DESC);

-- ---------------------------------------------------------------------------
-- A SETUP FUTÁSAI. Egy futás egy sor, a részletek a `summary`-ban.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discord_setup_runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id    text        NOT NULL,
  -- 'preview' | 'setup' | 'repair' | 'safe_reset' | 'factory_reset'
  mode        text        NOT NULL
    CHECK (mode IN ('preview', 'setup', 'repair', 'safe_reset', 'factory_reset')),
  -- 'running' | 'ok' | 'partial' | 'failed'
  --
  -- A `partial` KÜLÖN ÁLLAPOT, és ez a lényeg: egy setup, amiből egy lépés
  -- nem sikerült, NEM sikeres. A felület ezt pontosan kiírja.
  status      text        NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  actor_id    uuid        REFERENCES users(id) ON DELETE SET NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  summary     jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS discord_setup_runs_guild_idx
  ON discord_setup_runs (guild_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- MEGERŐSÍTŐ JEGYEK — a factory resethez.
-- ---------------------------------------------------------------------------
-- MIÉRT SZERVEROLDALI JEGY. Egy „biztos?" kérdés a felületen semmit nem
-- akadályoz meg: a törlő kérést egy script ugyanúgy elküldheti. A jegyet a
-- kiszolgáló adja ki, ahhoz a guildhez, ahhoz a felhasználóhoz, arra az
-- EGY műveletre, rövid lejárattal és egyszeri felhasználással.
--
-- A `payload_hash` azt köti meg, hogy amit megerősítettek, az ugyanaz, mint
-- amit végrehajtanak: ha az előnézet óta változott a törlendők listája, a
-- jegy nem érvényes.
CREATE TABLE IF NOT EXISTS discord_confirmations (
  token_hash   text        PRIMARY KEY,
  guild_id     text        NOT NULL,
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action       text        NOT NULL,
  payload_hash text        NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discord_confirmations_expiry_idx
  ON discord_confirmations (expires_at);

-- ---------------------------------------------------------------------------
-- WELCOME — beállítás és kézbesítési napló.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discord_welcome_config (
  guild_id     text        PRIMARY KEY,
  enabled      boolean     NOT NULL DEFAULT false,
  channel_id   text,
  -- A sablon szövege. A változókat (`{user}`, `{server_name}`, …) a
  -- `welcome.ts` zárt listája engedi; ismeretlen változó hibát ad, nem
  -- kerül ki nyersen.
  template     text        NOT NULL DEFAULT '',
  -- A hozzárendelendő rang LOGIKAI kulcsa (pl. `role:verified`), nem
  -- Discord-azonosító: a rang újralétrehozáskor új azonosítót kap, a
  -- logikai kulcs viszont marad.
  role_key     text,
  dm_enabled   boolean     NOT NULL DEFAULT false,
  mention      boolean     NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- A DUPLIKÁCIÓVÉDELEM. A gateway ugyanazt az eseményt újracsatlakozás után
-- megismételheti; egy tag EGYSZER kapjon köszöntőt.
CREATE TABLE IF NOT EXISTS discord_welcome_log (
  guild_id        text        NOT NULL,
  discord_user_id text        NOT NULL,
  -- 'sent' | 'skipped' | 'failed' | 'test'
  outcome         text        NOT NULL,
  detail          text,
  at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, discord_user_id, at)
);

CREATE INDEX IF NOT EXISTS discord_welcome_log_guild_idx
  ON discord_welcome_log (guild_id, at DESC);
