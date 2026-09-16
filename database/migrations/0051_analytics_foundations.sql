-- ============================================================================
-- 0051 — a látogatottság alapjai: munkamenetek, összesítők, fiókesemények
-- ============================================================================
-- Ami MÁR VAN, és amit ezért nem írunk újra:
--
--   page_views           particionált, üres — a tábla megvolt, az író hiányzott
--   search_stats         particionált, 14 807 sor — ír és működik
--   performance_metrics  particionált, 19 282 sor — ír és működik
--   security_logs        6 371 sor — ír és működik
--   watch_history        particionált, üres — az író hiányzott
--   devices              üres — az író hiányzott
--   audit_logs           particionált, 2 400 sor — ír és működik
--
-- Ez a migráció tehát nem analitikai rendszert épít a semmiből, hanem befejezi
-- azt, ami félig megvan: hozzáteszi a hiányzó három fogalmat (látogatói
-- munkamenet, napi összesítő, fiókesemény), és nem nyúl ahhoz, ami megy.
--
-- Négy elv, amit a táblák alakja is tükröz:
--
-- 1. NYERS ADATBÓL ÖSSZESÍTŐT. A panel soha nem olvas nyers eseménytáblát.
--    Egy „hány látogató volt 90 napja" kérdés nyersen több millió sor; napi
--    összesítőből 90. A nyers sorok rövid ideig élnek, az összesítők sokáig.
--
-- 2. SZEMÉLYES ADATOT CSAK AMEDDIG KELL. A látogatói kulcs napi sóval képzett
--    hash — ugyanaz a látogató holnap MÁS kulcsot kap. Ez szándékos: a napon
--    belüli egyediséghez elég, a napokon átívelő követéshez nem. Aki
--    „visszatérő látogatót" akar ebből, annak ez kevés lesz, és ez a helyes
--    ár egy anime-katalógusnál.
--
-- 3. NYERS IP-T CSAK BIZTONSÁGI CÉLRA. A látogatottságban nincs IP. A
--    `security_logs`-ban van, mert ott a kérdés más: „ki próbálkozott".
--
-- 4. AZ ESEMÉNYEKET A KISZOLGÁLÓ ÍRJA. Amit a kliens küldhet, azt hamisítani
--    is tudja. Az oldalletöltés az egyetlen, amit csak ő tud — az is
--    ellenőrzött, korlátozott, és a kiszolgáló egészíti ki azzal, amit maga
--    lát (cím, böngésző, ország).

-- ---------------------------------------------------------------- munkamenet
--
-- Egy látogatás, nem egy bejelentkezés. A `sessions` tábla a bejelentkezett
-- munkameneté (frissítő token, eszköz, visszavonás); ez a látogatásé, és
-- névtelen látogatónál is van.
CREATE TABLE IF NOT EXISTS analytics_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- A böngésző kapja, sütiben vagy tárolóban. A kiszolgáló adja ki, nem a
  -- kliens találja ki: egy kliens által választott azonosítóval össze lehetne
  -- mosni két látogatót, vagy fel lehetne fújni a számokat.
  session_key   text NOT NULL UNIQUE,
  -- Napi sóval képzett hash. Az egyediséghez kell, nem a követéshez.
  visitor_key   text NOT NULL,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  page_views    integer NOT NULL DEFAULT 0,
  entry_route   text,
  exit_route    text,
  referrer_host text,
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  -- Kategória, nem ujjlenyomat: „mobile", nem a pontos készülék.
  device_class  text CHECK (device_class IN ('mobile', 'tablet', 'desktop', 'tv', 'bot', 'unknown')),
  browser       text,
  os            text,
  language      text,
  -- Sávok, nem pontos pixelek: a pontos méret azonosít, a sáv tervez.
  screen_class  text CHECK (screen_class IN ('xs', 'sm', 'md', 'lg', 'xl', 'unknown')),
  country       char(2),
  is_bot        boolean NOT NULL DEFAULT false
);

-- „Ki van most itt" — az élő panel egyetlen kérdése, és a leggyakoribb.
CREATE INDEX IF NOT EXISTS analytics_sessions_live_idx ON analytics_sessions (last_seen_at DESC);
-- Napi egyedi látogató: a napon belüli DISTINCT ezen megy.
CREATE INDEX IF NOT EXISTS analytics_sessions_visitor_idx ON analytics_sessions (visitor_key, started_at DESC);
CREATE INDEX IF NOT EXISTS analytics_sessions_user_idx ON analytics_sessions (user_id, started_at DESC) WHERE user_id IS NOT NULL;

