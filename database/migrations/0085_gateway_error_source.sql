-- A Discord-gateway saját hibaforrás a hibanaplóban.
--
-- A gateway külön folyamat (lásd docker-compose.yml, `gateway`), de a
-- kezeletlen hibáit eddig `worker`-ként jelentette — másolás maradéka. A
-- hibanaplóban így a worker hibái közé keveredett, és egy gateway-hibát a
-- workerben kellett volna keresni. A helyes `gateway` forrást viszont ez a
-- megszorítás elutasította volna, és a jelentés csendben elveszett volna (a
-- hibarögzítés a saját hibáját elnyeli).
--
-- A tábla particionált: a szülőn cserélt megszorítás minden partícióra
-- érvényes, a meglévőkre és az ezután létrehozottakra is.

ALTER TABLE error_logs DROP CONSTRAINT IF EXISTS error_logs_source_check;
ALTER TABLE error_logs ADD CONSTRAINT error_logs_source_check
  CHECK (source IN ('api', 'worker', 'gateway', 'web', 'desktop', 'mobile', 'extension'));
