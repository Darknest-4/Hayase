-- ============================================================================
-- 0053 — YUME Edge: IP-intelligencia, tiltások, kockázati események
-- ============================================================================
-- AMI MÁR MEGVAN, ÉS AMIT EZÉRT NEM ÍRUNK ÚJRA:
--
--   security_logs   6 371 sor, tíz eseménytípus, IP-vel — a hitelesítés
--                   eseményei már ide írnak. NEM készítünk mellé második
--                   eseménytáblát: két napló két igazság, és a „mi történt
--                   ezzel az IP-vel" kérdésre utána egyik sem válaszol
--                   teljesen. Kiegészítjük a hiányzó oszlopokkal és egy
--                   indexszel, amit a „top támadó IP-k" kérdés használ.
--   users.status    fiókszintű tiltás (active/suspended/banned) +
--                   token_version visszavonás. Marad, ahogy van; az Edge
--                   tiltásai a fiók MELLETT élnek, nem helyette.
--   site_settings   futásidőben állítható beállítások, gyorsítótárazott
--                   olvasóval. Az Edge szabályai is ide kerülnek, nem új
--                   konfigurációs táblába.
--
-- AMI ÚJ:
--   ip_intel        amit egy címről tudunk (ASN, szolgáltató, ország,
--                   hosting/VPN/Tor jelzők, hírnév) — provider-független
--                   alakban, hogy az adatforrás cserélhető legyen.
--   edge_bans       központi tiltás: IP, hálózat (CIDR), fiók, munkamenet,
--                   API-kulcs; ideiglenes vagy végleges, indoklással.
--   edge_decisions  mit döntött az él, és MIÉRT — a jelek pontszámaival.
--                   Ez a nyers eseménytábla; particionált és rövid életű.
--   edge_daily      napi összesítő, ami megmarad, amikor a nyers sorok
--                   elmennek.

-- ------------------------------------------------------- IP-intelligencia
--
-- Egy sor címenként. A `source` és a `checked_at` azért van benne, mert az
-- adat elavul: egy ma lakossági cím holnap lehet egy VPN kilépőpontja, és
-- egy szolgáltató-váltás után a régi megállapítás rosszabb, mint a semmi.
--
-- Szándékosan NINCS benne se pontszám-küszöb, se döntés: ez adat, nem
-- ítélet. Az ítéletet a risk engine hozza, a beállításokból.
CREATE TABLE IF NOT EXISTS ip_intel (
  ip            inet PRIMARY KEY,
  asn           integer,
  provider      text,
  country       char(2),
  -- 'residential' | 'hosting' | 'mobile' | 'business' | 'education' | 'unknown'
  network_type  text NOT NULL DEFAULT 'unknown',
  is_hosting    boolean NOT NULL DEFAULT false,
  is_vpn        boolean NOT NULL DEFAULT false,
  is_proxy      boolean NOT NULL DEFAULT false,
  is_tor        boolean NOT NULL DEFAULT false,
  -- 0 = ismeretlen/semleges, 100 = biztosan rosszindulatú. A providerek
  -- skálái eltérnek; a leképezés az adapter dolga, nem a tábláé.
  reputation    smallint NOT NULL DEFAULT 0 CHECK (reputation BETWEEN 0 AND 100),
  -- Mennyire hisszük el. Egy 0.3-as bizonyosságú „VPN" nem ugyanaz, mint egy
  -- 0.95-ös, és a kockázati pontszám ezt súlyozza is.
  confidence    numeric(3,2) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  source        text NOT NULL DEFAULT 'local',
  checked_at    timestamptz NOT NULL DEFAULT now(),
  -- A providertől kapott nyers válasz, amennyi belefér. Azért tartjuk meg,
  -- mert egy rossz besorolás utólag csak így vizsgálható ki.
  raw           jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- „Mit kell újra megkérdezni" — a frissítő feladat egyetlen lekérdezése.
CREATE INDEX IF NOT EXISTS ip_intel_stale_idx ON ip_intel (checked_at);
-- „Melyik hálózatból jön a baj" — a panel kérdése.
CREATE INDEX IF NOT EXISTS ip_intel_asn_idx ON ip_intel (asn) WHERE asn IS NOT NULL;

-- ---------------------------------------------------------------- tiltások
--
-- Egy tábla mindenféle tiltásnak. Nem öt tábla: a kérdés mindig ugyanaz — „ez
-- a kérés tiltott-e?" —, és öt táblából öt lekérdezés lenne a forró úton.
--
-- A `subject` alakja a `kind`-től függ, és a CHECK ezt ki is kényszeríti:
--   ip       '203.0.113.9'
--   network  '203.0.113.0/24'
--   user     uuid
--   session  uuid
--   api_key  a kulcs azonosítója (SOHA nem a kulcs maga)
CREATE TABLE IF NOT EXISTS edge_bans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('ip', 'network', 'user', 'session', 'api_key')),
  subject       text NOT NULL,
  -- inet alakban is, ha értelmezhető: így a `>>=` operátorral egyetlen
  -- lekérdezés fedi az IP-t és a hálózatot is.
  subject_inet  inet,
  reason        text NOT NULL,
  -- 'manual' | 'risk' | 'waf' | 'rate_limit' | 'bot' | 'abuse'
  source        text NOT NULL DEFAULT 'manual',
  -- Ami a tiltást kiváltotta, ha automatikus volt.
  risk_score    smallint,
  automatic     boolean NOT NULL DEFAULT false,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- NULL = végleges. Egy ideiglenes tiltás magától lejár; nem kell feloldani.
  expires_at    timestamptz,
  -- Feloldás: a sor marad, hogy az előzmény meglegyen.
  lifted_at     timestamptz,
  lifted_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  lift_reason   text,
  notes         jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- A forró út egyetlen kérdése: él-e tiltás erre a címre vagy hálózatra?
