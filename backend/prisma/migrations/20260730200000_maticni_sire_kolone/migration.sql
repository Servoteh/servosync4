-- =============================================================================
-- ŠIRE KOLONE ZA MATIČNE PODATKE (30.07.2026)
-- -----------------------------------------------------------------------------
-- Prvi pravi uvoz iz kopije BigBit baze odbio je 12 komitenata i 2 predmeta sa
-- porukom „value too long for the column's type". Naše kolone su uže od onoga
-- što BigBit stvarno nosi:
--     customers.name     50 -> u izvoru do 52
--     customers.address  50 -> 52
--     customers.email    50 -> 52
--     customers.phone    20 -> 21
--     projects.description 50 -> 51
--
-- Red se pritom NE upisuje polovično nego otpada ceo, uz upozorenje — dakle
-- komitent prosto nedostaje. Zato se kolone šire na 255 (Access `Text` ionako
-- staje u 255), a telefon na 50.
--
-- Napomena o uzroku: izvoz koristi `mdb-export -e` (C-escape), pa se prelom reda
-- u polju pretvara u dva znaka `\n`. Deo prekoračenja otud i dolazi — širenje
-- kolone rešava i taj slučaj bez diranja izvoza.
-- =============================================================================

ALTER TABLE "customers" ALTER COLUMN "name"    TYPE VARCHAR(255);
ALTER TABLE "customers" ALTER COLUMN "address" TYPE VARCHAR(255);
ALTER TABLE "customers" ALTER COLUMN "email"   TYPE VARCHAR(255);
ALTER TABLE "customers" ALTER COLUMN "phone"   TYPE VARCHAR(50);
ALTER TABLE "projects"  ALTER COLUMN "description" TYPE VARCHAR(255);
