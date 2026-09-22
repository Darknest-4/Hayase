-- ============================================================================
-- 0074 — Discord Gateway: állapot és összesítők
-- ============================================================================
-- MIÉRT KELL GATEWAY EGYÁLTALÁN. A Discord REST-en lekérdezhető, hogy MI VAN
-- MOST: hány tag, milyen csatornák, milyen szerepkörök. Azt, hogy MI TÖRTÉNT,
-- nem: az üzenetek, a csatlakozások és a kilépések ESEMÉNYEK, amiket a
-- Discord akkor küld el, amikor megtörténnek, és visszamenőleg NEM
-- kérdezhetők le. Ami nem volt begyűjtve, az nem létezik — és kitalálni
-- tilos.
--
-- AMI INTENT NÉLKÜL IS MEGY. A bot alap (nem privilegizált) intentjeivel
-- megkapjuk a `GUILD_CREATE`-et (benne a taglétszámmal) és a
-- `MESSAGE_CREATE`-et. Az ÜZENET TARTALMÁHOZ kellene a `MESSAGE_CONTENT`
-- intent — de mi csak SZÁMOLUNK, tartalmat nem nézünk, tehát nem kérjük.
--
-- AMIHEZ PRIVILEGIZÁLT INTENT KELL: a csatlakozás és a kilépés eseménye
-- (`GUILD_MEMBERS`). Ezt a fejlesztői portálon kell engedélyezni. Amíg
-- nincs, a taglétszám NAPI PILLANATKÉPBŐL áll elő — abból a növekedés
-- látszik, a mozgás nem. A felület ezt ki is írja.
--
-- SEMMILYEN SZEMÉLYES ADATOT NEM TÁROLUNK. Nincs üzenetszöveg, nincs
-- szerzőazonosító, nincs jelenlét. Csak darabszámok, csatornánként és
-- naponként. Egy statisztikához ennyi kell, és aki egy Discord-szerver
-- statisztikájáért cserébe a tagok üzeneteit gyűjti, az nem statisztikát
-- épít.
-- ============================================================================

-- A kapcsolat állapota. EGY SOR, mert egy gateway-kapcsolat van.
CREATE TABLE IF NOT EXISTS discord_gateway_state (
  id              int         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- 'disconnected' | 'connecting' | 'ready' | 'resuming' | 'failed'
  status          text        NOT NULL DEFAULT 'disconnected',
  session_id      text,
  -- A Discord által megadott cím az ÚJRACSATLAKOZÁSHOZ. Nem ugyanaz, mint a
  -- belépési pont: egy folytatás máshová megy, és ezt a Discord mondja meg.
  resume_url      text,
  -- Az utolsó feldolgozott eseménysorszám. A folytatás ezt küldi vissza, és
  -- a Discord innen pótolja a kimaradt eseményeket.
  sequence        bigint,
  last_ready_at   timestamptz,
  last_event_at   timestamptz,
  last_error      text,
  -- Hányszor kellett újracsatlakozni. Egy folyton szakadó kapcsolat nem
  -- hiba nélküli, csak nem látszik — ezért számoljuk.
  reconnects      bigint      NOT NULL DEFAULT 0,
  -- Milyen intentekkel csatlakoztunk. Ebből derül ki, mire számíthat a
  -- felület: a taglista privilegizált, és ha nincs engedélyezve, az
  -- adathiány nem hiba.
  intents         bigint      NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO discord_gateway_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Üzenetszám csatornánként és naponként. SEMMI MÁS.
CREATE TABLE IF NOT EXISTS discord_message_stats_daily (
  day        date   NOT NULL,
  guild_id   text   NOT NULL,
  channel_id text   NOT NULL,
  messages   bigint NOT NULL DEFAULT 0,
  -- A botok üzenetei külön: a saját értesítéseink különben úgy néznének ki,
  -- mintha a szerver aktív lenne.
  bot_messages bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, guild_id, channel_id)
);

CREATE INDEX IF NOT EXISTS discord_message_stats_day_idx
  ON discord_message_stats_daily (guild_id, day DESC);

-- Taglétszám és mozgás naponként.
CREATE TABLE IF NOT EXISTS discord_member_stats_daily (
  day          date   NOT NULL,
  guild_id     text   NOT NULL,
  -- A NAP UTOLSÓ PILLANATKÉPE. Ez intent nélkül is megvan (a `GUILD_CREATE`
  -- küldi), és ebből a NÖVEKEDÉS látszik.
  member_count int,
  -- Ezekhez privilegizált intent kell. NULL ≠ 0: a null azt jelenti, hogy
  -- nem mérjük, a nulla azt, hogy nem történt.
  joins        int,
  leaves       int,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, guild_id)
);