-- ------------------------------------------------------------ napi összesítő
--
-- Egy sor naponta. Ebből készül minden tartományos jelentés (ma, tegnap, 7,
-- 30, 90 nap, év, egyedi) — nem a nyers táblákból.
CREATE TABLE IF NOT EXISTS analytics_daily (
  day               date PRIMARY KEY,
  sessions          integer NOT NULL DEFAULT 0,
  visitors          integer NOT NULL DEFAULT 0,
  authed_sessions   integer NOT NULL DEFAULT 0,
  anon_sessions     integer NOT NULL DEFAULT 0,
  new_visitors      integer NOT NULL DEFAULT 0,
  returning_visitors integer NOT NULL DEFAULT 0,
  page_views        integer NOT NULL DEFAULT 0,
  -- Másodperc. Csak az egy oldalnál többet néző munkamenetekből: egyetlen
  -- oldalletöltésnek nincs értelmezhető hossza, és ha nullának vesszük,
  -- lehúzza az átlagot valamivel, ami nem mérés.
  avg_duration_sec  integer NOT NULL DEFAULT 0,
  bounce_sessions   integer NOT NULL DEFAULT 0,
  registrations     integer NOT NULL DEFAULT 0,
  logins            integer NOT NULL DEFAULT 0,
  failed_logins     integer NOT NULL DEFAULT 0,
  searches          integer NOT NULL DEFAULT 0,
  zero_result_searches integer NOT NULL DEFAULT 0,
  episode_starts    integer NOT NULL DEFAULT 0,
  episode_completions integer NOT NULL DEFAULT 0,
  watch_seconds     bigint NOT NULL DEFAULT 0,
  errors            integer NOT NULL DEFAULT 0,
  not_found         integer NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Bontások: eszköz, böngésző, oprendszer, nyelv, hivatkozó, belépő oldal.
-- Külön tábla, nem húsz oszlop: a dimenziók száma nő, az oszlopoké ne.
CREATE TABLE IF NOT EXISTS analytics_breakdown (
  day        date NOT NULL,
  dimension  text NOT NULL CHECK (dimension IN
    ('device', 'browser', 'os', 'language', 'referrer', 'entry_route', 'exit_route', 'country', 'screen')),
  value      text NOT NULL,
  sessions   integer NOT NULL DEFAULT 0,
  page_views integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, dimension, value)
);
CREATE INDEX IF NOT EXISTS analytics_breakdown_dim_idx ON analytics_breakdown (dimension, day DESC, sessions DESC);

-- ------------------------------------------------------- címenkénti összesítő
--
-- „Melyik anime megy jól" — naponta, címenként. Szintén összesítő: a nyers
-- oldalletöltésekből percenként számolva ez a lekérdezés a katalógus méretével
-- nőne, és a panel minden frissítésnél újra kifizetné.
CREATE TABLE IF NOT EXISTS anime_stats_daily (
  day             date NOT NULL,
  anime_id        uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  views           integer NOT NULL DEFAULT 0,
  unique_viewers  integer NOT NULL DEFAULT 0,
  episode_starts  integer NOT NULL DEFAULT 0,
  episode_completions integer NOT NULL DEFAULT 0,
  watch_seconds   bigint NOT NULL DEFAULT 0,
  library_adds    integer NOT NULL DEFAULT 0,
  favorites_added integer NOT NULL DEFAULT 0,
  search_impressions integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, anime_id)
);
-- „A nap legnézettebb címei" — a panel első táblázata.
CREATE INDEX IF NOT EXISTS anime_stats_daily_top_idx ON anime_stats_daily (day DESC, views DESC);
-- „Ez a cím hogy teljesített az elmúlt 90 napban" — a részletnézet.
CREATE INDEX IF NOT EXISTS anime_stats_daily_anime_idx ON anime_stats_daily (anime_id, day DESC);

-- Epizódszintű teljesítmény: hol hagyják abba. Csak azokra a címekre
-- keletkezik sor, amiket tényleg néznek.
CREATE TABLE IF NOT EXISTS episode_stats_daily (
  day         date NOT NULL,
  episode_id  uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  anime_id    uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  starts      integer NOT NULL DEFAULT 0,
  completions integer NOT NULL DEFAULT 0,
  watch_seconds bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, episode_id)
);
CREATE INDEX IF NOT EXISTS episode_stats_daily_anime_idx ON episode_stats_daily (anime_id, day DESC);

