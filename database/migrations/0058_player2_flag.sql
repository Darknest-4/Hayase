-- A Player 2.0 kapcsolója.
--
-- KIKAPCSOLVA jön létre, és ez a lényege. A `featureOn` úgy van megírva, hogy
-- egy NEM LÉTEZŐ kapcsoló IGAZAT ad vissza:
--
--     if (!flag || !flag.enabled) return !flag
--
-- Ez a többi kapcsolónál helyes — egy új funkció, amiről a kapcsolótábla még
-- nem tud, ne tűnjön el a régi telepítéseken. Egy teljes lejátszócserénél
-- viszont pont fordítva helyes: sor nélkül az ÚJ lejátszó indulna el
-- mindenkinél, az első éles kérésnél, mérés nélkül.
--
-- A sor tehát nem adminisztráció, hanem a biztosíték maga.
--
-- Bekapcsolás: az adminfelület kapcsolótáblájában, vagy
--   UPDATE feature_flags SET enabled = true WHERE key = 'feature.player2';
-- Fokozatos bevezetéshez az `access = 'permission'` és egy jogosultság
-- előbb csak az üzemeltetőnek adja oda.

INSERT INTO feature_flags (key, label, category, enabled, access, required_permission, description, sort)
VALUES (
  'feature.player2',
  'Player 2.0',
  'feature',
  false,
  'public',
  NULL,
  'Az új lejátszó a nézőoldalon. Kikapcsolva a régi lejátszó megy.',
  280
)
ON CONFLICT (key) DO NOTHING;