-- Részleges index: a lejárt és feloldott sorok nem érdekesek, és egy év múlva
-- azokból lesz a legtöbb.
CREATE INDEX IF NOT EXISTS edge_bans_live_inet_idx
  ON edge_bans USING gist (subject_inet inet_ops)
  WHERE lifted_at IS NULL AND subject_inet IS NOT NULL;
CREATE INDEX IF NOT EXISTS edge_bans_live_subject_idx
  ON edge_bans (kind, subject)
  WHERE lifted_at IS NULL;
-- „Mi jár le hamarosan" és a takarítás.
CREATE INDEX IF NOT EXISTS edge_bans_expiry_idx ON edge_bans (expires_at) WHERE lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS edge_bans_recent_idx ON edge_bans (created_at DESC);

-- --------------------------------------------------------------- döntések
--
-- Minden nem-ALLOW döntés egy sor: mit látott az él, mennyi pontot adott
-- melyik jel, és mi lett belőle. Ez a nyers tábla — particionált, mert
-- egy támadás alatt percenként több ezer sor keletkezhet, és rövid életű,
-- mert a hosszú távú kérdésekre a napi összesítő válaszol.
CREATE TABLE IF NOT EXISTS edge_decisions (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  at          timestamptz NOT NULL DEFAULT now(),
  ip          inet,
  user_id     uuid,
  -- Az ÚTVONALMINTA, nem a URL: `/v1/anime/:id`, nem `/v1/anime/<uuid>`.
  route       text,
  method      text,
  -- 'allow' | 'monitor' | 'challenge' | 'throttle' | 'block'
  action      text NOT NULL,
  score       smallint NOT NULL DEFAULT 0,
  -- Melyik jel mennyit adott. Ebből lehet utólag megmondani, MIÉRT lett
  -- valaki blokkolva — egy puszta pontszám erre nem elég.
  signals     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- A WAF-szabály azonosítója, ha az döntött.
  rule        text,
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);

CREATE INDEX IF NOT EXISTS edge_decisions_ip_idx ON edge_decisions (ip, at DESC);
CREATE INDEX IF NOT EXISTS edge_decisions_action_idx ON edge_decisions (action, at DESC);
CREATE INDEX IF NOT EXISTS edge_decisions_route_idx ON edge_decisions (route, at DESC);

-- Az első partíciók, hogy a migráció után AZONNAL lehessen írni. A többit a
-- karbantartó feladat hozza létre, ahogy a többi particionált tábláét.
DO $$
DECLARE
  m date := date_trunc('month', now())::date - interval '1 month';
  i int;
BEGIN
  FOR i IN 0..4 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS edge_decisions_%s PARTITION OF edge_decisions FOR VALUES FROM (%L) TO (%L)',
      to_char(m, 'YYYY_MM'), m, (m + interval '1 month')::date);
    m := (m + interval '1 month')::date;
  END LOOP;
END $$;

-- ------------------------------------------------------------- összesítő
--
-- A panel ebből olvas, nem a nyers táblából. Ugyanaz az elv, mint a
-- látogatottságnál: egy „mi volt 90 napja" kérdés nyersen több millió sor.
CREATE TABLE IF NOT EXISTS edge_daily (
  day           date NOT NULL,
  action        text NOT NULL,
  route         text NOT NULL DEFAULT '',
  hits          integer NOT NULL DEFAULT 0,
  unique_ips    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, action, route)
);
CREATE INDEX IF NOT EXISTS edge_daily_day_idx ON edge_daily (day DESC, hits DESC);

-- --------------------------------------------------- security_logs bővítés
--
-- A meglévő tábla marad; két oszlopot kap, amit eddig nem tudott tárolni, és
-- egy indexet a „melyik címről jön a legtöbb baj" kérdéshez. Az `event`
-- szövegmező marad: az Edge saját eseményei ugyanide írnak
-- (`waf_block`, `rate_limited`, `bot_detected`, `ban_created`, …), és így a
-- fiók előzménye és a támadás előzménye ugyanabban a naplóban van.
ALTER TABLE security_logs ADD COLUMN IF NOT EXISTS route text;
ALTER TABLE security_logs ADD COLUMN IF NOT EXISTS severity text
  NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical'));

CREATE INDEX IF NOT EXISTS security_logs_ip_idx ON security_logs (ip, created_at DESC) WHERE ip IS NOT NULL;
CREATE INDEX IF NOT EXISTS security_logs_severity_idx ON security_logs (severity, created_at DESC)
  WHERE severity IN ('high', 'critical');

-- ---------------------------------------------------------- jogosultságok
--
-- Az `security.manage` MÁR LÉTEZIK, és a vészkapcsolókat védi. Az Edge
-- olvasása és a tiltások kezelése két külön dolog: egy moderátornak meg
-- lehet mutatni, mi támad, anélkül hogy hálózatokat tilthatna ki.
INSERT INTO permissions (slug, description, "group", status)
VALUES
  ('edge.view', 'Az él biztonsági eseményeinek és statisztikáinak megtekintése', 'system', 'active'),
  ('edge.ban',  'Tiltások létrehozása és feloldása (IP, hálózat, fiók, munkamenet)', 'system', 'active'),
  ('edge.rules','Az él szabályainak és küszöbeinek módosítása', 'system', 'active')
ON CONFLICT (slug) DO UPDATE
   SET status = 'active', description = EXCLUDED.description, "group" = EXCLUDED."group";

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.slug = 'admin' AND p.slug IN ('edge.view', 'edge.ban', 'edge.rules')
ON CONFLICT DO NOTHING;
