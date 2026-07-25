-- Batch C review: nalog kojim se avans zatvara na konačnom računu mora biti
-- ZAPAMĆEN, inače storno konačnog računa reverzira samo nalog fakture i ostavlja
-- konto 4300 (primljeni avansi) i PDV po avansu na nuli iako je avans naplaćen.
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "advance_closing_entry_id" INTEGER;

CREATE INDEX IF NOT EXISTS "idx_invoices_advance_closing"
  ON "invoices" ("advance_closing_entry_id");

-- Revizorski trag: koji je kurs (i sa kog DANA) upotrebljen u obračunu kursnih
-- razlika. Resolver uzima poslednji kurs <= preseka, pa bez ovoga nije moguće
-- dokazati da je 31.12. obračunat po kursu 31.12., a ne po nekom starijem.
ALTER TABLE "fx_revaluation_runs"
  ADD COLUMN IF NOT EXISTS "rate_date" TIMESTAMPTZ(6);
