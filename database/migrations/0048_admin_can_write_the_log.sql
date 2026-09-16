-- ============================================================================
-- 0048 — az adminisztrátor is írhatja a fejlesztési naplót
-- ============================================================================
-- A `changelog.manage` a 0036 óta létezik, és egyetlen szerepkörnél ült: az
-- `editor`-nál. Ez elvben védhető — aki a naplót írja, annak nem kell tudnia
-- kitiltani senkit —, a gyakorlatban viszont azt jelentette, hogy a példány
-- tulajdonosa nem tudta megírni a saját fejlesztési naplóját: a felület
-- elrejtette előle, az API 403-at adott.
--
-- Ez volt az egyetlen érvényesített jogosultság, ami hiányzott az `admin`
-- szerepkörből: a többi harmincöt mind ott van.
--
-- A jogosultság továbbra is külön jogosultság. Ez a lényege: oda lehet adni
-- valakinek, aki nem adminisztrátor — az `editor` szerepkör pontosan ezért
-- tartja meg.

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.slug = 'admin' AND p.slug = 'changelog.manage'
ON CONFLICT DO NOTHING;
