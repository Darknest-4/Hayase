-- ============================================================================
-- 0072 — Szolgáltatói késleltetés eloszlása (percentilishez)
-- ============================================================================
-- MIÉRT NEM ELÉG AZ ÁTLAG. A `provider_metrics_daily` ma összeget és
-- maximumot tárol, amiből átlag és csúcs számolható. Ez a kettő együtt is
-- félrevezet: egy szolgáltató, ami száz kérésből kilencvenkilencet 200 ms
-- alatt szolgál ki, egyet pedig tíz másodpercben, ugyanazt az átlagot adja,
-- mint az, amelyik mindet 300 ms körül. Az első JÓ, a második ROSSZ — és a
-- néző az elsőt észre sem veszi, a másodiknál pedig minden epizódnál vár.
--
-- MIÉRT NEM TÁROLUNK MINDEN KÉRÉST. A percentilis pontos kiszámításához az
-- egyedi mérésekre lenne szükség: az napi több százezer sor, ugyanabból a
-- célból, amiért a modul többi része összesít. Az eloszlás viszont
-- VÖDRÖKBEN is eltárolható — szolgáltatónként és naponként legföljebb
-- tizenhárom sor —, és abból a percentilis a vödör felső határának
-- pontosságával megadható.
--
-- EZÉRT A PANEL „≤"-T ÍR. Egy vödrös percentilis nem az az egy mérés, hanem
-- egy felső korlát: „a kérések 95%-a 500 ms alatt volt". Ezt ki is mondjuk a
-- felületen; egy pontosnak látszó `487 ms` itt találgatás lenne.
--
-- A VÖDRÖK HATÁRAI a `bucket_ms` oszlopban a FELSŐ határt jelentik, és a
-- `providers/metrics.ts` `LATENCY_BUCKETS` listájával egyeznek. Az utolsó
-- vödör mindent visz, ami fölötte van — a szolgáltatói kéréseknek van
-- időkorlátjuk, tehát ide a gyakorlatban a kifutott kérések kerülnek.
--
-- A SZÁMLÁLÓK ÖSSZEADÓDNAK, mint a `provider_metrics_daily`-ben, és ugyanaz a
-- puffer írja ki ugyanabban a kötegben. Lásd ott a duplázásról szóló részt.
-- ============================================================================

CREATE TABLE IF NOT EXISTS provider_latency_daily (
  day        date   NOT NULL,
  slug       text   NOT NULL,
  -- A vödör FELSŐ határa ezredmásodpercben. Az utolsó vödör a fölötte
  -- lévőket is tartalmazza.
  bucket_ms  int    NOT NULL,
  count      bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, slug, bucket_ms)
);

-- A panel egy időszakra, szolgáltatónként kérdezi le az eloszlást.
CREATE INDEX IF NOT EXISTS provider_latency_daily_day_idx
  ON provider_latency_daily (day DESC, slug);
