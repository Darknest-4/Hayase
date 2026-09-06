-- Themes the operator owns.
--
-- The client has had a theme engine since the beginning — a base (dark or
-- light) plus an accent colour, with the hover and soft variants derived from
-- it by color-mix. What it did not have was anywhere for a theme to come from
-- except a hard-coded list and an installed extension, which meant an operator
-- could not put their own palette in front of their own viewers without
-- shipping a package to a store.
--
-- A theme is pure data, so this is a table rather than a plug-in: a base, an
-- accent, a name, and an optional set of extra token overrides for the cases
-- one colour cannot express.

CREATE TABLE IF NOT EXISTS themes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  base        text NOT NULL CHECK (base IN ('dark', 'light')),
  -- A CSS colour. Validated in the API before it is ever written, because the
  -- value ends up inside a custom property in a <style> element: the
  -- difference between a colour and a stylesheet is one closing brace.
  accent      text,
  -- Tint the raised surfaces toward the accent.
  tint        boolean NOT NULL DEFAULT false,
  -- Further custom properties, for what one accent cannot say. Same
  -- validation as `accent` applies to every value.
  tokens      jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled     boolean NOT NULL DEFAULT true,
  -- What a viewer who has never chosen gets. Exactly one row may hold it.
  is_default  boolean NOT NULL DEFAULT false,
  sort        smallint NOT NULL DEFAULT 0,
  -- Built-in themes ship with the deployment and may not be deleted; an
  -- operator's own may. Kept as a column rather than inferred from the slug so
  -- the rule is enforceable in one place.
  built_in    boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS themes_one_default ON themes ((true)) WHERE is_default;
CREATE INDEX IF NOT EXISTS themes_listing ON themes (sort, name) WHERE enabled;

COMMENT ON TABLE themes IS
  'Colour themes offered to viewers. A theme is data — a base, an accent, and optional token overrides.';
COMMENT ON COLUMN themes.accent IS
  'A CSS colour, validated before it is written: the value is interpolated into a custom property.';

-- The twelve that shipped as the "Yume Theme Pack" extension, plus the two
-- the interface was designed around. Seeded rather than left to the operator
-- so that removing the extension takes nothing away from anyone.
INSERT INTO themes (slug, name, base, accent, sort, built_in, is_default) VALUES
  ('default',  'Yume',      'dark',  NULL,                  0,  true, true),
  ('daylight', 'Daylight',  'light', NULL,                  1,  true, false),
  ('forest',   'Forest',    'dark',  'hsl(146 55% 45%)',   10,  true, false),
  ('midnight', 'Midnight',  'dark',  'hsl(222 85% 62%)',   11,  true, false),
  ('crimson',  'Crimson',   'dark',  'hsl(352 72% 52%)',   12,  true, false),
  ('teal',     'Teal',      'dark',  'hsl(180 68% 44%)',   13,  true, false),
  ('magenta',  'Magenta',   'dark',  'hsl(310 75% 58%)',   14,  true, false),
  ('slate',    'Slate',     'dark',  'hsl(210 16% 62%)',   15,  true, false),
  ('apricot',  'Apricot',   'dark',  'hsl(28 88% 60%)',    16,  true, false),
  ('iris',     'Iris',      'dark',  'hsl(248 72% 68%)',   17,  true, false),
  ('paper',    'Paper',     'light', 'hsl(222 70% 45%)',   20,  true, false),
  ('moss',     'Moss',      'light', 'hsl(146 52% 32%)',   21,  true, false),
  ('plum',     'Plum',      'light', 'hsl(300 55% 40%)',   22,  true, false),
  ('clay',     'Clay',      'light', 'hsl(18 62% 44%)',    23,  true, false),
  -- And the nine the settings screen had hard-coded in the client. Same
  -- reason: one list, in one place, that an operator can reorder, rename or
  -- take away. A palette split between a table and a JavaScript constant is
  -- two lists that disagree the first time somebody edits one of them.
  ('rose',     'Rose',      'dark',  'hsl(346.6 79% 51%)',  2,  true, false),
  ('ocean',    'Ocean',     'dark',  'hsl(200 90% 55%)',    3,  true, false),
  ('aurora',   'Aurora',    'dark',  'hsl(160 70% 48%)',    4,  true, false),
  ('grape',    'Grape',     'dark',  'hsl(265 80% 66%)',    5,  true, false),
  ('ember',    'Ember',     'dark',  'hsl(18 90% 56%)',     6,  true, false),
  ('gold',     'Gold',      'dark',  'hsl(42 90% 55%)',     7,  true, false),
  ('mono',     'Mono',      'dark',  'hsl(0 0% 82%)',       8,  true, false),
  ('sakura',   'Sakura',    'light', 'hsl(340 82% 62%)',   24,  true, false),
  ('dawn',     'Dawn',      'light', 'hsl(215 90% 55%)',   25,  true, false)
ON CONFLICT (slug) DO NOTHING;

-- `theme.publish` has been in the permission catalogue since it was written
-- and nothing enforced it — the type existed in the extension manifest and no
-- route ever asked for the permission. The theme editor does, so the Roles
-- screen should stop calling it planned.
UPDATE permissions SET status = 'active' WHERE slug = 'theme.publish';

-- The theme pack extension is superseded by the table above. It is marked
-- deprecated rather than deleted: somebody has it installed, the row carries
-- their install and its options, and removing it would take those with it. A
-- deprecated extension stays installed and stops being offered.
UPDATE extensions SET status = 'deprecated' WHERE slug = 'yume-themes' AND status = 'published';
