-- A Discord-kapcsolat egészsége időben — a vezérlőpult Bot állapota nézetéhez.
--
-- Eddig a gateway-ről annyi látszott, hogy fut-e, és hányszor csatlakozott
-- újra ÖSSZESEN, a kezdetek óta. Ebből nem derül ki, hogy a szakadások
-- ma sűrűsödnek-e, és az sem, hogy a Discord felé milyen lassú a kapcsolat.
--
-- 1. A SZÍVVERÉS KÖRÚTIDEJE (heartbeat_rtt_ms): a szívverés elküldésétől a
--    nyugtáig eltelt idő — a Discord felé mért késleltetés, a legutóbbi érték.
--
-- 2. NAPONTA: hány szakadás volt, ebből hány folytatódott (RESUMED — nem
--    veszett el esemény), és hány új munkamenet indult (READY — ami a
--    szakadás alatt történt, elveszett), meg a körútidő átlaga és csúcsa.
--    Egy sor naponta: megőrzési idő nem kell (tíz év alatt 3650 sor).
--
-- A napot a gateway adja (UTC), ugyanúgy, mint az üzenetstatisztikánál.

ALTER TABLE discord_gateway_state ADD COLUMN IF NOT EXISTS heartbeat_rtt_ms integer;

CREATE TABLE IF NOT EXISTS discord_gateway_daily (
  day         date    PRIMARY KEY,
  reconnects  integer NOT NULL DEFAULT 0,
  resumed     integer NOT NULL DEFAULT 0,
  identified  integer NOT NULL DEFAULT 0,
  rtt_sum_ms  bigint  NOT NULL DEFAULT 0,
  rtt_count   integer NOT NULL DEFAULT 0,
  rtt_max_ms  integer
);
