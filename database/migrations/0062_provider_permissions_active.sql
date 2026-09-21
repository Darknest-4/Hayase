-- A forrásjogosultságok élesítése.
--
-- A `video_source.view` és a `video_source.edit` 0036 óta a katalógusban van,
-- de `planned` állapotban: senki nem érvényesítette őket. A providerréteg
-- adminfelülete az első, ami tényleg rájuk gátol.
--
-- MIÉRT SZÁMÍT AZ ÁLLAPOT. A szerepkör-szerkesztő a `planned` jogosultságokat
-- „még nem működik" jelöléssel mutatja. Ha egy útvonal ilyenre gátol, az
-- üzemeltető odaadja valakinek a jogot, a képernyő azt mondja rá, hogy még
-- nincs hatása — és közben van. A `permission-status` teszt pontosan ezt az
-- eltérést fogja meg, és ez a migráció a válasza rá.

UPDATE permissions
   SET status = 'active'
 WHERE slug IN ('video_source.view', 'video_source.edit')
   AND status <> 'active';
