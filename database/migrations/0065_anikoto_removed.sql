-- Az Anikoto szolgáltató kivezetése.
--
-- Az adapter kikerült a kódból, tehát a regiszter már nem ismeri ezt a
-- `slug`-ot: a sor innentől ÁRVA. A rendszer nem hasal el rajta — a
-- `registry.ranked()` a regisztrált adapterekből indul, nem a táblából —,
-- de egy árva sor az adminfelületen is zavaró, és később félreérthetővé
-- tenné, hogy melyik szolgáltató miért nincs a listában.
--
-- A SOR TÖRLÉSE, NEM A KIKAPCSOLÁSA. Egy kikapcsolt sor azt állítja, hogy a
-- szolgáltató LÉTEZIK, csak nem használjuk — ez itt nem igaz.
--
-- Nem destruktív: nézői adat nem érintett. A `video_sources` táblában nincs
-- Anikoto-sor, mert ez az adapter sosem írt oda — a forrásait minden
-- kérésnél élőben oldotta fel.

DELETE FROM providers WHERE slug = 'anikoto';

-- A beágyazott lejátszó homokozó-kapcsolója is gazdátlanná vált: az Anikoto
-- volt az egyetlen `embed` fajtájú forrás. A kapcsolót MEGHAGYJUK, de
-- kikapcsoljuk — a gépezet a helyén marad a következő beágyazó
-- szolgáltatóhoz, a jogosultság viszont ne álljon nyitva magától.
UPDATE feature_flags SET enabled = false WHERE key = 'feature.embed_unsandboxed';
