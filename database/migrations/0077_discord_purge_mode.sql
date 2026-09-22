-- ============================================================================
-- 0077 — Az idegen objektumok takarítása mint külön futási mód
-- ============================================================================
-- MIÉRT KÜLÖN MÓD, ÉS MIÉRT NEM A `factory_reset` EGYIK VÁLTOZATA. A
-- `factory_reset` a SAJÁT objektumainkat takarítja; ez ennek az ellentéte:
-- mindent töröl, ami NINCS a registryben. A kettőt egyetlen kapcsolóval
-- megkülönböztetni hiba volna — egy elgépelt paraméter idegen tartalmat
-- vinne el.
--
-- A `CHECK` kényszer ezért bővül, nem lazul: a mód továbbra is zárt lista.
-- ============================================================================

ALTER TABLE discord_setup_runs DROP CONSTRAINT IF EXISTS discord_setup_runs_mode_check;

ALTER TABLE discord_setup_runs
  ADD CONSTRAINT discord_setup_runs_mode_check
  CHECK (mode IN ('preview', 'setup', 'repair', 'safe_reset', 'factory_reset', 'purge_foreign'));
