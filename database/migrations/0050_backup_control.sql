-- ============================================================================
-- 0050 — a mentés kezelhető legyen a panelről
-- ============================================================================
-- A mentés eddig egy konténerben futó ciklus volt: naponta egyszer, és ennyi.
-- Aki listát akart látni, az `docker compose exec`-elt; aki mentést akart
-- indítani, az megvárta a hajnalt; aki vissza akart állítani, az kézzel írt
-- parancsot a legrosszabb napján.
--
-- A nehézség nem a felület, hanem a hely: a mentőkonténerben van `pg_dump`,
-- `pg_restore` és a kötet; az API-ban egyik sincs. Nem is kellene legyen —
-- egy webalkalmazásnak nem dolga adatbázist ejteni.
--
-- Ezért az adatbázis a parancscsatorna a kettő között:
--
--     panel  →  backup_requests (pending)  →  a ciklus felveszi  →  fut
--            ←  backups (leltár)           ←  a futás beírja     ←
--
-- Két tábla, mert két külön dolog: mi *van* (leltár), és mit *kértünk*
-- (szándék). Az első a mentés után íródik, a második előtte.

-- ---------------------------------------------------------------- a leltár
-- Amit a mentőkonténer lát a köteten. Az API ezt olvassa, mert a kötetet nem
-- látja — és nem is kell látnia.
CREATE TABLE IF NOT EXISTS backups (
  filename      text PRIMARY KEY,
  bytes         bigint      NOT NULL,
  taken_at      timestamptz NOT NULL,
  -- A visszaállítás-ellenőrzés eredménye. Egy mentés, amit senki nem állított
  -- vissza, tipp — ezért a mentőszkript minden futáskor visszatölti egy
  -- ideiglenes adatbázisba, és ide írja, mit talált benne.
  verified      boolean     NOT NULL DEFAULT false,
  verify_detail text,
  seen_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS backups_taken_idx ON backups (taken_at DESC);

-- ---------------------------------------------------------------- a kérések
CREATE TABLE IF NOT EXISTS backup_requests (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- backup  : készíts egy mentést most
  -- verify  : töltsd vissza egy ideiglenes adatbázisba, és mondd meg, mi van benne
  -- restore : töltsd vissza AZ ÉLES adatbázisba
  kind         text NOT NULL CHECK (kind IN ('backup', 'verify', 'restore')),
  filename     text,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'running', 'done', 'failed')),
  -- Kötelező indoklás, mint a vészkapcsolóknál: egy visszaállítás, aminek
  -- nincs története, egy hónap múlva megmagyarázhatatlan.
  reason       text NOT NULL,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  log          text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

-- Egyszerre egy kérés futhat vagy várhat. Nem ellenőrzés-majd-beszúrás:
-- részleges egyedi index, tehát két egyidejű kérés közül a második elhasal,
-- nem mindkettő elindul.
CREATE UNIQUE INDEX IF NOT EXISTS backup_requests_one_active
  ON backup_requests ((true)) WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS backup_requests_recent_idx
  ON backup_requests (created_at DESC);

-- ------------------------------------------------------- a jogosultság maga
-- Külön jogosultság, nem a `security.manage` alá bújtatva: a mentés
-- visszaállítása más döntés, mint egy vészkapcsoló átbillentése, és lehet
-- valaki, akire az egyiket rábízod, a másikat nem.
INSERT INTO permissions (slug, description, "group", status)
VALUES ('backup.manage', 'Mentések indítása, ellenőrzése és visszaállítása', 'system', 'active')
ON CONFLICT (slug) DO UPDATE SET
  description = excluded.description, "group" = excluded."group", status = 'active';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.slug = 'admin' AND p.slug = 'backup.manage'
ON CONFLICT DO NOTHING;