-- ------------------------------------------------------------- fiókesemények
--
-- Strukturált, sorszámozott fióktevékenység: „REG_000001", „LOGIN_000182".
--
-- Miért nem a `security_logs`-ba: az biztonsági napló, IP-vel, szigorú
-- hozzáféréssel és rövidebb megőrzéssel. Ez a fiók SAJÁT előzménye — azt a
-- kérdést válaszolja meg, hogy „mi történt ezzel a fiókkal", és ezt a
-- tulajdonosának is meg lehet mutatni. A kettő szándékosan külön él, mert a
-- megőrzésük és a láthatóságuk is külön.
--
-- A sorszám eseménytípusonként fut, és az adatbázis adja: két egyidejű
-- belépés nem kaphat azonos számot, mert a sorozat atomikus.
CREATE SEQUENCE IF NOT EXISTS account_event_seq;

CREATE TABLE IF NOT EXISTS account_events (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  -- Ember által olvasható hivatkozás: LOGIN_000182. Ez kerül a képernyőre és
  -- a bejelentésekbe; az uuid-t senki nem mondja ki hangosan.
  reference   text NOT NULL,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  event       text NOT NULL,
  result      text NOT NULL DEFAULT 'success' CHECK (result IN ('success', 'failed', 'blocked')),
  -- Melyik munkamenetből. Törölt munkamenetnél null marad, az esemény nem.
  session_id  uuid,
  device_id   uuid REFERENCES devices(id) ON DELETE SET NULL,
  -- A kérés azonosítója: a naplóval és a hibajelentéssel ez köti össze.
  request_id  text,
  -- Soha nem tartalmaz jelszót, tokent, sütit vagy titkot. Amit tartalmaz:
  -- melyik mező változott, honnan hova (ahol ez nem személyes adat).
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- „Mi történt ezzel a fiókkal" — a felhasználó részletlapjának a gerince.
CREATE INDEX IF NOT EXISTS account_events_user_idx ON account_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS account_events_event_idx ON account_events (event, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS account_events_reference_idx ON account_events (reference, created_at);

-- A particionálás a karbantartó feladaté, de az első hónapok kellenek ahhoz,
-- hogy a migráció után AZONNAL lehessen írni. Ugyanaz a minta, mint a többi
-- particionált táblánál.
DO $$
DECLARE
  m date := date_trunc('month', now())::date - interval '1 month';
  i int;
BEGIN
  FOR i IN 0..4 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS account_events_%s PARTITION OF account_events FOR VALUES FROM (%L) TO (%L)',
      to_char(m, 'YYYY_MM'), m, (m + interval '1 month')::date);
    m := (m + interval '1 month')::date;
  END LOOP;
END $$;

-- ----------------------------------------------------------- a napi só helye
--
-- A látogatói kulcs sója. Naponta cserélődik, és a tegnapi sót eldobjuk —
-- ettől lesz a kulcs visszafejthetetlen és napokon át összekapcsolhatatlan.
-- Egy oszlop egy soron; nem titok, hanem forgó érték.
CREATE TABLE IF NOT EXISTS analytics_salt (
  day        date PRIMARY KEY,
  salt       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------- jogosultságok
--
-- Az `analytics.view` és az `analytics.export` MÁR LÉTEZIK a katalógusban,
-- „tervezett" állapotban és angol leírással — a 327 tervezett sor közül kettő.
-- Nem írunk mellé újat: aktiváljuk őket, és magyarra tesszük a leírásukat,
-- ahogy a 0047 tette a többivel. Egy második, majdnem azonos nevű jogosultság
-- pontosan az a fajta kettősség, amitől egy jogosultságrendszer
-- kiismerhetetlen lesz.
--
-- Az `analytics.accounts` új: egy FIÓK tevékenységének megtekintése más
-- kérdés, mint a látogatottságé, és lehet valaki, akire az egyiket rábízod, a
-- másikat nem.
INSERT INTO permissions (slug, description, "group", status)
VALUES
  ('analytics.view',     'Látogatottsági és nézési kimutatások megtekintése', 'analytics', 'active'),
  ('analytics.accounts', 'Egy fiók tevékenységének, munkameneteinek és eszközeinek megtekintése', 'analytics', 'active'),
  ('analytics.export',   'Kimutatások exportálása CSV/JSON formátumban', 'analytics', 'active')
ON CONFLICT (slug) DO UPDATE
   SET status = 'active',
       description = EXCLUDED.description,
       "group" = EXCLUDED."group";

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.slug = 'admin' AND p.slug IN ('analytics.view', 'analytics.accounts', 'analytics.export')
ON CONFLICT DO NOTHING;
