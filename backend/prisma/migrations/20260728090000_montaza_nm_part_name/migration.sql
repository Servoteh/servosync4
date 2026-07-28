-- Naziv dela u prijavi neusaglašenosti na montaži (zahtev 034/26).
-- Skeniranje kartice koja prati deo (RNZ nalepnica) popunjava br. crteža, RN i NAZIV
-- dela; naziv do sada nije imao kolonu pa se gubio. Aditivno, nullable — postojeći
-- redovi ostaju netaknuti, stariji klijenti nastavljaju da rade bez ovog polja.
-- Širina 250 = paritet `work_orders.part_name` (izvor iz kog se naziv prepisuje).
-- Ručno pisana migracija (obrazac postojećih SQL fajlova): dev Postgres nedostupan u
-- okruženju agenta; primeniće se `migrate:dev`/`migrate:prod`.

ALTER TABLE "montage_nonconformities"
    ADD COLUMN IF NOT EXISTS "part_name" VARCHAR(250);

COMMENT ON COLUMN "montage_nonconformities"."part_name" IS
    'Naziv dela (zahtev 034/26) — popunjava skeniranje kartice (work_orders.part_name) ili ručni unos.';
