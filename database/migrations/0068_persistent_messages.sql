-- ============================================================================
-- 0068 — Tartós Discord-üzenetek nyilvántartása
-- ============================================================================
-- MI EZ. Egy statisztikaüzenet nem újraküldődik minden frissítéskor, hanem a
-- MÁR ELKÜLDÖTT üzenet módosul. Ehhez tudni kell, melyik üzenet melyik
-- guildhez és melyik célhoz tartozik — ez az a nyilvántartás.
--
-- EZ A TÁBLA EGYSZER MÁR LÉTEZETT, más néven. A 0028-as áttérés dobta el
-- `discord_messages` néven, a Discord-integráció visszavonásakor; a saját
-- szövege szerint „a mapping from a purpose key to a Discord message id".
-- Most ugyanaz a feladat jön vissza, bővebb szerződéssel: hibakezeléssel,
-- zárolással és tartalom-ujjlenyomattal.
--
-- AMI NINCS ITT: üzenetszöveg. A tábla azt tartja nyilván, HOL van az üzenet
-- és MIKOR frissült, nem azt, hogy mi áll benne. A tartalom minden
-- rendereléskor újra előáll az élő adatból; eltárolva csak elavulna.
-- ============================================================================

CREATE TABLE IF NOT EXISTS persistent_messages (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Discord-azonosítók SZÖVEGKÉNT. A Discord „snowflake" azonosítói 64 bites
  -- egészek, és a JavaScript `number` 2^53 fölött pontosságot veszít — egy
  -- `bigint` oszlop a kliens felé úgyis sztringgé válna. Sztringként tároljuk,
  -- hogy sehol ne kelljen visszaalakítani.
  guild_id        text        NOT NULL,
  channel_id      text        NOT NULL,
  -- NULL, amíg az üzenet nem jött létre. A rekord előbb létezik, mint az
  -- üzenet: a beállítást el lehet menteni akkor is, ha a küldés még nem ment.
  message_id      text,

  -- 'server_statistics' | 'yume_statistics' | 'latest_releases' | …
  -- Nincs `CHECK`: egy új üzenettípus bevezetése nem hasalhat el egy
  -- áttérésen.
  message_type    text        NOT NULL,
  configuration   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  enabled         boolean     NOT NULL DEFAULT true,

  -- A LEGUTÓBB KIRENDERELT TARTALOM UJJLENYOMATA.
  --
  -- Ezen múlik, hogy ne küldjünk felesleges módosítást: ha az újragenerált
  -- tartalom ujjlenyomata megegyezik a tárolttal, a Discordot meg sem
  -- szólítjuk. Egy percenként frissülő statisztika napi 1440 kérés helyett
  -- annyi, ahányszor tényleg változott.
  last_rendered_hash text,

  -- Üzemeltetői visszajelzéshez: mikor próbáltuk, mikor sikerült, mi volt a
  -- hiba. A kettő KÜLÖN: egy egy hete sikertelen üzenetnél a
  -- „last_updated_at" frissnek látszana, és elfedné a bajt.
  last_updated_at timestamptz,
  last_success_at timestamptz,
  last_error      text,
  -- Egymás utáni sikertelen kísérletek. Ez fékezi a visszalépést, és ez
  -- állítja le a végtelen újrapróbálkozást.
  failure_count   integer     NOT NULL DEFAULT 0,

  -- ELOSZTOTT ZÁR. Több bot-példány mellett ez akadályozza meg, hogy ketten
  -- egyszerre hozzanak létre üzenetet ugyanahhoz a rekordhoz — abból két
  -- üzenet lenne, és a második örökre árván maradna.
  locked_until    timestamptz,
  locked_by       text,

  version         integer     NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- EGY GUILD + EGY TÍPUS = EGY AKTÍV ÜZENET.
--
-- Ez a duplikációvédelem legbelső rétege: ha két kérés egyszerre próbál
-- ugyanolyan típusú üzenetet felvenni ugyanahhoz a guildhez, a második az
-- adatbázison hasal el, nem a Discord API-n. Részleges index, mert a
-- letiltott rekordokból több is megmaradhat előzményként.
CREATE UNIQUE INDEX IF NOT EXISTS persistent_messages_guild_type_uniq
  ON persistent_messages (guild_id, message_type)
  WHERE enabled;

-- A frissítő feladat „mi esedékes" kérdésére.
CREATE INDEX IF NOT EXISTS persistent_messages_due_idx
  ON persistent_messages (enabled, last_updated_at NULLS FIRST);

-- ============================================================================
-- A frissítések előzménye — a dashboard „utolsó hibák" nézetéhez.
-- ============================================================================
-- KORLÁTOZOTT MEGŐRZÉSSEL. Egy percenként frissülő üzenet naponta 1440 sort
-- írna; a nyesés a megőrzési feladat dolga. Itt csak a tábla van.
CREATE TABLE IF NOT EXISTS persistent_message_events (
  id          bigserial   PRIMARY KEY,
  message_id  uuid        NOT NULL REFERENCES persistent_messages(id) ON DELETE CASCADE,
  -- 'created' | 'edited' | 'skipped' | 'recreated' | 'failed' | 'locked_out'
  event       text        NOT NULL,
  detail      text,
  duration_ms integer,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS persistent_message_events_msg_at_idx
  ON persistent_message_events (message_id, at DESC);
