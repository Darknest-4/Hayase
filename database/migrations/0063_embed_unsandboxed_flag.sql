-- A beágyazott lejátszó homokozójának feloldása.
--
-- KIKAPCSOLVA JÖN LÉTRE, és a `featureOn` viselkedése miatt a sor létezése
-- maga a biztosíték: egy NEM LÉTEZŐ kapcsolóra a `featureOn` IGAZAT ad
-- vissza (`if (!flag || !flag.enabled) return !flag`). Sor nélkül tehát a
-- homokozó feloldódna mindenkinél, az első éles kérésnél — pont fordítva,
-- mint kellene. A hívó ezért `flagDeclared()`-et IS néz.
--
-- MIT OLD FEL, ÉS MI AZ ÁRA.
--
-- A YUME a beágyazott idegen lejátszókat homokozott `iframe`-ben futtatja.
-- A `megaplay.buzz` lejátszója viszont MINDEN homokozót elutasít — mérve,
-- valódi Chromiumban, mind a tizenegy token megadásával is:
--
--   „Opss! Sandboxed our player is not allowed. Remove sandbox to use it."
--
-- Homokozó nélkül elindul. Az ár valódi: enélkül a beágyazott lap
-- ELNAVIGÁLHATJA a YUME-ot egy másik címre, és felugró ablakot nyithat a
-- néző fölé. A kamera, a mikrofon és a helyadat így is zárva marad, mert
-- azokat az `allow` attribútum szabályozza, ami homokozó nélkül is érvényes.
--
-- Bekapcsolva tehát az Anikoto beágyazása lejátszható lesz; kikapcsolva a
-- keret betöltődik, de a szolgáltató lejátszója megtagadja a működést. A
-- HLS/DASH/MP4 forrásokat ez a kapcsoló nem érinti.
--
-- Bekapcsolás: az adminfelület kapcsolótáblájában, vagy
--   UPDATE feature_flags SET enabled = true WHERE key = 'feature.embed_unsandboxed';

INSERT INTO feature_flags (key, label, category, enabled, access, required_permission, description, sort)
VALUES (
  'feature.embed_unsandboxed',
  'Beágyazott lejátszó homokozó nélkül',
  'feature',
  false,
  'public',
  NULL,
  'A beágyazott idegen lejátszók homokozó nélkül futnak. Enélkül a megaplay.buzz lejátszója megtagadja a működést; bekapcsolva viszont a beágyazott lap elnavigálhatja az oldalt és ablakot nyithat.',
  281
)
ON CONFLICT (key) DO NOTHING;
