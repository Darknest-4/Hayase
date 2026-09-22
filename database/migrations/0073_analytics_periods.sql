-- ============================================================================
-- 0073 — Heti és havi összesítő
-- ============================================================================
-- MIÉRT NEM ELÉG A NAPI SOROK ÖSSZEADÁSA: egy évnyi nézet 365 sor összegzése
-- minden megnyitásnál, miközben ugyanaz 12 sor is lehetne. Ez a tábla a
-- gyorsítás — és egyben az a hely, ahol egy MÉRÉSI KORLÁTOT ki kell mondani.
--
-- A HETI „EGYEDI LÁTOGATÓ" NEM LÉTEZIK EBBEN A RENDSZERBEN, és ez nem
-- hiányosság, hanem döntés. A látogató napi kulcsa NAPI SÓVAL képzett hash
-- (`analytics/visitor.ts`): ugyanaz az ember holnap MÁS kulcsot kap, a
-- tegnapi sót pedig eldobjuk. A napon belüli egyediséghez ez elég, a napokon
-- átívelőhöz nem — és szándékosan nem tesszük azzá.
--
-- Ezért ez a tábla NEM ír „heti egyedi látogatót". Ami helyette van:
--
--   * `visitor_days` — a napi egyedi látogatók ÖSSZEGE. Jól definiált
--     mérőszám („látogatói napok"), és őszinte: aki hétfőn és kedden is itt
--     volt, az ebben kettő. Egy „heti egyedi látogató" címke ugyanerre a
--     számra HAZUGSÁG volna, méghozzá a hízelgő irányba — pont ezért nem
--     veszi észre senki.
--   * `unique_users` — a BEJELENTKEZETT látogatók valódi egyedi száma. A
--     `user_id` állandó, tehát ez az egy szám időszakon át is pontos.
--
-- ÉS EZÉRT VAN `unique_users_exact` OSZLOP. A nyers munkamenetek megőrzési
-- ideje véges (alapból 90 nap). Egy régebbi hónap újraszámolásakor a nyers
-- sorok már nincsenek meg; ilyenkor a mező `false`, és a meglévő értéket nem
-- írjuk felül. A panel ezt kiírja: egy szám, amiről nem tudjuk, hogy pontos-e,
-- rosszabb a hiányzó számnál.
-- ============================================================================

CREATE TABLE IF NOT EXISTS analytics_periods (
  -- 'week' — ISO-hét, hétfővel kezdődik — vagy 'month'.
  period             text        NOT NULL CHECK (period IN ('week', 'month')),
  -- Az időszak ELSŐ napja. Hétnél hétfő, hónapnál elseje.
  period_start       date        NOT NULL,
  sessions           bigint      NOT NULL DEFAULT 0,
  -- A napi egyedi látogatók összege. NEM egyedi látogató; lásd fent.
  visitor_days       bigint      NOT NULL DEFAULT 0,
  -- A bejelentkezett látogatók valódi egyedi száma az időszakban.
  unique_users       bigint      NOT NULL DEFAULT 0,
  unique_users_exact boolean     NOT NULL DEFAULT true,
  page_views         bigint      NOT NULL DEFAULT 0,
  registrations      bigint      NOT NULL DEFAULT 0,
  logins             bigint      NOT NULL DEFAULT 0,
  searches           bigint      NOT NULL DEFAULT 0,
  episode_starts     bigint      NOT NULL DEFAULT 0,
  episode_completions bigint     NOT NULL DEFAULT 0,
  watch_seconds      bigint      NOT NULL DEFAULT 0,
  -- Hány NAPI sor állt rendelkezésre. Egy folyamatban lévő hét nem
  -- hasonlítható egy teljeshez, és enélkül ez nem látszana a panelen.
  days_counted       int         NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (period, period_start)
);

CREATE INDEX IF NOT EXISTS analytics_periods_start_idx
  ON analytics_periods (period, period_start DESC);
